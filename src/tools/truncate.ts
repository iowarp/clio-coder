import {
	formatSize,
	GREP_MAX_LINE_LENGTH,
	splitLinesForCounting,
	type TruncationOptions,
	type TruncationResult,
	truncateLine,
	truncateHead as truncatePiHead,
	truncateTail as truncatePiTail,
} from "../engine/truncate.js";

// Per-observation source cap. The engine copy defaults to 50 KiB; Clio allows
// 64 KiB while its default 192 KiB turn pool remains authoritative across
// calls. Three full results consume that pool, so a fourth finds it filled.
// The wrappers below retain only that 64 KiB and 2000-line product default;
// the engine copy owns UTF-8-safe head/tail truncation, line counting,
// grep-line clipping, and size formatting.
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 64 * 1024;
export type { TruncationResult };
export { formatSize, GREP_MAX_LINE_LENGTH, splitLinesForCounting, truncateLine };

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
