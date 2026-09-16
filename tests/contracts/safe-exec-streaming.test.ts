import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	createProcessGroupCleanup,
	createRetainedStreamWindow,
	type ProcessGroupCleanupScheduler,
	runCommandVector,
	SAFE_EXEC_DEFAULT_RETAIN_HEAD_BYTES,
	SAFE_EXEC_DEFAULT_RETAIN_TAIL_BYTES,
} from "../../src/core/safe-exec.js";

import { runVectorTool } from "../../src/tools/safe-exec.js";

const roots: string[] = [];

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-safe-exec-streaming-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A node one-liner that writes `chunks` blocks of `chunkBytes` filler to stdout and one line to stderr. */
function producer(chunks: number, chunkBytes: number): string[] {
	return [
		process.execPath,
		"-e",
		`const block = Buffer.alloc(${chunkBytes}, 0x61);
let remaining = ${chunks};
function pump() {
	while (remaining > 0) {
		remaining -= 1;
		if (!process.stdout.write(block)) { process.stdout.once("drain", pump); return; }
	}
	process.stderr.write("done\\n");
}
pump();`,
	];
}

/**
 * A node one-liner that ignores SIGTERM, writes three 1 KiB blocks to stdout
 * 150 ms apart, and exits 0 on its own once the last block is flushed. The
 * gaps keep the blocks in separate chunks; ignoring SIGTERM keeps the child
 * alive past the runner's first kill so later blocks are still received.
 */
function threeSpacedBlocks(): string[] {
	return [
		process.execPath,
		"-e",
		`process.on("SIGTERM", () => {});
const block = Buffer.alloc(1024, 0x62);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
	process.stdout.write(block);
	await pause(150);
	process.stdout.write(block);
	await pause(150);
	process.stdout.write(block, () => process.exit(0));
})();`,
	];
}

type ProcessState = "running" | "zombie" | "gone";

/**
 * Where `pid` stands: still running, exited but not yet reaped (`Z` in
 * `/proc/<pid>/stat`), or gone from the process table. Only "gone" proves
 * the reaper did its work; a zombie still occupies its process group.
 */
function processState(pid: number): ProcessState {
	try {
		process.kill(pid, 0);
	} catch {
		return "gone";
	}
	if (process.platform !== "linux") return "running";
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// The command name sits in parentheses and may contain spaces; the
		// state letter is the first field after the closing parenthesis.
		const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
		return state === "Z" ? "zombie" : "running";
	} catch {
		return "gone";
	}
}

/** Poll `pid` until it is gone or `attempts` are used up; returns the final state. */
async function settleProcessState(pid: number, attempts = 40): Promise<ProcessState> {
	let state = processState(pid);
	for (let attempt = 0; state !== "gone" && attempt < attempts; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		state = processState(pid);
	}
	return state;
}

