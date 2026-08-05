import { ok, strictEqual } from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { closeServer, readRequestBody } from "../harness/openai-compat-fixture.js";
import { makeScratchHome, runCli } from "../harness/spawn.js";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "index.js");
// Rides the spawned bash -c command line so the poll below can find the tool's
// process without matching this test's own argv (the marker never appears in a
// node/tsx command line, only in the fixture-issued shell command). The `;`
// compound keeps bash resident: a single simple command would be
// exec-optimized into a bare `sleep`, dropping the marker from the cmdline.
const CHILD_MARKER = "clio_sigint_regression_marker";
const TOOL_COMMAND = `sleep 300; echo ${CHILD_MARKER}`;

function pgrepMarker(): string[] {
	try {
		return execFileSync("pgrep", ["-f", CHILD_MARKER], { encoding: "utf8" })
			.trim()
			.split("\n")
			.filter((line) => line.length > 0);
	} catch {
		return [];
	}
}

function killMarkerProcesses(): void {
	for (const pid of pgrepMarker()) {
		try {
			process.kill(-Number.parseInt(pid, 10), "SIGKILL");
		} catch {
			try {
				process.kill(Number.parseInt(pid, 10), "SIGKILL");
			} catch {
				// already gone
			}
		}
	}
}

/**
 * Mock OpenAI-compat server whose first main-turn reply is a bash tool call
 * running a long sleep; every later call answers plain text. Model-probe
 * requests (no tool schema in the request) get plain text so only the real
 * turn triggers the tool.
 */
async function startToolCallFixture(): Promise<{ server: Server; url: string }> {
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		if (req.method === "GET" && req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
			return;
		}
		if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		const request = JSON.parse(await readRequestBody(req)) as {
			stream?: boolean;
			tools?: unknown[];
			messages?: Array<{ role?: string }>;
		};
		const hasBashTool = Array.isArray(request.tools) && request.tools.length > 0;
		const sawToolResult = (request.messages ?? []).some((message) => message.role === "tool");
		const emitToolCall = hasBashTool && !sawToolResult;
		const base = { id: "chatcmpl-sigint", object: "chat.completion.chunk", created: 1, model: "mock-model" };
		if (request.stream === false) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					...base,
					object: "chat.completion",
					choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
				}),
			);
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (emitToolCall) {
			res.write(
				`data: ${JSON.stringify({
					...base,
					choices: [
						{
							index: 0,
							delta: {
								role: "assistant",
								tool_calls: [
									{
										index: 0,
										id: "call_sigint_1",
										type: "function",
										function: { name: "bash", arguments: JSON.stringify({ command: TOOL_COMMAND }) },
									},
								],
							},
							finish_reason: null,
						},
					],
				})}\n\n`,
			);
			res.write(
				`data: ${JSON.stringify({
					...base,
					choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
					usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
				})}\n\n`,
			);
		} else {
			res.write(
				`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: "finished" } }] })}\n\n`,
			);
			res.write(
				`data: ${JSON.stringify({
					...base,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
				})}\n\n`,
			);
		}
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address() as AddressInfo;
	return { server, url: `http://127.0.0.1:${addr.port}` };
}

/** Seed a tools-capable OpenAI-compat orchestrator target at `url`. */
function seedToolCapableOrchestrator(configDir: string, url: string): void {
	const p = join(configDir, "settings.yaml");
	const yaml = readFileSync(p, "utf8");
	const patched = yaml
		.replace(
			/^targets:.*$/m,
			[
				"targets:",
				"  - id: mock-chat",
				"    runtime: openai-compat",
				`    url: ${url}`,
				"    defaultModel: mock-model",
				"    auth:",
				"      apiKeyEnvVar: CLIO_TEST_OPENAI_KEY",
				"    capabilities:",
				"      chat: true",
				"      tools: true",
				"      toolCallFormat: openai",
				"      contextWindow: 32768",
				"      maxTokens: 4096",
				"    wireModels:",
				"      - mock-model",
			].join("\n"),
		)
		.replace(/^ {2}target: null$/m, "  target: mock-chat")
		.replace(/^ {2}model: null$/m, "  model: mock-model");
	writeFileSync(p, patched, "utf8");
}

async function waitFor(predicate: () => boolean, timeoutMs: number, stepMs = 200): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
	return predicate();
}

describe("smoke/SIGINT kills running tool children", { concurrency: false, skip: process.platform === "win32" }, () => {
	let scratch: ReturnType<typeof makeScratchHome>;
	let fixture: { server: Server; url: string } | null = null;

	beforeEach(() => {
		scratch = makeScratchHome("clio-sigint-tool-");
	});

	afterEach(async () => {
		killMarkerProcesses();
		await closeServer(fixture?.server ?? null);
		fixture = null;
		scratch.cleanup();
	});

	it("a headless SIGINT during a running bash tool leaves no orphaned process group", async () => {
		const bootstrap = await runCli(["doctor", "--fix"], { env: scratch.env });
		strictEqual(bootstrap.code, 0, `stderr=${bootstrap.stderr}`);
		fixture = await startToolCallFixture();
		seedToolCapableOrchestrator(join(scratch.dir, "config"), fixture.url);
		const workRepo = join(scratch.dir, "work-repo");
		mkdirSync(workRepo, { recursive: true });

		const child = spawn(
			process.execPath,
			[CLI_ENTRY, "--no-context-files", "--no-skills", "run", "--autonomy", "full-auto", "run the shell command"],
			{
				cwd: workRepo,
				env: { ...process.env, ...scratch.env, CLIO_TEST_OPENAI_KEY: "sk-test" },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));

		const toolStarted = await waitFor(() => pgrepMarker().length > 0, 30_000);
		ok(toolStarted, `bash tool child never appeared; stderr=${stderr}`);

		child.kill("SIGINT");
		const code = await exited;
		strictEqual(code, 130, `expected coordinated SIGINT exit; stderr=${stderr}`);

		// The tool's detached process group must not survive the CLI: the drain
		// hook disposes the chat loop, the agent abort reaches the tool's
		// AbortSignal, and bash-exec signals the group.
		const cleaned = await waitFor(() => pgrepMarker().length === 0, 5_000);
		ok(cleaned, `tool child survived SIGINT: pids=${pgrepMarker().join(",")}; stderr=${stderr}`);
	});
});
