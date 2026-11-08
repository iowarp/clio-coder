import { ok, strictEqual } from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readRunJournal } from "../harness/run-journal.js";

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
				"    lifecycle: user-managed",
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
		.replace(/^ {2}autonomy: default$/m, "  autonomy: yolo");
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

interface HostProcess {
	pid: number;
	started: string;
}

/**
 * The tool shell's `$$` is a PID inside the yolo sandbox's PID namespace
 * (bwrap `--unshare-pid`), not a host PID: on the host it names an unrelated
 * process, often a root-owned kernel thread, so probing or signalling it gave
 * EPERM. The host PIDs come from the host process table instead: every process
 * whose argv carries the tool command's marker. The start time guards against
 * PID reuse.
 */
function hostToolProcesses(marker: string): HostProcess[] {
	let table: string;
	try {
		table = execFileSync("ps", ["-ww", "-A", "-o", "pid=,lstart=,args="], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return [];
	}
	const found: HostProcess[] = [];
	for (const line of table.split("\n")) {
		const match = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/u.exec(line);
		if (match?.[1] && match[2] && match[3]?.includes(marker)) found.push({ pid: Number(match[1]), started: match[2] });
	}
	return found;
}

function hostProcessAlive(entry: HostProcess): boolean {
	try {
		const started = execFileSync("ps", ["-o", "lstart=", "-p", String(entry.pid)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return started === entry.started;
	} catch {
		// ps exits non-zero when the pid is gone.
		return false;
	}
}

function survivors(entries: ReadonlyArray<HostProcess>): HostProcess[] {
	return entries.filter(hostProcessAlive);
}

/**
 * The ps scan is host-wide, so each invocation tags its tool command with its
 * own marker: concurrent runs must not count or kill each other's payloads.
 */
function lifecycleMarker(): string {
	return `clio-lifecycle-${process.pid}-${randomUUID()}`;
}

/** Rejects instead of waiting forever when the CLI never exits. */
function bounded<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not happen within ${timeoutMs} ms`)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function killQuietly(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone or not ours; cleanup must not mask the test's own failure.
	}
}

describe("smoke/process lifecycle", { concurrency: false, skip: process.platform === "win32" }, () => {
	const TEST_TIMEOUT_MS = 90_000;
	const EXIT_TIMEOUT_MS = 30_000;
	it("coordinates SIGINT through the real tool child and leaves no orphan", { timeout: TEST_TIMEOUT_MS }, async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-coder-process-lifecycle-"));
		const env = environment(root);
		const project = join(root, "project");
		const pidFile = join(project, ".tool-child.pid");
		const stoppedFile = join(project, ".tool-child.stopped");
		const marker = lifecycleMarker();
		const command =
			"trap 'printf stopped > .tool-child.stopped; exit 0' TERM INT HUP; " +
			`printf '%s' "$$" > .tool-child.pid; while :; do sleep 1; done # ${marker}`;
		const fixture = await provider(command);
		let child: ReturnType<typeof spawn> | undefined;
		let toolProcesses: HostProcess[] = [];
		try {
			mkdirSync(project);
			execFileSync(process.execPath, [CLI, "doctor", "--fix"], { cwd: ROOT, env, stdio: "pipe" });
			seedTarget(root, fixture.url);
			child = spawn(
				process.execPath,
				[CLI, "--no-context-files", "--no-skills", "run", "--autonomy", "yolo", "start child"],
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
			const toolPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
			ok(Number.isSafeInteger(toolPid) && toolPid > 0, `tool child wrote no pid: ${toolPid}`);
			toolProcesses = hostToolProcesses(marker);
			ok(toolProcesses.length > 0, "tool child has no host process");

			child.kill("SIGINT");
			const result = await bounded(exit, EXIT_TIMEOUT_MS, "CLI exit");
			strictEqual(result.code, 130, `signal=${result.signal ?? "none"}; stderr=${stderr}`);
			ok(await waitFor(() => existsSync(stoppedFile), 5_000), "tool child did not observe coordinated termination");
			ok(
				await waitFor(() => survivors(toolProcesses).length === 0, 5_000),
				`orphaned tool pids ${survivors(toolProcesses)
					.map((entry) => entry.pid)
					.join(", ")}`,
			);

			const journal = readRunJournal(join(root, "state"));
			ok(journal);
			strictEqual(journal.envelopes.size, 1);
			const receipt = [...journal.envelopes.values()][0];
			ok(receipt);
			strictEqual(receipt.outcome, "canceled");
			strictEqual(receipt.exitCode, 130);
			ok(receipt.sessionId);
		} finally {
			if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			for (const entry of survivors(toolProcesses)) killQuietly(entry.pid);
			fixture.server.closeAllConnections();
			await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("ends a run --timeout through the same shutdown, stops the tool child, and seals timed_out", {
		timeout: TEST_TIMEOUT_MS,
	}, async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-coder-process-timeout-"));
		const env = environment(root);
		const project = join(root, "project");
		const pidFile = join(project, ".tool-child.pid");
		const stoppedFile = join(project, ".tool-child.stopped");
		const marker = lifecycleMarker();
		const command =
			"trap 'printf stopped > .tool-child.stopped; exit 0' TERM INT HUP; " +
			`printf '%s' "$$" > .tool-child.pid; while :; do sleep 1; done # ${marker}`;
		const fixture = await provider(command);
		let child: ReturnType<typeof spawn> | undefined;
		let toolProcesses: HostProcess[] = [];
		try {
			mkdirSync(project);
			execFileSync(process.execPath, [CLI, "doctor", "--fix"], { cwd: ROOT, env, stdio: "pipe" });
			seedTarget(root, fixture.url);
			child = spawn(
				process.execPath,
				[CLI, "--no-context-files", "--no-skills", "run", "--autonomy", "yolo", "--timeout", "4", "start child"],
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
			const toolPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
			ok(Number.isSafeInteger(toolPid) && toolPid > 0, `tool child wrote no pid: ${toolPid}`);
			toolProcesses = hostToolProcesses(marker);
			ok(toolProcesses.length > 0, "tool child has no host process");

			const result = await bounded(exit, EXIT_TIMEOUT_MS, "CLI exit");
			strictEqual(result.code, 124, `signal=${result.signal ?? "none"}; stderr=${stderr}`);
			ok(await waitFor(() => existsSync(stoppedFile), 5_000), "tool child did not observe coordinated termination");
			ok(
				await waitFor(() => survivors(toolProcesses).length === 0, 5_000),
				`orphaned tool pids ${survivors(toolProcesses)
					.map((entry) => entry.pid)
					.join(", ")}`,
			);

			const journal = readRunJournal(join(root, "state"));
			ok(journal);
			strictEqual(journal.envelopes.size, 1);
			const receipt = [...journal.envelopes.values()][0];
			ok(receipt);
			strictEqual(receipt.outcome, "timed_out");
			strictEqual(receipt.exitCode, 124);
		} finally {
			if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			for (const entry of survivors(toolProcesses)) killQuietly(entry.pid);
			fixture.server.closeAllConnections();
			await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
			rmSync(root, { recursive: true, force: true });
		}
	});
});
