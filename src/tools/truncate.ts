import { cutHeadGuard, dropCutHead, dropShortCutHead, headGuardAfter } from "../domains/safety/redaction.js";
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

/**
 * A tail whose head does not strip the scheme or key from a credential-sized token. Truncation keeps whole lines unless the
 * last line alone overflows, so a partial line loses its cut tokens and a whole-line cut checks what it removed. A live row
 * passes `trim: "all"`: it can show nothing for a moment, while settled output must keep the bytes of a long token (#446).
 */
export function truncateTailAtToken(
	content: string,
	options: TruncationOptions = {},
	trim: "credential-sized" | "all" = "credential-sized",
): TruncationResult {
	const tail = truncateTail(content, options);
	if (!tail.truncated) return tail;
	const removed = content.length - tail.content.length - (content.endsWith("\n") ? 1 : 0);
	const guard = tail.lastLinePartial ? cutHeadGuard() : headGuardAfter(content.slice(0, removed));
	if (guard === null) return tail;
	const kept = trim === "all" ? dropCutHead(tail.content, guard) : dropShortCutHead(tail.content, guard);
	return { ...tail, content: kept, outputBytes: Buffer.byteLength(kept, "utf8") };
}
