import { spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { AI_AGENT_NAME } from "./agent-environment.js";
import {
	gitCommitAttributionEnabled,
	reportCommitAttributionDiagnostic,
	withManagedGitCommitAttributionEnvironment,
} from "./git-commit-attribution.js";
import { clampTimerDelayMs } from "./timers.js";

export const SAFE_EXEC_DEFAULT_TIMEOUT_MS = 120_000;
export const SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES = 600_000;

const ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"TEMP",
	"TMP",
	"CI",
	"NO_COLOR",
	// Platform/session location variables needed by installed local CLIs. These
	// locate operator-owned state; provider keys and Clio gates are deliberately
	// absent from this allowlist.
	"XDG_CONFIG_HOME",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
	"APPDATA",
	"LOCALAPPDATA",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
] as const;

export interface SafeCommandResult {
	file: string;
	args: string[];
	cwd: string;
	/**
	 * Captured stdout. Without an output sink this is every byte up to the
	 * cap; with one it is the bounded head-and-tail rendering, and
	 * `stdoutRetained` says whether anything was omitted between them.
	 */
	stdout: string;
	stderr: string;
	/** Effective exit code; incomplete group cleanup or pipe draining converts leader exit 0 to 1. */
	exitCode: number | null;
	/** Actual leader outcome, or null if it had not exited at settlement. */
	leaderExit?: { code: number | null; signal: NodeJS.Signals | null } | null;
	signal: NodeJS.Signals | null;
	aborted: boolean;
	timedOut: boolean;
	outputCapped: boolean;
	durationMs: number;
	/** Wall-clock instant the child was spawned. Optional only so hand-built test doubles stay valid. */
	startedAt?: number;
	/** Exact bytes the child wrote to stdout, whether or not they were all retained. */
	stdoutBytes?: number;
	stderrBytes?: number;
	/** True when `stdout` holds every byte the child wrote to it. */
	stdoutRetained?: boolean;
	stderrRetained?: boolean;
	/** The output sink threw; forwarding stopped there and the child was terminated. */
	sinkError?: string;
	/** Members of the child's process group outlived the leader and the runner had to signal them. */
	descendantsCleaned?: boolean;
	/** Group members were still present when the post-SIGKILL bound passed; the runner stopped waiting for them. */
	cleanupIncomplete?: boolean;
	/** Owned output pipes did not drain before the post-exit deadline or cancellation. */
	pipeDrainIncomplete?: boolean;
	/** Diagnostic for incomplete cleanup; the effective exit code also reports failure to existing callers. */
	failure?: string | null;
}

/**
 * Where a command's complete output goes when it must not live in memory. The
 * runner forwards every chunk synchronously in arrival order and keeps only a
 * bounded head and tail of each stream for the result. With a sink present
 * the output cap does not apply: the sink is the unbounded destination and
 * the retained windows are the memory bound.
 */
export interface SafeCommandOutputSink {
	onStdout?(chunk: Buffer): void;
	onStderr?(chunk: Buffer): void;
	/** Leading bytes of each stream kept on the result (default 4096). */
	retainHeadBytes?: number;
	/** Trailing bytes of each stream kept on the result (default 16384). */
	retainTailBytes?: number;
}

export const SAFE_EXEC_DEFAULT_RETAIN_HEAD_BYTES = 4096;
export const SAFE_EXEC_DEFAULT_RETAIN_TAIL_BYTES = 16 * 1024;
/** Time the process group gets after SIGTERM before SIGKILL follows. */
export const SAFE_EXEC_DEFAULT_KILL_GRACE_MS = 3000;
/** After SIGKILL, how long the runner waits for the group to disappear before it gives up and says so. */
export const SAFE_EXEC_GROUP_TEARDOWN_BOUND_MS = 1000;
/** Maximum time to drain inherited output pipes after leader exit. */
export const SAFE_EXEC_PIPE_DRAIN_BOUND_MS = 1000;
const GROUP_POLL_INTERVAL_MS = 25;

