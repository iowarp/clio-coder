import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

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

export interface ProcessTreeTerminator {
	terminate(): void;
	cleanup(): void;
}

/** POSIX process-group termination with a direct-child fallback; Windows is direct-child only. */
export function createProcessTreeTerminator(
	child: { pid?: number | undefined; exitCode: number | null; kill(signal?: NodeJS.Signals): boolean },
	graceMs = 1500,
): ProcessTreeTerminator {
	let sent = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const signal = (name: NodeJS.Signals): void => {
		if (child.exitCode !== null) return;
		if (child.pid && process.platform !== "win32") {
			try {
				process.kill(-child.pid, name);
				return;
			} catch {
				// The child may not have established its group yet.
			}
		}
		child.kill(name);
	};
	return {
		terminate() {
			if (sent) return;
			sent = true;
			signal("SIGTERM");
			timer = setTimeout(() => signal("SIGKILL"), graceMs);
		},
		cleanup() {
			if (timer) clearTimeout(timer);
			timer = null;
		},
	};
}

export function waitForClose(child: {
	once(event: "error", listener: (err: Error) => void): unknown;
	once(event: "close", listener: (code: number | null) => void): unknown;
}): Promise<number> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (code: number): void => {
			if (settled) return;
			settled = true;
			resolve(code);
		};
		child.once("error", () => finish(1));
		child.once("close", (code: number | null) => finish(code ?? 1));
	});
}
