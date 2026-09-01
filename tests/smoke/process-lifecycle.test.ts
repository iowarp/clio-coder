import { ok, strictEqual } from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = new URL("../..", import.meta.url).pathname;
const CLI = join(ROOT, "dist", "cli", "index.js");

function environment(root: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		NODE_ENV: "test",
		NO_COLOR: "1",
		CLIO_CODER_HOME: root,
		CLIO_CODER_CONFIG_DIR: join(root, "config"),
		CLIO_CODER_DATA_DIR: join(root, "data"),
		CLIO_CODER_STATE_DIR: join(root, "state"),
		CLIO_CODER_CACHE_DIR: join(root, "cache"),
		CLIO_CODER_REQUIRE_HOME_PREFIX: "1",
		CLIO_CODER_RESIDENCY: "observe",
	};
}

function seedTarget(root: string, url: string): void {
	const path = join(root, "config", "settings.yaml");
	const settings = readFileSync(path, "utf8")
		.replace(
			/^targets: \[\]$/m,
			[
				"targets:",
				"  - id: lifecycle-local",
				"    runtime: openai-compat",
				`    url: ${url}`,
				"    defaultModel: mock-model",
				"    wireModels: [mock-model]",
				"    capabilities:",
				"      chat: true",
				"      tools: true",
				"      toolCallFormat: openai",
				"      contextWindow: 32768",
				"      maxTokens: 4096",
			].join("\n"),
		)
		.replace(/^ {2}target: null$/m, "  target: lifecycle-local")
		.replace(/^ {2}model: null$/m, "  model: mock-model")
		.replace(/^ {2}autonomy: auto-edit$/m, "  autonomy: full-auto");
	writeFileSync(path, settings);
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	let body = "";
	request.setEncoding("utf8");
	for await (const chunk of request) body += chunk;
	return JSON.parse(body) as Record<string, unknown>;
}

async function provider(command: string): Promise<{ server: Server; url: string }> {
	const server = createServer(async (request, response) => {
		if (request.method === "GET" && request.url === "/v1/models") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: "mock-model", tools: true }] }));
			return;
		}
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.statusCode = 404;
			response.end();
			return;
		}
		const payload = await requestBody(request);
		if (payload.stream === false) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "probe" } }] }));
			return;
		}
		const messages = payload.messages as Array<{ role?: string }>;
		const callTool = !messages.some((message) => message.role === "tool");
		const delta = callTool
			? {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: "call-lifecycle",
							type: "function",
							function: { name: "bash", arguments: JSON.stringify({ command }) },
						},
					],
				}
			: { role: "assistant", content: "finished" };
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
		response.write(
			`data: ${JSON.stringify({
				choices: [{ index: 0, delta: {}, finish_reason: callTool ? "tool_calls" : "stop" }],
				usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
			})}\n\n`,
		);
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
	return predicate();
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

describe("smoke/process lifecycle", { concurrency: false, skip: process.platform === "win32" }, () => {
	it("coordinates SIGINT through the real tool child and leaves no orphan", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-process-lifecycle-"));
		const env = environment(root);
		const project = join(root, "project");
		const pidFile = join(project, ".tool-child.pid");
		const stoppedFile = join(project, ".tool-child.stopped");
		const command =
			"trap 'printf stopped > .tool-child.stopped; exit 0' TERM INT HUP; " +
			"printf '%s' \"$$\" > .tool-child.pid; while :; do sleep 1; done";
		const fixture = await provider(command);
		let child: ReturnType<typeof spawn> | undefined;
		let toolPid = 0;
		try {
			mkdirSync(project);
			execFileSync(process.execPath, [CLI, "doctor", "--fix"], { cwd: ROOT, env, stdio: "pipe" });
			seedTarget(root, fixture.url);
			child = spawn(
				process.execPath,
				[CLI, "--no-context-files", "--no-skills", "run", "--autonomy", "full-auto", "start child"],
				{ cwd: project, env, stdio: ["ignore", "pipe", "pipe"] },
			);
			let stderr = "";
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (text: string) => {
				stderr += text;
			});
			const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
				child?.once("close", (code, signal) => resolve({ code, signal })),
			);
			ok(await waitFor(() => existsSync(pidFile), 20_000), `tool child did not start; stderr=${stderr}`);
			toolPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
			ok(Number.isSafeInteger(toolPid) && toolPid > 1 && processExists(toolPid));

			child.kill("SIGINT");
			const result = await exit;
			strictEqual(result.code, 130, `signal=${result.signal ?? "none"}; stderr=${stderr}`);
			ok(await waitFor(() => existsSync(stoppedFile), 5_000), "tool child did not observe coordinated termination");
			ok(await waitFor(() => !processExists(toolPid), 5_000), `orphaned tool pid ${toolPid}`);

			const receiptDir = join(root, "state", "receipts");
			const receipts = readdirSync(receiptDir).filter((name) => name.endsWith(".json"));
			strictEqual(receipts.length, 1);
			const receipt = JSON.parse(readFileSync(join(receiptDir, receipts[0] ?? ""), "utf8")) as {
				outcome: string;
				exitCode: number;
				sessionId: string | null;
			};
			strictEqual(receipt.outcome, "canceled");
			strictEqual(receipt.exitCode, 130);
			ok(receipt.sessionId);
		} finally {
			if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			if (toolPid > 1 && processExists(toolPid)) process.kill(toolPid, "SIGKILL");
			fixture.server.closeAllConnections();
			await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
			rmSync(root, { recursive: true, force: true });
		}
	});
});
