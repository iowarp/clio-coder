import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { buildSafeToolEnv } from "../core/safe-exec.js";
import { truncateUtf8 } from "./truncate-utf8.js";

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
export const SEARCH_STDERR_CAP_BYTES = 16 * 1024;
const timeoutContext = new AsyncLocalStorage<number>();

/** Leave an incomplete trailing code point undecoded, and bound replacement text for invalid input. */
function decodeBoundedUtf8(buffer: Buffer): string {
	const decoded = new StringDecoder("utf8").write(buffer);
	return truncateUtf8(decoded, SEARCH_STDERR_CAP_BYTES, "");
}

/** Scope a shorter process deadline without changing tool arguments or concurrent calls. */
export function withSearchTimeout<T>(timeoutMs: number, run: () => T): T {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid search timeout");
	return timeoutContext.run(timeoutMs, run);
}

/** Decode UTF-8 lines incrementally with one fixed-size byte buffer, including without newlines. */
export class BoundedDiagnosticDecoder {
	private readonly buffer = Buffer.alloc(SEARCH_STDERR_CAP_BYTES);
	private used = 0;
	private truncated = false;
	oversizedLines = 0;
	constructor(private readonly onLine: (line: string, truncated: boolean) => void) {}
	get bufferedBytes(): number {
		return this.used;
	}
	write(chunk: Buffer): void {
		let start = 0;
		while (start < chunk.length) {
			const newline = chunk.indexOf(10, start);
			const end = newline < 0 ? chunk.length : newline;
			const take = Math.min(end - start, this.buffer.length - this.used);
			chunk.copy(this.buffer, this.used, start, start + take);
			this.used += take;
			if (take < end - start) this.truncated = true;
			if (newline < 0) break;
			this.flush();
			start = newline + 1;
		}
	}
	end(): void {
		if (this.used || this.truncated) this.flush();
	}
	private flush(): void {
		if (this.truncated) this.oversizedLines++;
		this.onLine(decodeBoundedUtf8(this.buffer.subarray(0, this.used)).replace(/\r$/, ""), this.truncated);
		this.used = 0;
		this.truncated = false;
	}
}

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

export interface SearchCompleteness {
	complete: boolean;
	reason?: "timeout" | "errors" | "limit" | "cancelled";
	skipped: { count: number; samples: string[]; unknown?: boolean };
}

export function newSearchCompleteness(): SearchCompleteness {
	return { complete: true, skipped: { count: 0, samples: [] } };
}

export function skipSearchPath(
	search: SearchCompleteness,
	path: string,
	allows: (path: string) => boolean = () => true,
): void {
	search.complete = false;
	search.reason ??= "errors";
	search.skipped.count += 1;
	if (allows(path) && search.skipped.samples.length < 5) search.skipped.samples.push(path);
}

/** Parse the path prefix, independently of the language used for OS error text. */
export function searchDiagnosticPath(line: string): string | null {
	const cleaned = line.replace(/^(?:rg: |\[fd error\]:? )/, "").replace(/^IO error for operation on /, "");
	if (/^(?:regex parse error|error parsing (?:glob|regex)|invalid (?:glob|regex)|error:|Usage:)/i.test(cleaned))
		return null;
	// Skip a Windows drive colon. Diagnostics use a colon followed by whitespace
	// or end of line; this also handles a path header followed by continuation lines.
	const match = /^((?:[A-Za-z]:[\\/])?[^\r\n]+?):(?:\s|$)/.exec(cleaned);
	return match?.[1] ?? null;
}

export function createSearchDiagnostics(search: SearchCompleteness, allows: (path: string) => boolean) {
	let continuation = false;
	let realError = false;
	return {
		get realError() {
			return realError;
		},
		onLine(line: string, truncated = false): void {
			if (truncated) {
				search.skipped.unknown = true;
				search.complete = false;
				search.reason ??= "errors";
			}
			if (!line.trim()) return;
			if (continuation && /^\s/.test(line)) return;
			const path = searchDiagnosticPath(line);
			if (path) {
				skipSearchPath(search, path, allows);
				continuation = true;
				return;
			}
			if (continuation && /\(os error \d+\)/.test(line)) return;
			continuation = false;
			if (
				/^(?:rg: |\[fd error\]:? )?(?:regex parse error|error parsing (?:glob|regex)|invalid (?:glob|regex)|error:|Usage:)/i.test(
					line,
				)
			)
				realError = true;
			else search.skipped.unknown = true;
			search.complete = false;
			search.reason ??= "errors";
		},
	};
}

export function finishSearch(search: SearchCompleteness, result: LineStreamResult): void {
	const reason = result.aborted
		? "cancelled"
		: result.timedOut
			? "timeout"
			: result.stoppedEarly
				? "limit"
				: result.exitCode !== 0 && result.exitCode !== 1
					? "errors"
					: search.reason;
	if (reason) {
		search.complete = false;
		search.reason = reason;
	}
}

export function searchNotice(search: SearchCompleteness, shown: number, unit: string): string {
	return search.complete
		? ""
		: `\n[Search incomplete: ${search.reason}; ${shown} ${unit} shown; ${search.skipped.count}${search.skipped.unknown ? "+ (diagnostic coverage unknown)" : ""} paths skipped.]`;
}

export interface LineStreamOptions {
	/** Spawn cwd; defaults to the workspace root (process.cwd()). */
	cwd?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Called per stdout line. Invoke `stop()` to kill the child early. */
	onLine(line: string, stop: () => void): void;
	/** Receives every stderr line, independently of the retained diagnostic cap. */
	onStderrLine?(line: string, truncated: boolean): void;
}

export interface LineStreamResult {
	exitCode: number | null;
	stderr: string;
	oversizedDiagnostics: number;
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
		const timeoutMs = options.timeoutMs ?? timeoutContext.getStore() ?? SEARCH_SPAWN_TIMEOUT_MS;
		let timedOut = false;
		let aborted = false;
		let stoppedEarly = false;
		let killSent = false;
		let settled = false;
		const retainedStderr = Buffer.alloc(SEARCH_STDERR_CAP_BYTES);
		let stderrBytes = 0;
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
				oversizedDiagnostics: 0,
				timedOut: false,
				aborted: false,
				stoppedEarly: false,
				spawnError: spawned.message,
			});
			return;
		}
		const child = spawned.child;
		const rl = createInterface({ input: child.stdout });
		const stderrLines = new BoundedDiagnosticDecoder((line, truncated) => options.onStderrLine?.(line, truncated));

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
			stderrLines.end();
			resolve({
				exitCode: child.exitCode,
				stderr: decodeBoundedUtf8(retainedStderr.subarray(0, stderrBytes)),
				oversizedDiagnostics: stderrLines.oversizedLines,
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
			const take = Math.min(chunk.length, retainedStderr.length - stderrBytes);
			chunk.copy(retainedStderr, stderrBytes, 0, take);
			stderrBytes += take;
			stderrLines.write(chunk);
		});
		child.on("error", (error) => finish(error.message));
		child.on("close", () => finish(null));
	});
}
