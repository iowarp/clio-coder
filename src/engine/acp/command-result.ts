/**
 * The lines an ACP command result holds, shared by the command control that builds a result and the server that
 * drops the result lines a notice already carried: both must cut a long line the same way or the two never match.
 */

const ACP_MAX_COMMAND_RESULT_LINE_BYTES = 1024;

const ACP_TRUNCATION_SUFFIX = "…[truncated]";

/** UTF-8-safe prefix; `Buffer.write` stops before a partial sequence, so no lone surrogate escapes. */
export function bounded(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const budget = maxBytes - Buffer.byteLength(ACP_TRUNCATION_SUFFIX, "utf8");
	if (budget <= 0) {
		const flat = Buffer.allocUnsafe(maxBytes);
		return flat.toString("utf8", 0, flat.write(value, 0, maxBytes, "utf8"));
	}
	const buffer = Buffer.allocUnsafe(budget);
	return `${buffer.toString("utf8", 0, buffer.write(value, 0, budget, "utf8"))}${ACP_TRUNCATION_SUFFIX}`;
}

/** `text` as result lines: no carriage returns, no trailing blanks, no empty lines, each cut to the line bound. */
export function commandResultLines(text: string): string[] {
	const lines: string[] = [];
	for (const raw of text.replace(/\r/gu, "").split("\n")) {
		const trimmed = raw.trimEnd();
		if (trimmed.length > 0) lines.push(bounded(trimmed, ACP_MAX_COMMAND_RESULT_LINE_BYTES));
	}
	return lines;
}
