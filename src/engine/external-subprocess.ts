import { spawn } from "node:child_process";
import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import {
	createProcessGroupCleanup,
	SAFE_EXEC_GROUP_TEARDOWN_BOUND_MS,
	SAFE_EXEC_PIPE_DRAIN_BOUND_MS,
} from "../core/safe-exec.js";
import type { ProcessGroupCleanupStatus } from "../core/safe-exec.js";
import { clampTimerDelayMs } from "../core/timers.js";
import { boundedExternalDiagnostic } from "../core/external-diagnostic.js";

export type SubprocessWithStdio = ChildProcessByStdio<null, Readable, Readable>;

export type BoundedLine = { kind: "line"; line: string } | { kind: "oversized" };

/**
 * Split a byte stream without ever retaining more than one bounded line.
 * Node has already allocated each incoming chunk, but an unterminated provider
 * line cannot make this decoder accumulate without limit.
 */
export async function* readBoundedLines(
	readable: Readable,
	options: { maxLineBytes: number; maxTotalBytes: number },
): AsyncGenerator<BoundedLine> {
	let segments: Buffer[] = [];
	let lineBytes = 0;
	let totalBytes = 0;
	let discarding = false;
	const finishLine = (): BoundedLine | null => {
		if (discarding) {
			segments = [];
			lineBytes = 0;
			discarding = false;
			return { kind: "oversized" };
		}
		if (lineBytes === 0) return { kind: "line", line: "" };
		const joined = Buffer.concat(segments, lineBytes);
		segments = [];
		lineBytes = 0;
		const end = joined.at(-1) === 0x0d ? joined.length - 1 : joined.length;
		return { kind: "line", line: joined.subarray(0, end).toString("utf8") };
	};

	for await (const raw of readable) {
		const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
		totalBytes += chunk.byteLength;
		if (totalBytes > options.maxTotalBytes) throw new Error("external stdout exceeded the cumulative output limit");
		let offset = 0;
		while (offset < chunk.length) {
			const newline = chunk.indexOf(0x0a, offset);
			const end = newline === -1 ? chunk.length : newline;
			const piece = chunk.subarray(offset, end);
			if (!discarding && piece.length > 0) {
				if (lineBytes + piece.length > options.maxLineBytes) {
					segments = [];
					lineBytes = 0;
					discarding = true;
				} else {
					segments.push(piece);
					lineBytes += piece.length;
				}
			}
			if (newline === -1) break;
			const line = finishLine();
			if (line) yield line;
			offset = newline + 1;
		}
	}
	if (discarding || lineBytes > 0) {
		const line = finishLine();
		if (line) yield line;
	}
}

export async function readStderr(child: { stderr: Readable }): Promise<string> {
	let tail = Buffer.alloc(0);
	for await (const chunk of child.stderr) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		tail = Buffer.concat([tail, bytes]);
		if (tail.byteLength > 8192) tail = tail.subarray(tail.byteLength - 8192);
	}
	return boundedExternalDiagnostic(tail.toString("utf8"));
}

export const EXTERNAL_PROCESS_KILL_GRACE_MS = 1500;

export interface ProcessTreeOutcome extends ProcessGroupCleanupStatus {
	exitCode: number;
	pipeDrainIncomplete: boolean;
}

export interface ProcessTreeTerminator {
	readonly completed: Promise<ProcessTreeOutcome>;
	terminate(): void;
	cleanup(): void;
}

type OwnedChild = {
	pid?: number | undefined;
	exitCode: number | null;
	kill(signal?: NodeJS.Signals): boolean;
	stdout?: Readable;
	stderr?: Readable;
	once?: ChildProcess["once"];
	off?: ChildProcess["off"];
	unref?(): void;
};