export interface RunCommandVectorOptions {
	cwd?: string;
	workspaceRoot?: string;
	timeoutMs?: number;
	/** Combined stdout+stderr ceiling when no sink is given; crossing it kills the child. Ignored with a sink. */
	maxOutputBytes?: number;
	signal?: AbortSignal;
	env?: Record<string, string>;
	output?: SafeCommandOutputSink;
	/**
	 * Milliseconds between SIGTERM and SIGKILL when the runner stops the
	 * process group (default 3000). Zero sends both at once.
	 */
	killGraceMs?: number;
}

/** Drop a trailing incomplete UTF-8 sequence so the bytes decode without a replacement character. */
function trimIncompleteUtf8Suffix(bytes: Buffer): Buffer {
	const length = bytes.byteLength;
	for (let back = 1; back <= 3 && back <= length; back += 1) {
		const byte = bytes[length - back] as number;
		if ((byte & 0xc0) === 0x80) continue;
		const expected = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		return expected > back ? bytes.subarray(0, length - back) : bytes;
	}
	return bytes;
}

/** Drop leading continuation bytes so a window that starts mid-character decodes cleanly. */
function trimLeadingUtf8Continuation(bytes: Buffer): Buffer {
	let start = 0;
	while (start < bytes.byteLength && start < 4 && ((bytes[start] as number) & 0xc0) === 0x80) start += 1;
	return start === 0 ? bytes : bytes.subarray(start);
}

export interface RetainedStreamRendering {
	text: string;
	/** True when the text carries every byte the stream produced. */
	retained: boolean;
	totalBytes: number;
	omittedBytes: number;
}

/**
 * Bounded head-and-tail window over a byte stream. Memory stays at
 * head + tail + one chunk whatever the stream's length, and the rendering
 * names exactly how many bytes fell between the two windows.
 */
export interface RetainedStreamWindow {
	append(chunk: Buffer): void;
	readonly totalBytes: number;
	render(): RetainedStreamRendering;
}

export function createRetainedStreamWindow(headCapBytes: number, tailCapBytes: number): RetainedStreamWindow {
	const headCap = Math.max(0, Math.floor(headCapBytes));
	const tailCap = Math.max(0, Math.floor(tailCapBytes));
	const head: Buffer[] = [];
	let headBytes = 0;
	const tail: Buffer[] = [];
	let tailBytes = 0;
	let total = 0;
	return {
		get totalBytes() {
			return total;
		},
		append(chunk) {
			total += chunk.byteLength;
			let rest = chunk;
			if (headBytes < headCap) {
				const take = Math.min(rest.byteLength, headCap - headBytes);
				head.push(rest.subarray(0, take));
				headBytes += take;
				if (take === rest.byteLength) return;
				rest = rest.subarray(take);
			}
			if (tailCap === 0) return;
			tail.push(rest);
			tailBytes += rest.byteLength;
			while (tailBytes > tailCap && tail.length > 0) {
				const first = tail[0] as Buffer;
				const excess = tailBytes - tailCap;
				if (first.byteLength <= excess) {
					tail.shift();
					tailBytes -= first.byteLength;
				} else {
					tail[0] = first.subarray(excess);
					tailBytes -= excess;
				}
			}
		},
		render() {
			if (total - headBytes - tailBytes <= 0) {
				const text = Buffer.concat([...head, ...tail]).toString("utf8");
				return { text, retained: true, totalBytes: total, omittedBytes: 0 };
			}
			// Bytes trimmed at a character boundary are absent from the text too,
			// so the marker counts them with the span between the windows.
			const headShown = trimIncompleteUtf8Suffix(Buffer.concat(head));
			const tailShown = trimLeadingUtf8Continuation(Buffer.concat(tail));
			const omitted = total - headShown.byteLength - tailShown.byteLength;
			const headText = headShown.toString("utf8");
			const tailText = tailShown.toString("utf8");
			const marker = `[... ${omitted} bytes omitted ...]`;
			const text = headText.length > 0 ? `${headText}\n${marker}\n${tailText}` : `${marker}\n${tailText}`;
			return { text, retained: false, totalBytes: total, omittedBytes: omitted };
		},
	};
}

