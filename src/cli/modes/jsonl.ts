import { writeRawStdout } from "../output-guard.js";
import type { RunJsonFrame } from "./run-json-schema.js";

/**
 * Serialize one LF-framed JSONL record.
 *
 * Keep framing strict: JSON strings may legally contain U+2028/U+2029 and
 * escaped newlines, but records are delimited only by the final ASCII LF.
 */
function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/**
 * The one place a `run --json` frame reaches stdout, so nothing can enter the
 * stream without being declared in `RunJsonFrame`.
 */
export function writeFrame(frame: RunJsonFrame): void {
	writeRawStdout(serializeJsonLine(frame));
}
