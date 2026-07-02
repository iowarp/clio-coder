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

		const child = spawn(file, [...args], {
			cwd: options.cwd ?? process.cwd(),
			env: buildSafeToolEnv(),
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
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