export interface ProcessGroupCleanupStatus {
	/** The group still had members after the leader was reaped, and the runner signalled them. */
	descendantsCleaned: boolean;
	/** The teardown bound passed after SIGKILL with members still present; the runner stopped waiting. */
	incomplete: boolean;
}

export interface ProcessGroupCleanupScheduler {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface ProcessGroupCleanupHooks {
	/** Existence probe (`kill(-pgid, 0)`): true while any member remains, false only on ESRCH. */
	probe(): boolean;
	/**
	 * Deliver one signal to the group. Called only right after a probe that
	 * reported members. Returns false when the group was already gone (ESRCH),
	 * which closes the window exactly as a probe reporting ESRCH would.
	 */
	signal(signalName: NodeJS.Signals): boolean;
	/** Called exactly once, when the window closes; nothing is probed or signalled afterwards. */
	onDone(status: ProcessGroupCleanupStatus): void;
	/** Milliseconds between SIGTERM and SIGKILL; zero sends both in one step. */
	graceMs: number;
	/** Milliseconds to wait for members after SIGKILL before giving up (default 1000). */
	teardownBoundMs?: number | undefined;
	pollIntervalMs?: number | undefined;
	scheduler?: ProcessGroupCleanupScheduler | undefined;
}

export interface ProcessGroupCleanup {
	readonly done: boolean;
	readonly status: ProcessGroupCleanupStatus | null;
	/** A kill was requested (timeout, cancellation, cap, sink failure): open the window with SIGTERM now. */
	kill(): void;
	/** The leader was reaped: if members remain they are cleaned up on the same schedule until none are left. */
	leaderExited(): void;
	/** Stop without signalling and without `onDone`; for a child that never started. */
	dispose(): void;
}

const SYSTEM_CLEANUP_SCHEDULER: ProcessGroupCleanupScheduler = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Bounded cleanup of one process group. The window opens at kill time or at
 * leader exit, whichever comes first, and runs SIGTERM, grace, SIGKILL, then
 * a bounded wait for the group to disappear. Every signal follows an
 * existence probe in the same synchronous step, the first observation that
 * the group is gone (ESRCH from a probe or from a signal) closes the window
 * for good, and no path that runs after the window closed probes or signals
 * again.
 *
 * Residual hazard, accepted: Linux keeps a PGID reserved while any member of
 * the group lives, so a signal can only reach an unrelated group if every
 * member dies between the probe and the signal that immediately follows it.
 * `bash-exec.ts` and the ACP transport share this window; the gateway MCP
 * client follows the same rules.
 */
export function createProcessGroupCleanup(hooks: ProcessGroupCleanupHooks): ProcessGroupCleanup {
	const scheduler = hooks.scheduler ?? SYSTEM_CLEANUP_SCHEDULER;
	const graceMs = Math.max(0, hooks.graceMs);
	const teardownBoundMs = Math.max(0, hooks.teardownBoundMs ?? SAFE_EXEC_GROUP_TEARDOWN_BOUND_MS);
	const pollIntervalMs = Math.max(1, hooks.pollIntervalMs ?? GROUP_POLL_INTERVAL_MS);
	let phase: "idle" | "terminating" | "killing" | "done" = "idle";
	let leaderGone = false;
	let descendantsCleaned = false;
	let status: ProcessGroupCleanupStatus | null = null;
	let graceTimer: unknown = null;
	let boundTimer: unknown = null;
	let pollTimer: unknown = null;

	const isDone = (): boolean => phase === "done";

	const clearTimers = (): void => {
		for (const handle of [graceTimer, boundTimer, pollTimer]) if (handle !== null) scheduler.clearTimeout(handle);
		graceTimer = null;
		boundTimer = null;
		pollTimer = null;
	};

	const complete = (incomplete: boolean): void => {
		if (phase === "done") return;
		phase = "done";
		clearTimers();
		status = { descendantsCleaned, incomplete };
		hooks.onDone(status);
	};

	/** One probe. A group that is gone closes the window here; nothing is sent after this returns false. */
	const membersRemain = (): boolean => {
		if (hooks.probe()) return true;
		complete(false);
		return false;
	};

	/** One signal. ESRCH at delivery is the same observation as ESRCH from a probe and closes the window too. */
	const deliver = (signalName: NodeJS.Signals): boolean => {
		if (hooks.signal(signalName)) return true;
		complete(false);
		return false;
	};

	const escalate = (): void => {
		graceTimer = null;
		if (phase === "done" || !membersRemain()) return;
		phase = "killing";
		if (!deliver("SIGKILL")) return;
		boundTimer = scheduler.setTimeout(() => {
			boundTimer = null;
			if (phase === "done") return;
			if (membersRemain()) complete(true);
		}, teardownBoundMs);
	};

	/** Open with SIGTERM. `probed` says the caller already saw members in this same synchronous step. */
	const openWindow = (probed: boolean): void => {
		if (phase !== "idle") return;
		if (!probed && !membersRemain()) return;
		phase = "terminating";
		if (!deliver("SIGTERM")) return;
		if (graceMs > 0) graceTimer = scheduler.setTimeout(escalate, graceMs);
		else escalate();
	};

	const poll = (): void => {
		pollTimer = scheduler.setTimeout(() => {
			pollTimer = null;
			if (phase === "done") return;
			if (membersRemain()) poll();
		}, pollIntervalMs);
	};

	return {
		get done() {
			return phase === "done";
		},
		get status() {
			return status;
		},
		kill() {
			if (phase === "done") return;
			openWindow(false);
		},
		leaderExited() {
			if (phase === "done" || leaderGone) return;
			leaderGone = true;
			if (!membersRemain()) return;
			// Only descendants can be left now: the leader was reaped before this call.
			descendantsCleaned = true;
			openWindow(true);
			if (!isDone()) poll();
		},
		dispose() {
			if (phase === "done") return;
			phase = "done";
			clearTimers();
		},
	};
}

export function buildSafeToolEnv(
	extra: Record<string, string> = {},
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ENV_ALLOWLIST) {
		const value = source[key];
		if (value !== undefined) env[key] = value;
	}
	for (const [key, value] of Object.entries(extra)) {
		if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
		env[key] = value;
	}
	env.AI_AGENT = AI_AGENT_NAME;
	return env;
}

