import {
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationOptions,
	type TruncationResult,
	truncateLine,
	truncateHead as truncatePiHead,
	truncateTail as truncatePiTail,
} from "../engine/truncate.js";

// Per-observation source cap. Pi defaults to 50 KiB; Clio allows 64 KiB while
// its default 192 KiB turn pool remains authoritative across calls. Three full
// results consume that pool, so a fourth finds it filled. The wrappers below
// retain only that product-level delta while Pi owns UTF-8-safe head/tail
// truncation, line limits, grep-line clipping, and size formatting.
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 64 * 1024;
export type { TruncationResult };
export { formatSize, GREP_MAX_LINE_LENGTH, truncateLine };

// Count lines without a trailing-newline phantom entry. Pi uses the same
// counting rule internally but does not export it; Clio's read continuation
// notices need the total before selecting a slice.
export function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

function withClioDefaults(options: TruncationOptions): Required<TruncationOptions> {
	return {
		maxLines: options.maxLines ?? DEFAULT_MAX_LINES,
		maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
	};
}

export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	return truncatePiHead(content, withClioDefaults(options));
}

export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	return truncatePiTail(content, withClioDefaults(options));
}