/** POSIX ownership ends only after group cleanup and bounded pipe draining. */
export function createProcessTreeTerminator(
	child: OwnedChild,
	graceMs = EXTERNAL_PROCESS_KILL_GRACE_MS,
	options: { platform?: NodeJS.Platform; spawn?: typeof spawn } = {},
): ProcessTreeTerminator {
	const platform = options.platform ?? process.platform;
	const spawnKiller = options.spawn ?? spawn;
	let sent = false;
	let finished = false;
	let closed = false;
	let exitCode = 1;
	let pipeDrainIncomplete = false;
	let drainTimer: ReturnType<typeof setTimeout> | undefined;
	let windowsTimer: ReturnType<typeof setTimeout> | undefined;
	let windowsBoundTimer: ReturnType<typeof setTimeout> | undefined;
	let status: ProcessGroupCleanupStatus | null = null;
	let resolveCompleted!: (outcome: ProcessTreeOutcome) => void;
	const completed = new Promise<ProcessTreeOutcome>((resolve) => { resolveCompleted = resolve; });
	const finish = (): void => {
		if (finished || status === null || (!closed && !pipeDrainIncomplete && !status.incomplete)) return;
		finished = true;
		if (drainTimer) clearTimeout(drainTimer);
		if (windowsTimer) clearTimeout(windowsTimer);
		if (windowsBoundTimer) clearTimeout(windowsBoundTimer);
		child.off?.("exit", onExit);
		child.off?.("close", onClose);
		child.off?.("error", onError);
		child.stdout?.destroy();
		child.stderr?.destroy();
		child.unref?.();
		resolveCompleted({ ...status, exitCode, pipeDrainIncomplete });
	};
	const probe = (): boolean => {
		if (!child.pid) return child.exitCode === null;
		try { process.kill(-child.pid, 0); return true; }
		catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
	};
	const signal = (name: NodeJS.Signals): boolean => {
		if (child.pid && platform !== "win32") {
			try { process.kill(-child.pid, name); return true; }
			catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
		}
		if (platform === "win32" && child.pid !== undefined && Number.isSafeInteger(child.pid) && child.pid > 0) {
			const args = ["/PID", String(child.pid), "/T", ...(name === "SIGKILL" ? ["/F"] : [])];
			const killer = spawnKiller("taskkill.exe", args, { stdio: "ignore", windowsHide: true });
			killer.once("error", () => {
				if (!finished && child.exitCode === null) child.kill(name);
			});
			return true;
		}
		return child.exitCode === null && child.kill(name);
	};
	const group = platform === "win32" ? null : createProcessGroupCleanup({
		graceMs: clampTimerDelayMs(graceMs),
		probe,
		signal,
		onDone: (outcome) => { status = outcome; finish(); },
	});
	const onExit = (code: number | null): void => {
		exitCode = code ?? 1;
		drainTimer = setTimeout(() => {
			pipeDrainIncomplete = Boolean(
				(child.stdout && !child.stdout.readableEnded) || (child.stderr && !child.stderr.readableEnded),
			);
			child.stdout?.destroy();
			child.stderr?.destroy();
			finish();
		}, SAFE_EXEC_PIPE_DRAIN_BOUND_MS);
		if (group) group.leaderExited();
	};
	const onClose = (code: number | null): void => {
		closed = true;
		exitCode = code ?? exitCode;
		if (!group) {
			if (windowsTimer) { clearTimeout(windowsTimer); windowsTimer = undefined; signal("SIGKILL"); }
			status = { descendantsCleaned: sent, incomplete: false };
		}
		finish();
	};
	const onError = (): void => {
		if (child.pid) { terminate(); return; }
		group?.dispose();
		closed = true;
		status = { descendantsCleaned: false, incomplete: false };
		finish();
	};
	const terminate = (): void => {
		if (finished || sent) return;
		sent = true;
		if (group) { group.kill(); return; }
		signal("SIGTERM");
		windowsTimer = setTimeout(() => {
			windowsTimer = undefined;
			signal("SIGKILL");
			windowsBoundTimer = setTimeout(() => {
				status = { descendantsCleaned: sent, incomplete: !closed };
				finish();
			}, SAFE_EXEC_GROUP_TEARDOWN_BOUND_MS);
		}, clampTimerDelayMs(graceMs));
	};
	child.once?.("exit", onExit);
	child.once?.("close", onClose);
	child.once?.("error", onError);
	return {
		completed,
		terminate,
		cleanup() {
			if (group) return;
			// Windows callers retain the taskkill force path when closing early.
			if (windowsTimer) {
				clearTimeout(windowsTimer);
				windowsTimer = undefined;
				signal("SIGKILL");
			}
			if (drainTimer) clearTimeout(drainTimer);
			if (windowsBoundTimer) clearTimeout(windowsBoundTimer);
		},
	};
}

