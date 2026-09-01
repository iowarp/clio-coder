import { match, ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const ROOT = new URL("../..", import.meta.url).pathname;
const CLI = join(ROOT, "dist", "cli", "index.js");
const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

interface Home {
	root: string;
	env: NodeJS.ProcessEnv;
	cleanup(): void;
}

interface Result {
	code: number | null;
	stdout: string;
	stderr: string;
}

function home(label = "clio-cli-core-"): Home {
	const root = mkdtempSync(join(tmpdir(), label));
	return {
		root,
		env: {
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
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

async function runCli(
	args: string[],
	options: { env: NodeJS.ProcessEnv; cwd?: string; input?: string; timeoutMs?: number },
): Promise<Result> {
	const child = spawn(process.execPath, [CLI, ...args], {
		cwd: options.cwd ?? ROOT,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (text: string) => {
		stdout += text;
	});
	child.stderr.on("data", (text: string) => {
		stderr += text;
	});
	child.stdin.end(options.input);
	return new Promise<Result>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`CLI timeout: ${args.join(" ")}\nstdout=${stdout}\nstderr=${stderr}`));
		}, options.timeoutMs ?? 20_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
	let text = "";
	request.setEncoding("utf8");
	for await (const chunk of request) text += chunk;
	return JSON.parse(text) as Record<string, unknown>;
}

describe("smoke/built CLI core", { concurrency: false }, () => {
	let server: Server;
	let endpoint: string;
	const requests: Array<Record<string, unknown>> = [];

	before(async () => {
		server = createServer(async (request, response) => {
			if (request.method === "GET" && request.url === "/v1/models") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						object: "list",
						data: [
							{
								id: "mock-model",
								object: "model",
								tools: true,
								context_window: 32768,
								max_output_tokens: 4096,
							},
						],
					}),
				);
				return;
			}
			if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
				response.statusCode = 404;
				response.end("not found");
				return;
			}
			const payload = await body(request);
			requests.push(payload);
			if (payload.stream === false) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						id: "chatcmpl-smoke",
						object: "chat.completion",
						model: "mock-model",
						choices: [{ index: 0, message: { role: "assistant", content: "core reply" }, finish_reason: "stop" }],
					}),
				);
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-smoke",
					object: "chat.completion.chunk",
					created: 1,
					model: "mock-model",
					choices: [{ index: 0, delta: { role: "assistant", content: "core reply" } }],
				})}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-smoke",
					object: "chat.completion.chunk",
					created: 1,
					model: "mock-model",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
				})}\n\n`,
			);
			response.end("data: [DONE]\n\n");
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("reports version/help and routes usage errors to stderr", async () => {
		const scratch = home();
		try {
			const version = await runCli(["--version"], { env: scratch.env });
			strictEqual(version.code, 0);
			strictEqual(version.stdout, `Clio Coder ${VERSION}\n`);
			strictEqual(version.stderr, "");

			const help = await runCli(["--help"], { env: scratch.env });
			strictEqual(help.code, 0);
			match(help.stdout, /Usage:/u);
			match(help.stdout, /clio-coder run \[flags\] <task>/u);

			const unknown = await runCli(["not-a-command"], { env: scratch.env });
			strictEqual(unknown.code, 2);
			strictEqual(unknown.stdout, "");
			match(unknown.stderr, /unknown subcommand: not-a-command/u);
		} finally {
			scratch.cleanup();
		}
	});

	it("keeps doctor/configure outcomes and both configure cancellation codes", async () => {
		const scratch = home();
		const firstRun = home("clio-first-run-cancel-");
		try {
			const untouched = await runCli(["doctor", "--json"], { env: scratch.env });
			strictEqual(untouched.code, 0, untouched.stderr);
			strictEqual(JSON.parse(untouched.stdout).ok, true);
			strictEqual(readdirSync(scratch.root).length, 0, "read-only doctor must leave a fresh home empty");

			const fixed = await runCli(["doctor", "--fix", "--json"], { env: scratch.env });
			strictEqual(fixed.code, 0, fixed.stderr);
			strictEqual(JSON.parse(fixed.stdout).fix, true);
			ok(existsSync(join(scratch.root, "config", "settings.yaml")));

			const incomplete = await runCli(["configure", "--runtime", "openai-compat"], { env: scratch.env });
			strictEqual(incomplete.code, 2);
			match(incomplete.stderr, /--id is required/u);

			const configureCancel = await runCli(["configure"], { env: scratch.env, input: "q\n" });
			strictEqual(configureCancel.code, 130, configureCancel.stdout + configureCancel.stderr);
			match(configureCancel.stderr, /configuration cancelled/u);

			const firstRunCancel = await runCli([], {
				env: { ...firstRun.env, CLIO_CODER_INTERACTIVE: "1", TERM: "xterm-256color" },
				input: "q\n",
			});
			strictEqual(firstRunCancel.code, 130, firstRunCancel.stdout + firstRunCancel.stderr);
			match(firstRunCancel.stdout, /Starting `clio-coder configure`/u);
			match(firstRunCancel.stderr, /configuration cancelled/u);
		} finally {
			firstRun.cleanup();
			scratch.cleanup();
		}
	});

	it("runs one JSON headless turn through a local provider and seals its receipt", async () => {
		const scratch = home();
		try {
			const fixed = await runCli(["doctor", "--fix"], { env: scratch.env });
			strictEqual(fixed.code, 0, fixed.stderr);
			const configured = await runCli(
				[
					"configure",
					"--id",
					"local-smoke",
					"--runtime",
					"openai-compat",
					"--url",
					endpoint,
					"--model",
					"mock-model",
					"--set-orchestrator",
					"--context-window",
					"32768",
					"--reasoning",
					"false",
				],
				{ env: scratch.env },
			);
			strictEqual(configured.code, 0, configured.stdout + configured.stderr);

			const doctor = await runCli(["doctor", "--json"], { env: scratch.env });
			strictEqual(doctor.code, 0, doctor.stdout + doctor.stderr);
			strictEqual(JSON.parse(doctor.stdout).ok, true);

			const prompt = "CLI_CORE_ONE_TURN";
			const turn = await runCli(
				["--no-context-files", "--no-skills", "run", "--json-events", "terminal", prompt],
				{ env: scratch.env },
			);
			strictEqual(turn.code, 0, turn.stderr);
			const events = turn.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const types = events.map((event) => event.type);
			for (const type of ["session", "turn_start", "agent_end", "turn_end"]) ok(types.includes(type), turn.stdout);
			const settled = events.findLast((event) => event.type === "turn_end");
			strictEqual(settled?.exitCode, 0);
			ok(typeof settled?.endedAt === "string");
			ok(requests.some((request) => JSON.stringify(request.messages).includes(prompt)), "prompt must reach provider");

			const receiptDir = join(scratch.root, "state", "receipts");
			const files = readdirSync(receiptDir).filter((name) => name.endsWith(".json"));
			strictEqual(files.length, 1);
			const receipt = JSON.parse(readFileSync(join(receiptDir, files[0] ?? ""), "utf8")) as Record<string, unknown>;
			strictEqual(receipt.exitCode, 0);
			strictEqual(receipt.outcome, "succeeded");
			strictEqual(receipt.agentId, "main-agent");
			strictEqual(receipt.targetId, "local-smoke");
			strictEqual(receipt.wireModelId, "mock-model");
			ok(typeof receipt.runId === "string" && receipt.runId.length > 0);
			ok(typeof receipt.sessionId === "string" && receipt.sessionId.length > 0);
			ok(typeof receipt.integrity === "object" && receipt.integrity !== null);
		} finally {
			scratch.cleanup();
		}
	});
});