/** Best-effort removal of a fixture process that outlived its test, so a failure never leaks it. */
function reapFixture(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

/**
 * A node one-liner for the leader: it spawns a descendant with independent
 * stdio that ignores SIGTERM, prints one line, waits until the descendant
 * has installed its handler (the descendant writes its own pid to the file
 * named by the first script argument only after that), then `ending` decides
 * how the leader itself goes on. Without the handshake a SIGTERM could reach
 * the descendant while it is still booting and kill it by default.
 */
function leaderWithResistantDescendant(ending: string): string {
	return `const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const pidFile = process.argv[1];
const child = spawn(
	process.execPath,
	["-e", "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", pidFile],
	{ stdio: "ignore" },
);
child.unref();
process.stdout.write("spawned\\n");
const ready = setInterval(() => {
	if (!existsSync(pidFile)) return;
	clearInterval(ready);
	${ending}
}, 10);`;
}

interface KillCall {
	pid: number;
	signal: string | number | undefined;
	error: string | null;
}

/** Record every `process.kill` the runner issues while `run` executes, restoring the original afterwards. */
async function spyOnKill<T>(run: () => Promise<T>): Promise<{ result: T; calls: KillCall[] }> {
	const calls: KillCall[] = [];
	const original = process.kill;
	process.kill = ((pid: number, signal?: string | number) => {
		try {
			const outcome = original.call(process, pid, signal as NodeJS.Signals);
			calls.push({ pid, signal, error: null });
			return outcome;
		} catch (error) {
			calls.push({ pid, signal, error: (error as NodeJS.ErrnoException).code ?? String(error) });
			throw error;
		}
	}) as typeof process.kill;
	try {
		return { result: await run(), calls };
	} finally {
		process.kill = original;
	}
}

class FakeScheduler implements ProcessGroupCleanupScheduler {
	#now = 0;
	#nextId = 1;
	readonly jobs = new Map<number, { callback: () => void; dueAt: number }>();

	setTimeout(callback: () => void, delayMs: number): number {
		const id = this.#nextId++;
		this.jobs.set(id, { callback, dueAt: this.#now + delayMs });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.jobs.delete(handle as number);
	}

	advanceTo(nowMs: number): void {
		this.#now = nowMs;
		for (;;) {
			const due = [...this.jobs.entries()].filter(([, job]) => job.dueAt <= nowMs).sort((a, b) => a[1].dueAt - b[1].dueAt);
			const next = due[0];
			if (next === undefined) return;
			this.jobs.delete(next[0]);
			next[1].callback();
		}
	}
}

/**
 * Records probe/signal calls in order so tests can check that every signal
 * follows a probe that reported members. `delivered` decides what each
 * signal reports: true for delivery, false for ESRCH at delivery time.
 */
function recordingHooks(alive: () => boolean, delivered: (signalName: NodeJS.Signals) => boolean = () => true) {
	const calls: string[] = [];
	const done: Array<{ descendantsCleaned: boolean; incomplete: boolean }> = [];
	return {
		calls,
		done,
		hooks: {
			probe() {
				const members = alive();
				calls.push(members ? "probe:members" : "probe:gone");
				return members;
			},
			signal(signalName: NodeJS.Signals) {
				const sent = delivered(signalName);
				calls.push(sent ? `signal:${signalName}` : `signal:${signalName}:gone`);
				return sent;
			},
			onDone(status: { descendantsCleaned: boolean; incomplete: boolean }) {
				done.push(status);
			},
		},
	};
}

function everySignalFollowsAProbeWithMembers(calls: string[]): boolean {
	return calls.every((call, index) => !call.startsWith("signal:") || calls[index - 1] === "probe:members");
}

describe("retained stream window", () => {
	it("keeps the whole stream when it fits and reports it retained", () => {
		const window = createRetainedStreamWindow(8, 8);
		window.append(Buffer.from("abc"));
		window.append(Buffer.from("defgh"));
		deepStrictEqual(window.render(), { text: "abcdefgh", retained: true, totalBytes: 8, omittedBytes: 0 });
	});

	it("keeps head and tail with an exact omitted count", () => {
		const window = createRetainedStreamWindow(4, 4);
		for (const piece of ["0123", "4567", "89ab", "cdef", "g"]) window.append(Buffer.from(piece));
		const rendered = window.render();
		strictEqual(rendered.totalBytes, 17);
		strictEqual(rendered.omittedBytes, 9);
		strictEqual(rendered.retained, false);
		strictEqual(rendered.text, "0123\n[... 9 bytes omitted ...]\ndefg");
	});

	it("never decodes a split multibyte character and counts the trimmed bytes as omitted", () => {
		const text = "é".repeat(20);
		const bytes = Buffer.from(text, "utf8");
		strictEqual(bytes.byteLength, 40);
		const window = createRetainedStreamWindow(3, 3);
		for (let index = 0; index < bytes.byteLength; index += 1) window.append(bytes.subarray(index, index + 1));
		const rendered = window.render();
		ok(!rendered.text.includes("�"), rendered.text);
		// Each 3-byte window shows one 2-byte character; the byte trimmed at
		// each boundary is absent from the text and therefore counted.
		strictEqual(rendered.text, "é\n[... 36 bytes omitted ...]\né");
		strictEqual(rendered.omittedBytes, 36);
		strictEqual(Buffer.byteLength(rendered.text.replace(/\n\[\.\.\. 36 bytes omitted \.\.\.\]\n/u, "")) + 36, 40);
	});

	it("keeps only the tail when the head cap is zero", () => {
		const window = createRetainedStreamWindow(0, 6);
		window.append(Buffer.from("hello world"));
		const rendered = window.render();
		strictEqual(rendered.text, "[... 5 bytes omitted ...]\n world");
		strictEqual(rendered.retained, false);
	});
});

describe("runCommandVector output sink", () => {
	it("streams 256 MiB through the sink with exact counts, byte order, and bounded peak memory", async () => {
		const root = workspace();
		const chunkBytes = 1024 * 1024;
		const chunks = 256;
		const totalBytes = chunks * chunkBytes;
		const rssBefore = process.memoryUsage().rss;
		let peakRss = rssBefore;
		let sinkStdout = 0;
		let sinkStderr = "";
		const digest = createHash("sha256");
		const expectedDigest = createHash("sha256");
		const filler = Buffer.alloc(chunkBytes, 0x61);
		for (let index = 0; index < chunks; index += 1) expectedDigest.update(filler);
		const [file, ...args] = producer(chunks, chunkBytes);
		const result = await runCommandVector(file as string, args, {
			cwd: root,
			workspaceRoot: root,
			timeoutMs: 60_000,
			output: {
				onStdout(chunk) {
					const before = sinkStdout;
					sinkStdout += chunk.byteLength;
					// Hash every byte so the assertion covers content, not just length.
					digest.update(chunk);
					// Sample the resident set every 4 MiB of delivered output so the
					// bound covers the peak during the stream, not just the end.
					if (Math.floor(before / (4 * chunkBytes)) !== Math.floor(sinkStdout / (4 * chunkBytes))) {
						peakRss = Math.max(peakRss, process.memoryUsage().rss);
					}
				},
				onStderr(chunk) {
					sinkStderr += chunk.toString("utf8");
				},
			},
		});
		peakRss = Math.max(peakRss, process.memoryUsage().rss);
		strictEqual(result.exitCode, 0);
		strictEqual(result.signal, null);
		strictEqual(result.outputCapped, false);
		strictEqual(result.timedOut, false);
		strictEqual(result.aborted, false);
		strictEqual(result.stdoutBytes, totalBytes);
		strictEqual(sinkStdout, totalBytes);
		strictEqual(digest.digest("hex"), expectedDigest.digest("hex"), "the sink received every byte in order");
		strictEqual(sinkStderr, "done\n");
		strictEqual(result.stderrBytes, 5);
		strictEqual(result.stderr, "done\n");
		strictEqual(result.stderrRetained, true);
		strictEqual(result.stdoutRetained, false);
		ok(
			result.stdout.length <= SAFE_EXEC_DEFAULT_RETAIN_HEAD_BYTES + SAFE_EXEC_DEFAULT_RETAIN_TAIL_BYTES + 64,
			`retained stdout is bounded: ${result.stdout.length}`,
		);
		ok(result.stdout.includes("bytes omitted"), "the rendering names the omitted span");
		ok(typeof result.startedAt === "number" && result.startedAt > 0);
		// Retaining the whole stream would grow the resident set by at least the
		// 256 MiB streamed. The measured floor for a streaming implementation is
		// about 68 MiB: V8 lets garbage read buffers accumulate to its 64 MB
		// external-memory threshold before collecting them. Half the streamed
		// volume is a bound retention cannot meet and streaming clears with margin.
		const peakGrowth = peakRss - rssBefore;
		ok(peakGrowth < totalBytes / 2, `peak RSS growth stays under half the streamed volume: ${peakGrowth}`);
	});

	it("keeps the capped behavior byte-for-byte when no sink is given", async () => {
		const root = workspace();
		const [file, ...args] = producer(4, 1024 * 1024);
		const result = await runCommandVector(file as string, args, {
			cwd: root,
			workspaceRoot: root,
			timeoutMs: 20_000,
			maxOutputBytes: 100_000,
		});
		strictEqual(result.outputCapped, true);
		ok(result.exitCode !== 0 || result.signal !== null, "a capped child is terminated");
		strictEqual(result.stdoutRetained, false);
		ok(result.stdout.length <= 100_000);
	});

	it("counts every received byte on the capped path, including the chunk that crossed the cap", async () => {
		const root = workspace();
		const [file, ...args] = threeSpacedBlocks();
		const result = await runCommandVector(file as string, args, {
			cwd: root,
			workspaceRoot: root,
			timeoutMs: 20_000,
			maxOutputBytes: 1500,
		});
		strictEqual(result.outputCapped, true);
		strictEqual(result.stdoutRetained, false);
		// Three blocks reached the runner: the one under the cap, the one that
		// crossed it, and the one written after the kill was already sent.
		strictEqual(result.stdoutBytes, 3072);
		strictEqual(result.stderrBytes, 0);
		ok(Buffer.byteLength(result.stdout) <= 1024, `only the bytes under the cap are kept: ${result.stdout.length}`);
		strictEqual(result.exitCode, 0, "the child ignored SIGTERM and exited on its own before the SIGKILL grace");
	});

	it("reports small output as fully retained with counts and a wall-clock start", async () => {
		const root = workspace();
		const started = Date.now();
		const result = await runCommandVector(
			process.execPath,
			["-e", 'process.stdout.write("out"); process.stderr.write("err")'],
			{ cwd: root, workspaceRoot: root, output: {} },
		);
		strictEqual(result.stdout, "out");
		strictEqual(result.stderr, "err");
		strictEqual(result.stdoutBytes, 3);
		strictEqual(result.stderrBytes, 3);
		strictEqual(result.stdoutRetained, true);
		strictEqual(result.stderrRetained, true);
		ok((result.startedAt ?? 0) >= started - 5);
		strictEqual(result.descendantsCleaned, false);
		strictEqual(result.cleanupIncomplete, false);
		strictEqual(result.failure, null);
	});

	it("terminates the child and names the failure when the sink throws", async () => {
		const root = workspace();
		const [file, ...args] = producer(4, 1024 * 1024);
		let calls = 0;
		const result = await runCommandVector(file as string, args, {
			cwd: root,
			workspaceRoot: root,
			timeoutMs: 20_000,
			output: {
				onStdout() {
					calls += 1;
					if (calls === 2) throw new Error("disk full");
				},
			},
		});
		strictEqual(result.sinkError, "disk full");
		strictEqual(result.outputCapped, false);
		ok(result.exitCode !== 0 || result.signal !== null, "the child was stopped");
		strictEqual(calls, 2, "no chunk is forwarded after the sink fails");
	});

	it("counts bytes received after the sink failed while forwarding nothing more", async () => {
		const root = workspace();
		const [file, ...args] = threeSpacedBlocks();
		let calls = 0;
		let forwarded = 0;
		const result = await runCommandVector(file as string, args, {
			cwd: root,
			workspaceRoot: root,
			timeoutMs: 20_000,
			output: {
				onStdout(chunk) {
					calls += 1;
					forwarded += chunk.byteLength;
					throw new Error("disk full");
				},
			},
		});
		strictEqual(result.sinkError, "disk full");
		strictEqual(calls, 1);
		strictEqual(forwarded, 1024);
		strictEqual(result.stdoutBytes, 3072, "the two blocks received after the failure are counted");
		strictEqual(result.exitCode, 0, "the child ignored SIGTERM and exited on its own before the SIGKILL grace");
		// The bounded window keeps observing, so the result's tail still shows
		// what the child said even though the sink never received it.
		strictEqual(Buffer.byteLength(result.stdout), 3072);
		strictEqual(result.stdoutRetained, true);
	});

	it("kills and reaps a TERM-resistant descendant after its parent exits on timeout", async (t) => {
		if (process.platform === "win32") {
			t.skip("process groups are a POSIX mechanism");
			return;
		}
		const root = workspace();
		const pidFile = join(root, "grandchild.pid");
		const started = Date.now();
		const result = await runCommandVector(
			process.execPath,
			["-e", leaderWithResistantDescendant("setInterval(() => {}, 1000);"), pidFile],
			{ cwd: root, workspaceRoot: root, timeoutMs: 1000, killGraceMs: 400 },
		);
		strictEqual(result.timedOut, true);
		strictEqual(result.signal, "SIGTERM", "the parent died from the first signal");
		strictEqual(result.stdout, "spawned\n");
		const pid = Number(readFileSync(pidFile, "utf8"));
		ok(Number.isInteger(pid) && pid > 0, `grandchild pid recorded: ${pid}`);
		// The descendant ignored SIGTERM and held no inherited pipe, so only a
		// group-wide SIGKILL after the grace can have removed it; init (or a
		// subreaper) then reaps the orphan, so it must be gone, not a zombie.
		const state = await settleProcessState(pid);
		if (state !== "gone") reapFixture(pid);
		strictEqual(state, "gone", `descendant ${pid} was reaped after the timeout`);
		strictEqual(result.descendantsCleaned, true, "the result says descendants had to be cleaned");
		strictEqual(result.cleanupIncomplete, false);
		const elapsed = Date.now() - started;
		ok(elapsed >= 1000 + 400, `the result waited for the grace to elapse: ${elapsed}ms`);
		ok(elapsed < 1000 + 400 + 1500, `the result resolved once the group was gone: ${elapsed}ms`);
	});

	it("cleans up and reaps a TERM-resistant descendant when the leader exits on its own", async (t) => {
		if (process.platform === "win32") {
			t.skip("process groups are a POSIX mechanism");
			return;
		}
		const root = workspace();
		const pidFile = join(root, "grandchild.pid");
		const started = Date.now();
		const result = await runCommandVector(
			process.execPath,
			["-e", leaderWithResistantDescendant("process.exit(7);"), pidFile],
			{ cwd: root, workspaceRoot: root, timeoutMs: 20_000, killGraceMs: 300 },
		);
		strictEqual(result.exitCode, 7, "the leader's own exit code is reported");
		strictEqual(result.signal, null);
		strictEqual(result.timedOut, false);
		strictEqual(result.aborted, false);
		strictEqual(result.stdout, "spawned\n");
		const pid = Number(readFileSync(pidFile, "utf8"));
		ok(Number.isInteger(pid) && pid > 0, `grandchild pid recorded: ${pid}`);
		const state = await settleProcessState(pid);
		if (state !== "gone") reapFixture(pid);
		strictEqual(state, "gone", `descendant ${pid} was reaped after the unexpected leader exit`);
		strictEqual(result.descendantsCleaned, true, "the result says descendants had to be cleaned");
		strictEqual(result.cleanupIncomplete, false);
		const elapsed = Date.now() - started;
		ok(elapsed >= 300, `cleanup gave the descendant the SIGTERM grace: ${elapsed}ms`);
		ok(elapsed < 300 + 1500, `the result resolved once the group was gone: ${elapsed}ms`);
	});

	it("probes the group once at leader exit and sends nothing when close follows a completed cleanup", async (t) => {
		if (process.platform === "win32") {
			t.skip("process groups are a POSIX mechanism");
			return;
		}
		const root = workspace();
		const { result, calls } = await spyOnKill(() =>
			runCommandVector(process.execPath, ["-e", 'process.stdout.write("done")'], { cwd: root, workspaceRoot: root }),
		);
		strictEqual(result.exitCode, 0);
		strictEqual(result.stdout, "done");
		const groupCalls = calls.filter((call) => call.pid < 0);
		// Exit came first: one existence probe found the group gone, cleanup
		// closed for good, and the later close event sent nothing.
		deepStrictEqual(
			groupCalls.map((call) => [call.signal, call.error]),
			[[0, "ESRCH"]],
		);
		strictEqual(result.descendantsCleaned, false);
		strictEqual(result.cleanupIncomplete, false);
	});

	it("stops signalling after the first probe that reports the group gone on a timeout", async (t) => {
		if (process.platform === "win32") {
			t.skip("process groups are a POSIX mechanism");
			return;
		}
		const root = workspace();
		const { result, calls } = await spyOnKill(() =>
			runCommandVector(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
				cwd: root,
				workspaceRoot: root,
				timeoutMs: 300,
				killGraceMs: 5000,
			}),
		);
		strictEqual(result.timedOut, true);
		strictEqual(result.signal, "SIGTERM");
		const groupCalls = calls.filter((call) => call.pid < 0).map((call) => [call.signal, call.error]);
		// Kill time: probe, then SIGTERM. Leader exit: probe reports ESRCH and
		// closes the window; the pending SIGKILL never goes out.
		deepStrictEqual(groupCalls, [
			[0, null],
			["SIGTERM", null],
			[0, "ESRCH"],
		]);
		strictEqual(result.descendantsCleaned, false);
	});
});

describe("runner cleanup failure compatibility", () => {
	for (const errorCode of ["EPERM", "EACCES"]) {
		it(`keeps bounded cleanup after leader exit when group signalling returns ${errorCode}`, async (t) => {
			if (process.platform === "win32") return t.skip("process groups require POSIX");
			const root = workspace();
			const original = process.kill;
			const calls: Array<string | number | undefined> = [];
			process.kill = ((pid: number, signal?: string | number) => {
				if (pid >= 0) return original.call(process, pid, signal as NodeJS.Signals);
				calls.push(signal);
				if (signal === 0) return true;
				throw Object.assign(new Error(errorCode), { code: errorCode });
			}) as typeof process.kill;
			try {
				const result = await runCommandVector(process.execPath, ["-e", "process.exit(0)"], {
					cwd: root,
					workspaceRoot: root,
					killGraceMs: 20,
				});
				strictEqual(result.cleanupIncomplete, true);
				strictEqual(result.exitCode, 1);
				deepStrictEqual(result.leaderExit, { code: 0, signal: null });
				strictEqual(result.signal, null);
				ok(result.failure?.includes("cleanup incomplete"));
				deepStrictEqual(
					calls.filter((signal) => signal !== 0),
					["SIGTERM", "SIGKILL"],
				);
				for (const [index, signal] of calls.entries()) {
					if (signal !== 0) strictEqual(calls[index - 1], 0);
				}
				ok(result.durationMs >= 1020);
				ok(result.durationMs < 3000);
				const count = calls.length;
				await new Promise((resolve) => setTimeout(resolve, 75));
				strictEqual(calls.length, count, "no group access after settlement");
			} finally {
				process.kill = original;
			}
		});
	}

	it("returns an error through the actual runVectorTool consumer for incomplete cleanup", async (t) => {
		if (process.platform === "win32") return t.skip("process groups require POSIX");
		const original = process.kill;
		process.kill = ((pid: number, signal?: string | number) => {
			if (pid >= 0) return original.call(process, pid, signal as NodeJS.Signals);
			return true;
		}) as typeof process.kill;
		try {
			const result = await runVectorTool("fixture", process.execPath, ["-e", "process.exit(0)"], {});
			strictEqual(result.kind, "error");
			strictEqual(result.details?.exitCode, 1);
		} finally {
			process.kill = original;
		}
	});

	it("releases inherited pipe endpoints at bounded settlement while the descendant remains alive", async (t) => {
		if (process.platform !== "linux") return t.skip("descriptor identity checks require procfs");
		const sockets = (): Set<string> =>
			new Set(
				readdirSync("/proc/self/fd").flatMap((fd) => {
					try {
						const target = readlinkSync(`/proc/self/fd/${fd}`);
						return target.startsWith("socket:") ? [target] : [];
					} catch {
						return [];
					}
				}),
			);
		const root = workspace();
		const pidFile = join(root, "survivor.pid");
		const before = sockets();
		const original = process.kill;
		const calls: Array<string | number | undefined> = [];
		process.kill = ((pid: number, signal?: string | number) => {
			if (pid >= 0 || signal === 0) return original.call(process, pid, signal as NodeJS.Signals);
			calls.push(signal);
			throw Object.assign(new Error("denied"), { code: "EPERM" });
		}) as typeof process.kill;
		let pid = 0;
		let owned: string[] = [];
		const controller = new AbortController();
		try {
			const result = await runCommandVector(
				process.execPath,
				[
					"-e",
					leaderWithResistantDescendant("process.exit(0);").replace(
						'stdio: "ignore"',
						'stdio: ["ignore", "inherit", "inherit"]',
					),
					pidFile,
				],
				{
					cwd: root,
					workspaceRoot: root,
					killGraceMs: 20,
					signal: controller.signal,
					output: {
						onStdout() {
							owned = [...sockets()].filter((target) => !before.has(target));
						},
					},
				},
			);
			pid = Number(readFileSync(pidFile, "utf8"));
			strictEqual(processState(pid), "running", "the descendant still holds the write ends");
			strictEqual(result.cleanupIncomplete, true);
			strictEqual(result.exitCode, 1);
			deepStrictEqual(result.leaderExit, { code: 0, signal: null });
			ok(owned.length >= 2, "both runner pipe endpoints existed during execution");
			await new Promise((resolve) => setImmediate(resolve));
			const after = sockets();
			for (const target of owned) ok(!after.has(target), `released ${target}`);
			const count = calls.length;
			controller.abort();
			await new Promise((resolve) => setTimeout(resolve, 75));
			strictEqual(calls.length, count, "abort and delayed close cannot reopen cleanup");
		} finally {
			process.kill = original;
			if (!pid) {
				try {
					pid = Number(readFileSync(pidFile, "utf8"));
				} catch {
					/* No descendant started. */
				}
			}
			if (pid) {
				reapFixture(pid);
				strictEqual(await settleProcessState(pid), "gone", "fixture was actually reaped");
			}
		}
	});
});

describe("post-exit pipe draining", () => {
	for (const cancel of [false, true]) {
		it(`settles escaped-group inherited pipes with ${cancel ? "post-exit cancellation" : "a drain deadline"}`, async (t) => {
			if (process.platform !== "linux") return t.skip("escaped groups and reaping assertions require Linux");
			const root = workspace();
			const pidFile = join(root, "escaped.pid");
			const controller = new AbortController();
			const original = process.kill;
			const calls: Array<string | number | undefined> = [];
			let abortTimer: ReturnType<typeof setTimeout> | undefined;
			let watchdog: ReturnType<typeof setTimeout> | undefined;
			let pid = 0;
			process.kill = ((target: number, signal?: string | number) => {
				if (target < 0) calls.push(signal);
				try {
					return original.call(process, target, signal as NodeJS.Signals);
				} catch (error) {
					if (cancel && target < 0 && (error as NodeJS.ErrnoException).code === "ESRCH") {
						abortTimer = setTimeout(() => controller.abort(), 100);
					}
					throw error;
				}
			}) as typeof process.kill;
			try {
				const run = runCommandVector(
					process.execPath,
					[
						"-e",
						leaderWithResistantDescendant("process.exit(0);").replace(
							'stdio: "ignore"',
							'detached: true, stdio: ["ignore", "inherit", "inherit"]',
						),
						pidFile,
					],
					{ cwd: root, workspaceRoot: root, timeoutMs: 300, signal: controller.signal, output: {} },
				);
				const result = await Promise.race([
					run,
					new Promise<never>((_, reject) => {
						watchdog = setTimeout(() => reject(new Error("pipe drain failed to settle")), 4000);
					}),
				]);
				pid = Number(readFileSync(pidFile, "utf8"));
				strictEqual(processState(pid), "running");
				strictEqual(result.exitCode, 1);
				deepStrictEqual(result.leaderExit, { code: 0, signal: null });
				strictEqual(result.aborted, cancel);
				strictEqual(result.timedOut, false);
				strictEqual(result.pipeDrainIncomplete, true);
				strictEqual(result.cleanupIncomplete, false, "original group disappeared");
				strictEqual(result.stdoutRetained, false);
				ok(result.failure?.includes("escaped processes are not contained"));
				deepStrictEqual(calls, [0], "ESRCH permanently closes access to the original group");
				ok(result.durationMs < (cancel ? 1000 : 2500));
				if (!cancel) ok(result.durationMs >= 1000);
				controller.abort();
				await new Promise((resolve) => setTimeout(resolve, 50));
				deepStrictEqual(calls, [0]);
			} finally {
				clearTimeout(abortTimer);
				clearTimeout(watchdog);
				process.kill = original;
				try {
					pid ||= Number(readFileSync(pidFile, "utf8"));
				} catch {
					/* No fixture started. */
				}
				if (pid) {
					reapFixture(pid);
					strictEqual(await settleProcessState(pid), "gone", "escaped fixture was actually reaped");
				}
			}
		});
	}

	it("drains buffered output completely before the deadline without marking it incomplete", async () => {
		const root = workspace();
		const bytes = 4 * 1024 * 1024;
		let received = 0;
		const result = await runCommandVector(
			process.execPath,
			["-e", `process.stdout.end(Buffer.alloc(${bytes}, 120)); process.stderr.end("done");`],
			{
				cwd: root,
				workspaceRoot: root,
				output: {
					onStdout(chunk) {
						received += chunk.length;
					},
				},
			},
		);
		strictEqual(result.exitCode, 0);
		strictEqual(result.pipeDrainIncomplete, false);
		strictEqual(received, bytes);
		strictEqual(result.stderr, "done");
	});
});

describe("process group cleanup window", () => {
	it("escalates SIGTERM, grace, SIGKILL and reports incomplete when members survive the bound", () => {
		const scheduler = new FakeScheduler();
		const { calls, done, hooks } = recordingHooks(() => true);
		const cleanup = createProcessGroupCleanup({ ...hooks, graceMs: 300, teardownBoundMs: 1000, scheduler });
		cleanup.kill();
		deepStrictEqual(calls, ["probe:members", "signal:SIGTERM"]);
		cleanup.kill();
		strictEqual(calls.length, 2, "a second kill request does not signal again");
		scheduler.advanceTo(299);
		strictEqual(calls.length, 2);
		scheduler.advanceTo(300);
		deepStrictEqual(calls.slice(2), ["probe:members", "signal:SIGKILL"]);
		cleanup.leaderExited();
		deepStrictEqual(calls.slice(4), ["probe:members"], "leader exit with members left starts polling");
		strictEqual(cleanup.done, false);
		scheduler.advanceTo(1300);
		strictEqual(cleanup.done, true);
		deepStrictEqual(done, [{ descendantsCleaned: true, incomplete: true }]);
		ok(everySignalFollowsAProbeWithMembers(calls), calls.join(" "));
		const settledCalls = calls.length;
		cleanup.kill();
		cleanup.leaderExited();
		scheduler.advanceTo(10_000);
		strictEqual(calls.length, settledCalls, "nothing is probed or signalled after the window closed");
		strictEqual(done.length, 1);
	});

	it("opens the window at an unexpected leader exit and closes it at the first ESRCH", () => {
		const scheduler = new FakeScheduler();
		let members = true;
		const { calls, done, hooks } = recordingHooks(() => members);
		const cleanup = createProcessGroupCleanup({ ...hooks, graceMs: 300, pollIntervalMs: 25, scheduler });
		cleanup.leaderExited();
		deepStrictEqual(calls, ["probe:members", "signal:SIGTERM"]);
		scheduler.advanceTo(25);
		deepStrictEqual(calls.slice(2), ["probe:members"], "the poll keeps probing while members remain");
		members = false;
		scheduler.advanceTo(50);
		deepStrictEqual(calls.slice(3), ["probe:gone"]);
		strictEqual(cleanup.done, true);
		deepStrictEqual(done, [{ descendantsCleaned: true, incomplete: false }]);
		scheduler.advanceTo(5000);
		strictEqual(calls.length, 4, "the grace timer was cleared and no SIGKILL follows ESRCH");
		ok(everySignalFollowsAProbeWithMembers(calls), calls.join(" "));
	});

	it("closes at once when the leader exits with no members left and never signals", () => {
		const scheduler = new FakeScheduler();
		const { calls, done, hooks } = recordingHooks(() => false);
		const cleanup = createProcessGroupCleanup({ ...hooks, graceMs: 300, scheduler });
		cleanup.leaderExited();
		deepStrictEqual(calls, ["probe:gone"]);
		deepStrictEqual(done, [{ descendantsCleaned: false, incomplete: false }]);
		cleanup.kill();
		scheduler.advanceTo(5000);
		deepStrictEqual(calls, ["probe:gone"], "a kill request after the window closed is inert");
	});

	it("closes for good when SIGTERM itself reports the group gone", () => {
		const scheduler = new FakeScheduler();
		const { calls, done, hooks } = recordingHooks(
			() => true,
			() => false,
		);
		const cleanup = createProcessGroupCleanup({ ...hooks, graceMs: 300, pollIntervalMs: 25, scheduler });
		cleanup.kill();
		deepStrictEqual(calls, ["probe:members", "signal:SIGTERM:gone"]);
		strictEqual(cleanup.done, true, "ESRCH at delivery is the first observation that the group is gone");
		deepStrictEqual(done, [{ descendantsCleaned: false, incomplete: false }]);
		strictEqual(scheduler.jobs.size, 0, "the grace timer was never armed");
		cleanup.leaderExited();
		cleanup.kill();
		scheduler.advanceTo(10_000);
		strictEqual(calls.length, 2, "no probe or signal follows a delivery-time ESRCH");
		strictEqual(done.length, 1);
	});

	it("closes for good when SIGKILL reports the group gone and arms no teardown bound", () => {
		const scheduler = new FakeScheduler();
		const { calls, done, hooks } = recordingHooks(
			() => true,
			(signalName) => signalName !== "SIGKILL",
		);
		const cleanup = createProcessGroupCleanup({ ...hooks, graceMs: 300, pollIntervalMs: 25, scheduler });
		cleanup.leaderExited();
		deepStrictEqual(calls, ["probe:members", "signal:SIGTERM"]);
		scheduler.advanceTo(300);
		// The poll fired at 25, 50, ... and the grace at 300: members every time, then SIGKILL reports ESRCH.
		strictEqual(calls.at(-1), "signal:SIGKILL:gone");
		strictEqual(calls.at(-2), "probe:members");
		strictEqual(cleanup.done, true);
		deepStrictEqual(done, [{ descendantsCleaned: true, incomplete: false }]);
		strictEqual(scheduler.jobs.size, 0, "the poll and the teardown bound were cancelled");
		const settledCalls = calls.length;
		scheduler.advanceTo(10_000);
		cleanup.leaderExited();
		cleanup.kill();
		strictEqual(calls.length, settledCalls, "nothing is probed or signalled after the window closed");
		ok(everySignalFollowsAProbeWithMembers(calls.map((call) => call.replace(/:gone$/u, ""))), calls.join(" "));
	});

	it("sends SIGTERM and SIGKILL in one step when the grace is zero", () => {
		const scheduler = new FakeScheduler();
		const { calls, hooks } = recordingHooks(() => true);
		createProcessGroupCleanup({ ...hooks, graceMs: 0, scheduler }).kill();
		deepStrictEqual(calls, ["probe:members", "signal:SIGTERM", "probe:members", "signal:SIGKILL"]);
	});
});