export function resolveSafeCwd(cwd: string | undefined, workspaceRoot: string = process.cwd()): string {
	const root = path.resolve(workspaceRoot);
	const resolved = cwd === undefined ? root : path.isAbsolute(cwd) ? path.resolve(cwd) : path.resolve(root, cwd);
	const rel = path.relative(root, resolved);
	if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return resolved;
	throw new Error(`cwd escapes workspace root: ${resolved}`);
}

export function runCommandVector(
	file: string,
	args: ReadonlyArray<string>,
	options: RunCommandVectorOptions = {},
): Promise<SafeCommandResult> {
	return new Promise((resolve) => {
		const startedAtClock = performance.now();
		const startedAt = Date.now();
		const cwd = resolveSafeCwd(options.cwd, options.workspaceRoot);
		const timeoutMs = clampTimerDelayMs(options.timeoutMs ?? SAFE_EXEC_DEFAULT_TIMEOUT_MS);
		const killGraceMs = clampTimerDelayMs(options.killGraceMs ?? SAFE_EXEC_DEFAULT_KILL_GRACE_MS);
		const maxOutputBytes = options.maxOutputBytes ?? SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES;
		const sink = options.output;
		const stdoutWindow =
			sink === undefined
				? null
				: createRetainedStreamWindow(
						sink.retainHeadBytes ?? SAFE_EXEC_DEFAULT_RETAIN_HEAD_BYTES,
						sink.retainTailBytes ?? SAFE_EXEC_DEFAULT_RETAIN_TAIL_BYTES,
					);
		const stderrWindow =
			sink === undefined
				? null
				: createRetainedStreamWindow(
						sink.retainHeadBytes ?? SAFE_EXEC_DEFAULT_RETAIN_HEAD_BYTES,
						sink.retainTailBytes ?? SAFE_EXEC_DEFAULT_RETAIN_TAIL_BYTES,
					);
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let sinkError: string | null = null;
		const attribution = withManagedGitCommitAttributionEnvironment(buildSafeToolEnv(options.env), {
			cwd,
			enabled: gitCommitAttributionEnabled(process.env),
		});
		reportCommitAttributionDiagnostic(attribution.diagnostic);
		let aborted = false;
		let timedOut = false;
		let outputCapped = false;
		let outputBytes = 0;
		let stdout = "";
		let stderr = "";
		let settled = false;
		const captured = (): Pick<
			SafeCommandResult,
			"stdout" | "stderr" | "stdoutBytes" | "stderrBytes" | "stdoutRetained" | "stderrRetained" | "sinkError"
		> => {
			if (stdoutWindow === null || stderrWindow === null) {
				return {
					stdout,
					stderr,
					stdoutBytes,
					stderrBytes,
					stdoutRetained: !outputCapped,
					stderrRetained: !outputCapped,
					...(sinkError === null ? {} : { sinkError }),
				};
			}
			const out = stdoutWindow.render();
			const err = stderrWindow.render();
			return {
				stdout: out.text,
				stderr: err.text,
				stdoutBytes,
				stderrBytes,
				stdoutRetained: out.retained,
				stderrRetained: err.retained,
				...(sinkError === null ? {} : { sinkError }),
			};
		};
		let timeoutId: ReturnType<typeof setTimeout> | null = null;
		let leaderExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
		let closed = false;
		let pipeDrainIncomplete = false;
		let drainTimer: ReturnType<typeof setTimeout> | null = null;

		const child = spawn(file, [...args], {
			cwd,
			env: attribution.env,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});

		const onAbort = (): void => {
			aborted = true;
			killChild();
			if (leaderExit !== null) stopDraining();
		};

		// Where process groups exist the child leads its own, and the probe and
		// the signals address the whole group. Elsewhere only the direct child
		// is reachable, and "members remain" means the leader is still running.
		const groupProbe = (): boolean => {
			const pid = child.pid;
			if (!pid) return false;
			if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
			try {
				process.kill(-pid, 0);
				return true;
			} catch (error) {
				// ESRCH means no member is left. EPERM means one exists that this
				// process may not signal; it still counts as present.
				return (error as NodeJS.ErrnoException).code !== "ESRCH";
			}
		};

		const groupSignal = (signalName: NodeJS.Signals): boolean => {
			const pid = child.pid;
			if (pid && process.platform !== "win32") {
				try {
					process.kill(-pid, signalName);
					return true;
				} catch (error) {
					// ESRCH: the group vanished between the probe and this signal, so
					// the window closes here. Anything else (EPERM) leaves members the
					// runner cannot reach; retain the bounded cleanup window so its
					// final probe reports what remains. Direct-child absence does not
					// establish group absence.
					if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
					return true;
				}
			}
			// Without a group only the direct child is addressable; once it has
			// exited there is nothing left to clean.
			return child.kill(signalName);
		};

		const cleanup = createProcessGroupCleanup({
			graceMs: killGraceMs,
			probe: groupProbe,
			signal: groupSignal,
			onDone: () => tryFinish(),
		});

		const killChild = (): void => cleanup.kill();

		const finish = (exitCode: number | null, signalName: NodeJS.Signals | null, spawnError?: Error): void => {
			if (settled) return;
			settled = true;
			if (drainTimer) clearTimeout(drainTimer);
			drainTimer = null;
			if (timeoutId) clearTimeout(timeoutId);
			timeoutId = null;
			cleanup.dispose();
			options.signal?.removeEventListener("abort", onAbort);
			// Descendants may retain the write ends indefinitely. Release our read
			// ends and process handle even when settlement bypasses close.
			child.stdout?.destroy();
			child.stderr?.destroy();
			child.unref();
			const output = captured();
			resolve({
				file,
				args: [...args],
				cwd,
				...output,
				...(pipeDrainIncomplete ? { stdoutRetained: false, stderrRetained: false } : {}),
				stderr: output.stderr.length === 0 && spawnError !== undefined ? spawnError.message : output.stderr,
				exitCode: (cleanup.status?.incomplete === true || pipeDrainIncomplete) && exitCode === 0 ? 1 : exitCode,
				leaderExit,
				signal: signalName,
				aborted,
				timedOut,
				outputCapped,
				durationMs: Math.round(performance.now() - startedAtClock),
				startedAt,
				descendantsCleaned: cleanup.status?.descendantsCleaned ?? false,
				cleanupIncomplete: cleanup.status?.incomplete ?? false,
				pipeDrainIncomplete,
				failure:
					cleanup.status?.incomplete === true
						? `process group cleanup incomplete: members were still present ${SAFE_EXEC_GROUP_TEARDOWN_BOUND_MS}ms after SIGKILL`
						: pipeDrainIncomplete
							? "output pipe draining incomplete after leader exit; logs may be incomplete and escaped processes are not contained"
							: null,
			});
		};

		const stopDraining = (): void => {
			if (settled) return;
			if (!child.stdout?.readableEnded || !child.stderr?.readableEnded) {
				pipeDrainIncomplete = true;
				child.stdout?.destroy();
				child.stderr?.destroy();
			}
			tryFinish();
		};

		/**
		 * Settlement normally waits for both closed streams and group cleanup.
		 * An incomplete group teardown or pipe-drain deadline permits bounded
		 * settlement with the bytes received so far and an unsuccessful result.
		 * Neither path reopens group access after ESRCH.
		 */
		function tryFinish(): void {
			if (settled || !cleanup.done) return;
			if (!closed && cleanup.status?.incomplete !== true && !pipeDrainIncomplete) return;
			finish(leaderExit?.code ?? null, leaderExit?.signal ?? null);
		}

		if (timeoutMs > 0) {
			timeoutId = setTimeout(() => {
				timedOut = true;
				killChild();
			}, timeoutMs);
		}
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });

		const appendChunk = (target: "stdout" | "stderr", chunk: Buffer): void => {
			if (settled) return;
			// Every byte the child wrote counts, whatever happens to it next: the
			// counters say what was received, the retained flags say what was kept.
			if (target === "stdout") stdoutBytes += chunk.byteLength;
			else stderrBytes += chunk.byteLength;
			if (sink !== undefined && stdoutWindow !== null && stderrWindow !== null) {
				// The bounded window keeps observing so the result's tail and the
				// retained flag stay honest; a failed sink receives nothing more.
				(target === "stdout" ? stdoutWindow : stderrWindow).append(chunk);
				if (sinkError !== null) return;
				try {
					if (target === "stdout") sink.onStdout?.(chunk);
					else sink.onStderr?.(chunk);
				} catch (error) {
					sinkError = error instanceof Error ? error.message : String(error);
					killChild();
				}
				return;
			}
			if (outputCapped) return;
			outputBytes += chunk.byteLength;
			if (outputBytes > maxOutputBytes) {
				outputCapped = true;
				killChild();
				return;
			}
			if (target === "stdout") stdout += chunk.toString("utf8");
			else stderr += chunk.toString("utf8");
		};

		child.stdout?.on("data", (chunk: Buffer) => appendChunk("stdout", chunk));
		child.stderr?.on("data", (chunk: Buffer) => appendChunk("stderr", chunk));
		child.on("error", (error) => finish(null, null, error));
		child.on("exit", (code, signalName) => {
			if (settled || leaderExit !== null) return;
			leaderExit = { code, signal: signalName };
			// Execution timeout ends here, but cancellation remains active through
			// settlement. Escaped descendants can retain pipes after group ESRCH.
			if (timeoutId) clearTimeout(timeoutId);
			timeoutId = null;
			drainTimer = setTimeout(stopDraining, SAFE_EXEC_PIPE_DRAIN_BOUND_MS);
			cleanup.leaderExited();
			if (aborted) stopDraining();
		});
		child.on("close", () => {
			if (settled || closed) return;
			closed = true;
			tryFinish();
		});
	});
}

export function combineSafeOutput(result: Pick<SafeCommandResult, "stdout" | "stderr">): string {
	const { stdout, stderr } = result;
	return stderr.length > 0 ? `${stdout}${stdout.endsWith("\n") || stdout.length === 0 ? "" : "\n"}${stderr}` : stdout;
}
