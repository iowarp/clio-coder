/**
 * Worker-side control lane writer.
 *
 * Control frames go to stderr behind the lane marker, never to stdout. A run
 * that floods stdout with tool output therefore cannot delay a heartbeat or a
 * cancellation acknowledgement behind megabytes of queued bulk frames: the two
 * lanes are separate pipes with separate kernel buffers.
 *
 * Writes are synchronous and best effort. A control frame that cannot be
 * written is not worth aborting a run over, and the orchestrator already treats
 * a missing heartbeat as a stall.
 */

import { CONTROL_FRAME_PREFIX, encodeControlFrame, type WorkerControlFrame } from "./protocol.js";

/**
 * Text that is not a control frame, such as a model-written command echoed in a
 * diagnostic, must not start a stderr line with the lane marker, or the
 * orchestrator parses it as a frame. Lines that do, or that begin with a piece
 * of it a later write could complete, are indented by one space.
 */
export function neutralizeControlPrefix(text: string, atLineStart: boolean): string {
	let out = "";
	let lineStart = atLineStart;
	for (const piece of text.split(/(?<=\n)/u)) {
		const head = piece.slice(0, CONTROL_FRAME_PREFIX.length);
		const risky = lineStart && head.length > 0 && CONTROL_FRAME_PREFIX.startsWith(head.replace(/\n$/u, "") || "\0");
		out += risky ? ` ${piece}` : piece;
		lineStart = piece.endsWith("\n");
	}
	return out;
}

let rawStderrWrite: ((chunk: string) => boolean) | null = null;
let stderrAtLineStart = true;

/** Route every non-frame stderr write in this worker through neutralizeControlPrefix. */
export function guardControlLane(): void {
	if (rawStderrWrite !== null) return;
	const raw = process.stderr.write.bind(process.stderr) as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;
	rawStderrWrite = (chunk) => raw(chunk);
	process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
		const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		const safe = neutralizeControlPrefix(text, stderrAtLineStart);
		if (text.length > 0) stderrAtLineStart = text.endsWith("\n");
		return raw(safe, ...rest);
	}) as typeof process.stderr.write;
}

export function emitControlFrame(frame: WorkerControlFrame): void {
	try {
		const encoded = encodeControlFrame(frame);
		if (rawStderrWrite === null) process.stderr.write(encoded);
		else {
			rawStderrWrite(stderrAtLineStart ? encoded : `\n${encoded}`);
			stderrAtLineStart = true;
		}
	} catch {
		// The orchestrator's stall watchdog covers a wedged control lane.
	}
}
