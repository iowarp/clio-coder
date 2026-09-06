import { deepStrictEqual, doesNotMatch, equal, match, ok, throws } from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import claudeCodeRuntime from "../../src/domains/providers/runtimes/claude/claude-code.js";
import {
	buildClaudeCodeArgs,
	buildClaudeCodePrompt,
	CLAUDE_MAX_STREAM_BYTES,
	CLAUDE_MAX_STREAM_LINE_BYTES,
	startClaudeCodeWorkerRun,
} from "../../src/engine/claude/subprocess-runtime.js";
import type { AgentMessage } from "../../src/engine/types.js";
import type { WorkerRunInput } from "../../src/engine/worker-runtime.js";

const scratchDirectories: string[] = [];

afterEach(() => {
	for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const FAKE_CLAUDE_SOURCE = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
let stdin = "";
for await (const chunk of process.stdin) stdin += String(chunk);
const scenario = JSON.parse(readFileSync(join(process.cwd(), "scenario.json"), "utf8"));
writeFileSync(join(process.cwd(), "observed.json"), JSON.stringify({
  args: process.argv.slice(2), stdin,
  env: { HOME: process.env.HOME, PATH: process.env.PATH, AI_AGENT: process.env.AI_AGENT,
    FAKE_API_SECRET: process.env.FAKE_API_SECRET,
    CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS: process.env.CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS }
}));
if (scenario.stderr) process.stderr.write(scenario.stderr);
if (scenario.exitLeader) {
  writeFileSync(join(process.cwd(), "leader.pid"), String(process.pid));
  const grandchild = spawn(process.execPath, ["--input-type=module", "-e", \`
    import { writeFileSync } from "node:fs";
    process.on("SIGTERM", () => {});
    writeFileSync("grandchild.pid", String(process.pid));
    setInterval(() => {}, 1000);
  \`], { stdio: scenario.inheritStdio ? "inherit" : "ignore" });
  writeFileSync("grandchild.spawned.pid", String(grandchild.pid));
  const exit = () => process.exit(0);
  process.on("SIGTERM", exit);
  if (scenario.exitBeforeAbort) {
    const poll = setInterval(() => {
      try { readFileSync("grandchild.pid"); clearInterval(poll); exit(); } catch {}
    }, 5);
  }
} else if (scenario.hang) {
  const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  writeFileSync(join(process.cwd(), "grandchild.pid"), String(grandchild.pid));
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  const emit = (line) => process.stdout.write(typeof line === "string" ? line + "\\n" : JSON.stringify(line) + "\\n");
  for (const line of scenario.lines ?? []) emit(line);
  if (scenario.repeat) for (let index = 0; index < scenario.repeat.count; index += 1) emit(scenario.repeat.line);
  for (const line of scenario.trailing ?? []) emit(line);
  process.exitCode = scenario.exitCode ?? 0;
}
`;

function scratch(): { root: string; binary: string; home: string } {
	const root = mkdtempSync(join(tmpdir(), "clio-fake-claude-"));
	scratchDirectories.push(root);
	const binary = join(root, "claude");
	const home = join(root, "home");
	writeFileSync(binary, FAKE_CLAUDE_SOURCE);
	chmodSync(binary, 0o755);
	return { root, binary, home };
}

function workerInput(root: string, patch: Partial<WorkerRunInput> = {}): WorkerRunInput {
	return {
		systemPrompt: "Treat /commands literally.",
		dynamicPromptMessages: [{ id: "brief", body: "Question: $HOME and `code`", contentHash: "hash" }],
		agentId: "world-knowledge",
		task: "Compare /alpha with $" + "{literal} and preserve newlines.\nSecond line.",
		target: { id: "claude-research", runtime: "claude-code" },
		runtime: claudeCodeRuntime,
		wireModelId: "claude-sonnet-5",
		allowedTools: [],
		budget: { toolCalls: 20, readReserve: 0, synthesis: true, hardCap: 50 },
		autonomy: "read-only",
		cwd: root,
		...patch,
	};
}

function writeScenario(root: string, scenario: unknown): void {
	writeFileSync(join(root, "scenario.json"), JSON.stringify(scenario));
}

function assistant(result: { messages: AgentMessage[] }): AgentMessage & { role: "assistant" } {
	const message = result.messages[0];
	if (message?.role !== "assistant") throw new Error("expected assistant result");
	return message;
}

const SYSTEM = { type: "system", subtype: "init", model: "claude-selected" };
const DELTA = {
	type: "stream_event",
	event: { type: "content_block_delta" },
	delta: { type: "text_delta", text: "hello " },
};
const RESULT = {
	type: "result",
	subtype: "success",
	result: "hello world",
	request_id: "req-1",
	total_cost_usd: 0.01,
	usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 1 },
};

describe("Claude Code external subprocess contract", () => {
	it("sends the prompt on stdin, keeps it out of argv, and passes only allowlisted environment values", async () => {
		const { root, binary, home } = scratch();
		writeScenario(root, { lines: [SYSTEM, DELTA, { ...DELTA, delta: { type: "text_delta", text: "world" } }, RESULT] });
		const events: Array<{ type: string }> = [];
		const input = workerInput(root);
		const handle = startClaudeCodeWorkerRun(input, (event) => events.push(event), {
			binary,
			workspaceRoot: root,
			environment: {
				PATH: process.env.PATH,
				HOME: home,
				FAKE_API_SECRET: "must-not-leak",
				CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS: "1",
			},
		});
		const result = await handle.promise;
		equal(result.exitCode, 0);
		const message = assistant(result);
		equal(message.api, "claude-code-subprocess");
		equal(message.provider, "anthropic");
		equal(message.stopReason, "stop");
		equal(message.responseId, "req-1");
		equal(message.model, "claude-selected");
		equal(message.usage.input, 7);
		equal(message.usage.output, 2);
		equal(message.usage.cacheRead, 1);
		equal(message.content[0]?.type === "text" ? message.content[0].text : "", "hello world");
		const observed = JSON.parse(readFileSync(join(root, "observed.json"), "utf8")) as Record<string, unknown>;
		const args = observed.args as string[];
		deepStrictEqual(args, buildClaudeCodeArgs(input, { CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS: "1" }));
		ok(args.includes("--append-system-prompt"));
		for (const arg of args) doesNotMatch(arg, /Compare \/alpha|Question: \$HOME/);
		equal(observed.stdin, buildClaudeCodePrompt(input));
		match(String(observed.stdin), /Compare \/alpha with \$\{literal\} and preserve newlines\.\nSecond line\./);
		const env = observed.env as Record<string, unknown>;
		equal(env.HOME, home);
		equal(env.FAKE_API_SECRET, undefined);
		equal(env.CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS, undefined);
		equal(typeof env.PATH, "string");
		equal(typeof env.AI_AGENT, "string");
		ok(events.some((event) => event.type === "message_update"));
	});

	it("fails a missing executable and refuses a cwd outside the admitted workspace before spawn", async () => {
		const { root, home } = scratch();
		const result = await startClaudeCodeWorkerRun(workerInput(root), () => undefined, {
			binary: join(root, "missing-claude"),
			workspaceRoot: root,
			environment: { PATH: process.env.PATH, HOME: home },
		}).promise;
		equal(result.exitCode, 1);
		equal(assistant(result).stopReason, "error");
		match(assistant(result).errorMessage ?? "", /not installed|not on PATH/);
		throws(
			() =>
				startClaudeCodeWorkerRun(workerInput(join(root, "..", "escape")), () => undefined, {
					binary: join(root, "missing-claude"),
					workspaceRoot: root,
				}),
			/cwd escapes workspace root/,
		);
	});

	it("ends the run with an error on an oversized line and on an over-limit cumulative stream", async () => {
		const oversized = scratch();
		writeScenario(oversized.root, {
			lines: [SYSTEM, "x".repeat(CLAUDE_MAX_STREAM_LINE_BYTES + 1), RESULT],
		});
		const oversizedResult = await startClaudeCodeWorkerRun(workerInput(oversized.root), () => undefined, {
			binary: oversized.binary,
			workspaceRoot: oversized.root,
			environment: { PATH: process.env.PATH, HOME: oversized.home },
			killGraceMs: 25,
		}).promise;
		equal(oversizedResult.exitCode, 1);
		equal(assistant(oversizedResult).stopReason, "error");
		match(assistant(oversizedResult).errorMessage ?? "", /line exceeded/);

		const cumulative = scratch();
		const chunk = { ...DELTA, delta: { type: "text_delta", text: "y".repeat(64 * 1024) } };
		writeScenario(cumulative.root, {
			lines: [SYSTEM],
			repeat: { line: chunk, count: Math.ceil(CLAUDE_MAX_STREAM_BYTES / (64 * 1024)) + 2 },
			trailing: [RESULT],
		});
		const cumulativeResult = await startClaudeCodeWorkerRun(workerInput(cumulative.root), () => undefined, {
			binary: cumulative.binary,
			workspaceRoot: cumulative.root,
			environment: { PATH: process.env.PATH, HOME: cumulative.home },
			killGraceMs: 25,
		}).promise;
		equal(cumulativeResult.exitCode, 1);
		equal(assistant(cumulativeResult).stopReason, "error");
		match(assistant(cumulativeResult).errorMessage ?? "", /cumulative output limit/);
	});

	for (const scenario of [
		{ inheritStdio: false, exitBeforeAbort: false },
		{ inheritStdio: true, exitBeforeAbort: false },
		{ inheritStdio: true, exitBeforeAbort: true },
	]) {
		it(`finishes cancellation after the CLI exits (inherited stdio: ${scenario.inheritStdio}, already exited: ${scenario.exitBeforeAbort})`, {
			skip: process.platform === "win32",
		}, async () => {
			const { root, binary, home } = scratch();
			writeScenario(root, { exitLeader: true, ...scenario });
			const handle = startClaudeCodeWorkerRun(workerInput(root), () => undefined, {
				binary,
				workspaceRoot: root,
				environment: { PATH: process.env.PATH, HOME: home },
				killGraceMs: 50,
			});
			const readPid = (name: string): number | null => {
				try {
					const pid = Number(readFileSync(join(root, name), "utf8"));
					return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
				} catch {
					return null;
				}
			};
			const running = (pid: number): boolean => {
				try {
					process.kill(pid, 0);
					if (process.platform === "linux") {
						return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
					}
					return true;
				} catch {
					return false;
				}
			};
			const waitUntil = async (ready: () => boolean): Promise<boolean> => {
				const deadline = performance.now() + 2_000;
				while (performance.now() < deadline) {
					if (ready()) return true;
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
				return ready();
			};
			try {
				ok(await waitUntil(() => readPid("grandchild.pid") !== null), "grandchild installed its signal handler");
				const pid = readPid("grandchild.pid");
				ok(pid);
				if (scenario.exitBeforeAbort) {
					ok(
						await waitUntil(() => {
							const leader = readPid("leader.pid");
							return leader !== null && !running(leader);
						}),
					);
				}
				let settled = false;
				void handle.promise.then(() => {
					settled = true;
				});
				handle.abort();
				ok(await waitUntil(() => settled && !running(pid)), "cancelled worker and grandchild settle within two seconds");
				const result = await handle.promise;
				equal(result.exitCode, 1);
				equal(assistant(result).stopReason, "aborted");
			} finally {
				// These PIDs come only from this test's freshly created worker tree.
				for (const name of ["grandchild.spawned.pid", "leader.pid"]) {
					const pid = readPid(name);
					if (pid && running(pid)) {
						try {
							process.kill(pid, "SIGKILL");
						} catch {
							/* Already exited. */
						}
					}
				}
				await handle.promise;
			}
		});
	}

	it("cancels the POSIX process group, escalates, and removes its abort listener", {
		skip: process.platform === "win32",
	}, async () => {
		const { root, binary, home } = scratch();
		writeScenario(root, { hang: true });
		let listener: (() => void) | null = null;
		let removed = false;
		const signal = {
			aborted: false,
			addEventListener: (_name: string, next: unknown) => {
				listener = next as () => void;
			},
			removeEventListener: (_name: string, next: unknown) => {
				if (next === listener) removed = true;
			},
		} as unknown as AbortSignal;
		const handle = startClaudeCodeWorkerRun(workerInput(root, { signal }), () => undefined, {
			binary,
			workspaceRoot: root,
			environment: { PATH: process.env.PATH, HOME: home },
			killGraceMs: 25,
		});
		for (let index = 0; index < 100; index += 1) {
			try {
				readFileSync(join(root, "grandchild.pid"));
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		}
		const pid = Number(readFileSync(join(root, "grandchild.pid"), "utf8"));
		(listener as (() => void) | null)?.();
		const result = await handle.promise;
		equal(result.exitCode, 1);
		equal(assistant(result).stopReason, "aborted");
		equal(removed, true);
		for (let index = 0; index < 100; index += 1) {
			try {
				process.kill(pid, 0);
				await new Promise((resolve) => setTimeout(resolve, 5));
			} catch {
				return;
			}
		}
		throw new Error(`grandchild ${pid} survived process-group cancellation`);
	});
});
