// Per-observation source cap. One tool result must stay proportional to the
// question asked: ~16k chars ≈ 4k tokens, enough to read a typical source file
// or doc section in one call while a local backend still prefills it quickly.
// Truncated output always says how to continue (offset/limit or a narrower
// query), so larger requests cost extra calls, not a blown context. The
// per-turn observation budget (see read.ts) bounds how much these calls add up
// to within a single turn.
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 16 * 1024;
export const GREP_MAX_LINE_LENGTH = 500;

export interface TruncationResult {
	content: string;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	lastLinePartial: boolean;
	firstLineExceedsLimit: boolean;
	maxLines: number;
	maxBytes: number;
}

export interface TruncationOptions {
	maxLines?: number;
	maxBytes?: number;
}

// Count lines without a trailing-newline phantom entry. `"a\nb\n".split("\n")`
// yields `["a","b",""]` (3 entries) for a 2-line file; dropping the final empty
// element restores an honest count so continuation notices ("N more lines") do
// not over-report by one on newline-terminated files. Ported from pi's
// truncate.ts:47.
export function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const totalBytes = Buffer.byteLength(content, "utf8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	const firstLineBytes = Buffer.byteLength(lines[0] ?? "", "utf8");
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	const out: string[] = [];
	let outputBytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	for (let i = 0; i < lines.length && i < maxLines; i += 1) {
		const line = lines[i] ?? "";
		const lineBytes = Buffer.byteLength(line, "utf8") + (i > 0 ? 1 : 0);
		if (outputBytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}
		out.push(line);
		outputBytes += lineBytes;
	}
	if (out.length >= maxLines && outputBytes <= maxBytes) truncatedBy = "lines";
	const output = out.join("\n");
	return {
		content: output,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: out.length,
		outputBytes: Buffer.byteLength(output, "utf8"),
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

// Keep the tail of a UTF-8 string within a byte budget, cutting at a valid
// character boundary. Used when the last line alone exceeds the byte cap.
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf8");
	if (buf.length <= maxBytes) return str;
	let start = buf.length - maxBytes;
	while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start += 1;
	return buf.subarray(start).toString("utf8");
}

// Keep the LAST N lines / bytes (whichever cap is hit first). Suitable for
// shell/build/test output where the failing assertion, compiler error, and
// exit summary live at the end. Ported from pi's truncate.ts:168, including the
// partial-last-line edge case: when the final line alone exceeds maxBytes, the
// end of that line is kept and lastLinePartial is set.
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const totalBytes = Buffer.byteLength(content, "utf8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	const out: string[] = [];
	let outputBytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;
	for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i -= 1) {
		const line = lines[i] ?? "";
		const lineBytes = Buffer.byteLength(line, "utf8") + (out.length > 0 ? 1 : 0);
		if (outputBytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// The final line alone overflows the budget: keep its tail so the
			// last bytes (the exit summary) are still shown, flagged partial.
			if (out.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				out.unshift(truncatedLine);
				outputBytes = Buffer.byteLength(truncatedLine, "utf8");
				lastLinePartial = true;
			}
			break;
		}
		out.unshift(line);
		outputBytes += lineBytes;
	}
	if (out.length >= maxLines && outputBytes <= maxBytes) truncatedBy = "lines";
	const output = out.join("\n");
	return {
		content: output,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: out.length,
		outputBytes: Buffer.byteLength(output, "utf8"),
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

export function truncateLine(
	line: string,
	maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) return { text: line, wasTruncated: false };
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
