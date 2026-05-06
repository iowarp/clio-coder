/**
 * Serialize one LF-framed JSONL record.
 *
 * Keep framing strict: JSON strings may legally contain U+2028/U+2029 and
 * escaped newlines, but records are delimited only by the final ASCII LF.
 */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}
