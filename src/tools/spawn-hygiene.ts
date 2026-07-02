import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { buildSafeToolEnv } from "../core/safe-exec.js";

/**
 * Hygienic line-stream spawner for the search binaries (rg, fd). Matches the
 * containment posture of src/core/safe-exec.ts that git/verify already get:
 * allowlisted env, cwd pinned to the workspace root, a wall-clock timeout,
 * and SIGTERM-then-SIGKILL process-group teardown. Callers consume stdout
 * line-by-line and may stop early (match limit reached) without waiting for
 * the child to drain.
 */

export const SEARCH_SPAWN_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 3_000;
const STDERR_CAP_BYTES = 16 * 1024;

/**
 * Per-argument byte ceiling for the search binaries. Linux caps a single argv
 * entry at MAX_ARG_STRLEN (PAGE_SIZE * 32 = 128 KiB); handing spawn a longer
 * string throws a raw `spawn E2BIG` before the child ever runs. The search
 * tools guard their one unbounded argument — the caller-supplied pattern — well
 * under that so an oversized pattern returns a bounded validation error instead
 * of leaking the platform fault, and the pure-Node fallbacks never compile a
 * multi-hundred-KB regex either. 64 KiB is far past any real search pattern.
 */
export const MAX_SEARCH_PATTERN_BYTES = 64 * 1024;

/**
 * Validate a search pattern's byte size before it reaches spawn (or a fallback
 * regex compile). Returns the caller-agnostic message body; each searcher
 * prefixes it with its own tool name.
 */
export function validateSearchPatternSize(pattern: string): { ok: true } | { ok: false; message: string } {
	const bytes = Buffer.byteLength(pattern, "utf8");
	if (bytes <= MAX_SEARCH_PATTERN_BYTES) return { ok: true };
	return {
		ok: false,
		message: `pattern too large (${bytes} bytes; max ${MAX_SEARCH_PATTERN_BYTES}). Narrow the pattern before searching.`,
	};
}

export interface LineStreamOptions {
	/** Spawn cwd; defaults to the workspace root (process.cwd()). */
	cwd?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Called per stdout line. Invoke `stop()` to kill the child early. */
	onLine(line: string, stop: () => void): void;
}

export interface LineStreamResult {
	exitCode: number | null;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
	/** True when the caller's `stop()` killed the child (not an error). */
	stoppedEarly: boolean;
	/** Spawn-level failure (binary missing, EACCES); null when the child ran. */
	spawnError: string | null;
}

export function spawnLineStream(
	file: string,
	args: ReadonlyArray<string>,
	options: LineStreamOptions,
): Promise<LineStreamResult> {
	return new Promise((resolve) => {
		const timeoutMs = options.timeoutMs ?? SEARCH_SPAWN_TIMEOUT_MS;
		let timedOut = false;
		let aborted = false;
		let stoppedEarly = false;
		let killSent = false;
		let settled = false;
		let stderr = "";
		let killGraceTimer: ReturnType<typeof setTimeout> | null = null;

		// spawn can throw synchronously (e.g. an argv entry over MAX_ARG_STRLEN
		// raises E2BIG). Route that through the documented spawnError channel so
		// callers see a spawn-level failure instead of a rejected promise; the
		// search tools validate pattern size up front, so this is a backstop. The
		// IIFE keeps the child's narrowed stdio typing (non-null stdout) that an
		// explicit ReturnType<typeof spawn> annotation would widen away.
		const spawned = (() => {
			try {
				return {
					ok: true as const,
					child: spawn(file, [...args], {
						cwd: options.cwd ?? process.cwd(),
						env: buildSafeToolEnv(),
						detached: process.platform !== "win32",
						stdio: ["ignore", "pipe", "pipe"],
					}),
				};
			} catch (error) {
				return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
			}
		})();
		if (!spawned.ok) {
			resolve({
				exitCode: null,
				stderr: "",
				timedOut: false,
				aborted: false,
				stoppedEarly: false,
				spawnError: spawned.message,
			});
			return;
		}
		const child = spawned.child;
		const rl = createInterface({ input: child.stdout });

		const sendSignal = (signalName: NodeJS.Signals): void => {
			const pid = child.pid;
			if (pid && process.platform !== "win32") {
				try {
					process.kill(-pid, signalName);
					return;
				} catch {
					// Fall through to killing the direct child.
				}
			}
			child.kill(signalName);
		};

		const killChild = (): void => {
			if (killSent) return;
			killSent = true;
			sendSignal("SIGTERM");
			killGraceTimer = setTimeout(() => sendSignal("SIGKILL"), KILL_GRACE_MS);
			killGraceTimer.unref?.();
		};

		const stop = (): void => {
			if (stoppedEarly) return;
			stoppedEarly = true;
			killChild();
		};

		const onAbort = (): void => {
			aborted = true;
			killChild();
		};

		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			killChild();
		}, timeoutMs);
		timeoutTimer.unref?.();
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });

		const finish = (spawnError: string | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			if (killGraceTimer) clearTimeout(killGraceTimer);
			options.signal?.removeEventListener("abort", onAbort);
			rl.close();
			resolve({
				exitCode: child.exitCode,
				stderr,
				timedOut,
				aborted,
				stoppedEarly,
				spawnError,
			});
		};

		rl.on("line", (line) => {
			// Lines buffered before an early stop still flush through readline;
			// they no longer count once the caller decided it has enough.
			if (stoppedEarly || aborted || timedOut) return;
			options.onLine(line, stop);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < STDERR_CAP_BYTES) stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => finish(error.message));
		child.on("close", () => finish(null));
	});
}
