import { writeRawStdout } from "../output-guard.js";
import type { RunJsonFrame } from "./run-json-schema.js";

/**
 * Serialize one LF-framed JSONL record.
 *
 * Keep framing strict: JSON strings may legally contain U+2028/U+2029 and
 * escaped newlines, but records are delimited only by the final ASCII LF.
 */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/**
 * A v2 run (`--output-format`) rewrites or withholds each v1 frame before it reaches stdout; null withholds it.
 * Unset for every v1 run, so v1 frames cross exactly as built.
 */
let frameProjector: ((frame: RunJsonFrame) => object | null) | null = null;

export function setFrameProjector(projector: ((frame: RunJsonFrame) => object | null) | null): void {
	frameProjector = projector;
}

/**
 * The one place a `run --json` frame reaches stdout, so nothing can enter the
 * stream without being declared in `RunJsonFrame`.
 */
export function writeFrame(frame: RunJsonFrame): void {
	const projected = frameProjector === null ? frame : frameProjector(frame);
	if (projected !== null) writeRawStdout(serializeJsonLine(projected));
}
