import { isUtf8 } from "node:buffer";
import { type FileHandle, open, stat } from "node:fs/promises";
import { Type } from "typebox";
import { detectSupportedImageMimeType, prepareBoundedImage } from "../core/file-references.js";
import { GUARDRAIL_DEFAULTS, resolveGuardrail } from "../core/guardrails.js";
import { ToolNames } from "../core/tool-names.js";
import {
	commitObservationReservation,
	finalizeObservation,
	type ObservationReservation,
	observationBudgetExhausted,
	releaseObservation,
	reserveObservation,
} from "./observation.js";
import { resolveReadPath } from "./path-utils.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "./registry.js";
import { isSessionOffloadPath } from "./result-shaping.js";
import {
	DEFAULT_MAX_LINES,
	formatSize,
	splitLinesForCounting,
	type TruncationResult,
	truncateHead,
	truncateTail,
} from "./truncate.js";
import { truncateUtf8 } from "./truncate-utf8.js";

// Per-call read cap. Raised from the 16KB per-observation source cap toward
// pi's 50KB so large source/generated files finish in fewer calls (a 144KB file
// took ~9 sequential 16KB reads before). The per-turn observation budget
// (src/tools/observation.ts) still bounds the aggregate. The configurable
// value lives at safety.limits.readBytesPerCall.
export const DEFAULT_READ_MAX_BYTES = GUARDRAIL_DEFAULTS.readMaxBytes;
const MIN_READ_CAP_BYTES = 1024;

/**
 * Scan granularity. The newline scans (forward to `offset`, backward for
 * `tail`) hold one chunk at a time, so a call's peak memory is this chunk plus
 * the returned window, never the file.
 */
export const READ_SCAN_CHUNK_BYTES = 64 * 1024;

/**
 * Files up to this size get an exact physical line count on every call (one
 * sequential newline scan in O(chunk) memory). Larger files skip the count and
 * report `totalCount: null`, which the envelope renders as `N+`, together with
 * their byte size, so a call on a multi-gigabyte log stays O(window).
 */
export const READ_LINE_COUNT_BUDGET_BYTES = 32 * 1024 * 1024;

/**
 * Images are decoded whole because the encoder needs every byte, so they keep
 * the ceiling every read had before the text reader became windowed.
 */
const IMAGE_MAX_BYTES = 20_000_000;

/**
 * Bytes read past the cap so that a window cut inside a multibyte sequence can
 * drop that sequence (at most three bytes) and still hold enough bytes for the
 * shared truncation to decide on the window exactly as it would on the whole
 * selection. A forward window needs cap+1 bytes: its partial last line then
 * never fits. A tail window needs cap+2: the file's trailing terminator is not
 * part of the joined text, so with cap+1 bytes a cut first line could fit
 * exactly at the cap and be shown as complete.
 */
export const READ_WINDOW_SLACK_BYTES = 5;

/**
 * Test-only seams; production code never sets them. `afterIdentity` runs once
 * the descriptor's identity is recorded and before any window read, so a test
 * can change the file in flight deterministically. `beforeChunk` runs before
 * every scan chunk with its byte position, so a test can abort mid-scan.
 */
export const readTestSeams: {
	afterIdentity?: ((file: ReadFileIdentity, path: string) => Promise<void> | void) | undefined;
	beforeChunk?: ((position: number) => void) | undefined;
} = {};

const NON_TEXT_HINT =
	"For CSV, TSV, JSON, or JSONL use the data capability through the gateway; for binary or other encodings use run_script with a suitable library. Do not edit it as text.";

/** Identity of the file as it was read, from fstat on the open descriptor. */
export interface ReadFileIdentity {
	bytes: number;
	mtimeMs: number;
}

export function readMaxBytes(): number {
	return Math.max(MIN_READ_CAP_BYTES, resolveGuardrail("readMaxBytes"));
}

// Number only an already bounded slice, retaining its explicit physical line
// count: a truncated slice ending in a blank line can look like a terminator.
function numberSourceLines(content: string, firstLine: number, lineCount: number): string {
	return content
		.split("\n")
		.map((line, index) => (index < lineCount ? `${firstLine + index} | ${line}` : line))
		.join("\n");
}

function numberedPrefixBytes(totalLines: number): number {
	let bytes = totalLines * 3; // " | " after each decimal source line number.
	for (let first = 1, digits = 1; first <= totalLines; first *= 10, digits++) {
		bytes += (Math.min(totalLines + 1, first * 10) - first) * digits;
	}
	return bytes;
}

class ReadCancelled extends Error {
	constructor(readonly position: number) {
		super("read cancelled");
	}
}

/** Every scan calls this once per chunk: the seam sees the position, then an aborted signal stops the scan. */
function chunkBoundary(signal: AbortSignal | undefined, position: number): void {
	readTestSeams.beforeChunk?.(position);
	if (signal?.aborted) throw new ReadCancelled(position);
}

/** Fill `buffer[0, length)` from `position`; the view is shorter only at EOF. */
async function readInto(handle: FileHandle, buffer: Buffer, position: number, length: number): Promise<Buffer> {
	let filled = 0;
	while (filled < length) {
		const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
		if (bytesRead === 0) break;
		filled += bytesRead;
	}
	return buffer.subarray(0, filled);
}

async function readExact(handle: FileHandle, position: number, length: number): Promise<Buffer> {
	const size = Math.max(0, length);
	return readInto(handle, Buffer.allocUnsafe(size), position, size);
}

interface ForwardScan {
	/** Byte position right after the requested newline, or null when the file has fewer. */
	target: number | null;
	/** Every newline when counting the file, otherwise only those up to the target. */
	newlines: number;
}

/**
 * Walk the file from the start one chunk at a time. Finds where line
 * `skipNewlines + 1` begins and, when `countAll` is set, keeps going to EOF so
 * the caller has the exact newline count. A target that is never found means
 * the whole file was scanned, so `newlines` is exact in that case too.
 */
async function scanForward(
	handle: FileHandle,
	size: number,
	skipNewlines: number,
	countAll: boolean,
	signal: AbortSignal | undefined,
): Promise<ForwardScan> {
	const chunk = Buffer.allocUnsafe(READ_SCAN_CHUNK_BYTES);
	let position = 0;
	let newlines = 0;
	let target: number | null = skipNewlines === 0 ? 0 : null;
	while (position < size && (countAll || target === null)) {
		chunkBoundary(signal, position);
		const view = await readInto(handle, chunk, position, Math.min(READ_SCAN_CHUNK_BYTES, size - position));
		if (view.length === 0) break;
		let index = view.indexOf(0x0a);
		while (index >= 0) {
			newlines += 1;
			if (target === null && newlines === skipNewlines) {
				target = position + index + 1;
				if (!countAll) break;
			}
			index = view.indexOf(0x0a, index + 1);
		}
		position += view.length;
	}
	return { target, newlines };
}

/**
 * Walk the file from the end one chunk at a time, looking for the
 * `skipNewlines`-th newline from EOF. Returns the byte position after it, 0
 * when the file holds fewer newlines, or null once `retainBytes` have been
 * scanned without finding it: the selection then starts before the window the
 * caller will keep, and the byte cap alone decides what is shown.
 */
async function scanBackward(
	handle: FileHandle,
	size: number,
	skipNewlines: number,
	retainBytes: number,
	signal: AbortSignal | undefined,
): Promise<number | null> {
	const chunk = Buffer.allocUnsafe(READ_SCAN_CHUNK_BYTES);
	let position = size;
	let found = 0;
	while (position > 0) {
		if (size - position >= retainBytes) return null;
		chunkBoundary(signal, position);
		const start = Math.max(0, position - READ_SCAN_CHUNK_BYTES);
		const view = await readInto(handle, chunk, start, position - start);
		let index = view.lastIndexOf(0x0a);
		while (index >= 0) {
			found += 1;
			if (found === skipNewlines) return start + index + 1;
			index = index === 0 ? -1 : view.lastIndexOf(0x0a, index - 1);
		}
		position = start;
	}
	return 0;
}

/** Absolute index of the next newline at or after `from`, `size` at EOF, or null past the scan budget. */
async function findLineEnd(
	handle: FileHandle,
	from: number,
	size: number,
	budget: number,
	signal: AbortSignal | undefined,
): Promise<number | null> {
	const chunk = Buffer.allocUnsafe(READ_SCAN_CHUNK_BYTES);
	let position = from;
	while (position < size) {
		if (position - from >= budget) return null;
		chunkBoundary(signal, position);
		const view = await readInto(handle, chunk, position, Math.min(READ_SCAN_CHUNK_BYTES, size - position));
		if (view.length === 0) break;
		const index = view.indexOf(0x0a);
		if (index >= 0) return position + index;
		position += view.length;
	}
	return size;
}

/** Index of the n-th newline in `bytes`, or -1 when it holds fewer. */
function nthNewline(bytes: Buffer, n: number): number {
	let index = -1;
	for (let found = 0; found < n; found += 1) {
		index = bytes.indexOf(0x0a, index + 1);
		if (index < 0) return -1;
	}
	return index;
}

/** Drop a multibyte sequence that a byte-cut window ends inside, so decoding stays exact. */
function trimIncompleteSequence(bytes: Buffer): Buffer {
	let index = bytes.length - 1;
	let continuation = 0;
	while (index >= 0 && continuation < 3 && ((bytes[index] as number) & 0xc0) === 0x80) {
		index -= 1;
		continuation += 1;
	}
	if (index < 0) return bytes;
	const lead = bytes[index] as number;
	const need = lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : lead >= 0xc0 ? 1 : 0;
	return need > continuation ? bytes.subarray(0, index) : bytes;
}

/** Continuation bytes a byte-cut window starts with; they belong to a character before it. */
function leadingContinuationBytes(bytes: Buffer): number {
	let count = 0;
	while (count < 3 && count < bytes.length && ((bytes[count] as number) & 0xc0) === 0x80) count += 1;
	return count;
}

/**
 * Index of the first byte that cannot start or continue a well-formed UTF-8
 * sequence (overlongs, surrogates, and code points above U+10FFFF included),
 * or -1. A sequence cut off by the end of the buffer reports its lead byte.
 */
function firstInvalidUtf8(bytes: Buffer): number {
	if (isUtf8(bytes)) return -1;
	let index = 0;
	while (index < bytes.length) {
		const lead = bytes[index] as number;
		if (lead < 0x80) {
			index += 1;
			continue;
		}
		let need: number;
		let low = 0x80;
		let high = 0xbf;
		if (lead >= 0xc2 && lead <= 0xdf) need = 1;
		else if (lead >= 0xe0 && lead <= 0xef) {
			need = 2;
			if (lead === 0xe0) low = 0xa0;
			else if (lead === 0xed) high = 0x9f;
		} else if (lead >= 0xf0 && lead <= 0xf4) {
			need = 3;
			if (lead === 0xf0) low = 0x90;
			else if (lead === 0xf4) high = 0x8f;
		} else return index;
		if (index + need >= bytes.length) return index;
		const first = bytes[index + 1] as number;
		if (first < low || first > high) return index + 1;
		for (let step = 2; step <= need; step += 1) {
			const byte = bytes[index + step] as number;
			if (byte < 0x80 || byte > 0xbf) return index + step;
		}
		index += need + 1;
	}
	return -1;
}

function lastLineOf(text: string): string {
	const lines = splitLinesForCounting(text);
	return lines[lines.length - 1] ?? "";
}

function refuseBinary(pathArg: string, offset: number, file: ReadFileIdentity): ToolResult {
	return {
		kind: "error",
		message: `read: ${pathArg} looks binary: NUL byte at byte offset ${offset} of ${formatSize(file.bytes)}. ${NON_TEXT_HINT}`,
		details: { file },
	};
}

function refuseEncoding(pathArg: string, offset: number, byte: number, file: ReadFileIdentity): ToolResult {
	const hex = byte.toString(16).padStart(2, "0").toUpperCase();
	return {
		kind: "error",
		message: `read: ${pathArg} is not valid UTF-8 text: byte 0x${hex} at byte offset ${offset} of ${formatSize(file.bytes)} cannot be decoded. ${NON_TEXT_HINT}`,
		details: { file },
	};
}

/**
 * Refuse NUL bytes and malformed UTF-8 inside the window that would be shown,
 * naming the failing absolute byte offset; never substitute U+FFFD and present
 * the result as text.
 */
function decodeWindow(
	window: Buffer,
	absoluteStart: number,
	pathArg: string,
	file: ReadFileIdentity,
): string | ToolResult {
	const nul = window.indexOf(0);
	if (nul >= 0) return refuseBinary(pathArg, absoluteStart + nul, file);
	const invalid = firstInvalidUtf8(window);
	if (invalid >= 0) return refuseEncoding(pathArg, absoluteStart + invalid, window[invalid] as number, file);
	return window.toString("utf8");
}

function beyondEndOfFile(offset: number, totalLines: number, file: ReadFileIdentity): ToolResult {
	// The anchor matters for weak models: a bare "beyond end of file" reads as
	// a paging mistake and triggers a tail-re-reading walk. Say plainly that
	// nothing exists past the last line and that re-reading cannot produce new
	// content.
	return {
		kind: "error",
		message:
			`read: offset ${offset} is beyond end of file (${totalLines} lines total). The file ends at line ` +
			`${totalLines} and has no further content; do not page past it or re-read the tail. A read covering ` +
			`line ${totalLines} has already returned everything.`,
		details: { file },
	};
}

/**
 * One notice line for a file whose identity changed between the descriptor's
 * fstat and the end of the reads. It carries the envelope's own fields
 * (counts, sizes, continuation) computed from the body alone, so the shown
 * and total sizes keep describing file content, and the envelope's notice is
 * suppressed in favour of this one.
 */
function changedFileNotice(view: ReadView, pathArg: string, before: ReadFileIdentity, after: ReadFileIdentity): string {
	const stamp = (identity: ReadFileIdentity) => `${identity.bytes}B (mtime ${new Date(identity.mtimeMs).toISOString()})`;
	const changed =
		`${pathArg} changed while being read: ${stamp(before)} when the read began, ${stamp(after)} when it finished; ` +
		"the lines and counts above may mix the two states, re-read to see the current content";
	if (!view.truncated || view.omitNotice) return `[read: ${changed}]`;
	const total = view.totalCount === null ? `${view.shownCount}+` : String(view.totalCount);
	const parts = [
		`read: ${view.shownCount}/${total} lines shown (${formatSize(Buffer.byteLength(view.output))} of ${formatSize(view.totalBytes)})`,
		...(view.next !== undefined ? [`next: ${view.next}`] : []),
		changed,
	];
	return `[${parts.join(" | ")}]`;
}

interface ReadRequest {
	pathArg: string;
	numbered: boolean;
	offset: number;
	limit: number | null;
	tail: number | null;
	signal: AbortSignal | undefined;
}

/** A selected, bounded rendering ready for the observation envelope. */
interface ReadView {
	output: string;
	shownCount: number;
	totalCount: number | null;
	totalBytes: number;
	truncated: boolean;
	next?: string;
	omitNotice?: boolean;
}

interface ReadPlan {
	file: ReadFileIdentity;
	cap: number;
	/** Exact line counting is affordable for this file (size within the budget). */
	counted: boolean;
	endsWithNewline: boolean;
}

async function firstLineSizeText(
	handle: FileHandle,
	lineStart: number,
	window: Buffer,
	windowEnd: number,
	size: number,
	labelBytes: number,
	signal: AbortSignal | undefined,
): Promise<string> {
	const newline = window.indexOf(0x0a);
	if (newline >= 0) return formatSize(labelBytes + newline);
	if (windowEnd >= size) return formatSize(labelBytes + (size - lineStart));
	const end = await findLineEnd(handle, windowEnd, size, READ_LINE_COUNT_BUDGET_BYTES, signal);
	if (end === null) return `at least ${formatSize(labelBytes + (windowEnd - lineStart) + READ_LINE_COUNT_BUDGET_BYTES)}`;
	return formatSize(labelBytes + (end - lineStart));
}

/**
 * Forward path: locate line `offset` with a newline scan, read one window of
 * cap+slack bytes (or up to the `limit`-th terminator) from there, and apply
 * the shared head truncation to that window. The window always holds cap+1
 * decidable bytes when the selection is longer, so the truncation decides
 * exactly as it would over the whole selection.
 */
async function readHead(handle: FileHandle, request: ReadRequest, plan: ReadPlan): Promise<ReadView | ToolResult> {
	const { pathArg, offset, limit, numbered, signal } = request;
	const { file, cap, counted, endsWithNewline } = plan;
	const size = file.bytes;
	const unterminated = size > 0 && !endsWithNewline ? 1 : 0;
	const scan = await scanForward(handle, size, offset - 1, counted, signal);
	if (scan.target === null || (offset > 1 && scan.target >= size)) {
		// Both cases scanned to EOF, so the newline count is exact whatever the size.
		return beyondEndOfFile(offset, scan.newlines + unterminated, file);
	}
	const totalLines = counted ? scan.newlines + unterminated : null;
	const startByte = scan.target;
	const startIndex = offset - 1;
	let window = await readExact(handle, startByte, Math.min(cap + READ_WINDOW_SLACK_BYTES, size - startByte));
	let cut = startByte + window.length < size;
	if (limit !== null) {
		const stop = nthNewline(window, limit);
		if (stop >= 0) {
			window = window.subarray(0, stop + 1);
			cut = false;
		}
	}
	if (cut) window = trimIncompleteSequence(window);
	const windowEnd = startByte + window.length;
	const decoded = decodeWindow(window, startByte, pathArg, file);
	if (typeof decoded !== "string") return decoded;
	const linesInWindow = splitLinesForCounting(decoded).length;
	const totalBytes = size + (numbered && totalLines !== null ? numberedPrefixBytes(totalLines) : 0);
	const sourceTruncation = truncateHead(decoded, { maxBytes: cap });
	const truncation: TruncationResult =
		numbered && !sourceTruncation.firstLineExceedsLimit
			? truncateHead(numberSourceLines(sourceTruncation.content, startIndex + 1, sourceTruncation.outputLines), {
					maxBytes: cap,
				})
			: sourceTruncation;
	if (truncation.firstLineExceedsLimit) {
		const label = numbered ? `${startIndex + 1} | ` : "";
		const labelBytes = Buffer.byteLength(label);
		const firstLine = decoded.split("\n", 1)[0] ?? "";
		const lineSize = await firstLineSizeText(handle, startByte, window, windowEnd, size, labelBytes, signal);
		const linePrefix = label + truncateUtf8(firstLine, cap - labelBytes, "\n[line truncated]");
		const output = `${linePrefix}\n\n[${numbered ? "Numbered line" : "Line"} ${startIndex + 1} is ${lineSize}, exceeding the ${formatSize(cap)} read limit. Showing the UTF-8 prefix only. Use grep with a narrower literal/regex or edit with exact surrounding text; use shell access only when byte-level inspection is required.]`;
		return { output, shownCount: 0, totalCount: totalLines, totalBytes, truncated: true, omitNotice: true };
	}
	const endDisplay = startIndex + truncation.outputLines;
	// More lines follow when the truncation kept fewer lines than the window
	// holds, or when the window stopped short of EOF (at the limit-th
	// terminator or at the byte cap).
	const moreAfter = truncation.outputLines < linesInWindow || windowEnd < size;
	const truncated = sourceTruncation.truncated || truncation.truncated || (limit !== null && moreAfter);
	return {
		output: truncation.content,
		shownCount: truncation.outputLines,
		totalCount: totalLines,
		totalBytes,
		truncated,
		...(truncated && moreAfter ? { next: `offset=${endDisplay + 1}${numbered ? " line_numbers=true" : ""}` } : {}),
	};
}

/**
 * Tail path: scan backward from EOF for the terminator that starts the last N
 * lines, keep at most cap+slack bytes of that selection, and apply the shared
 * tail truncation so the very end of the file always survives the byte cap.
 */
async function readTail(handle: FileHandle, request: ReadRequest, plan: ReadPlan): Promise<ReadView | ToolResult> {
	const { pathArg, numbered, signal } = request;
	const tail = request.tail ?? 1;
	const { file, cap, counted, endsWithNewline } = plan;
	const size = file.bytes;
	if (numbered && !counted) {
		return {
			kind: "error",
			message:
				`read: line_numbers with tail needs a physical line count, and ${pathArg} is ${formatSize(size)}, above the ` +
				`${formatSize(READ_LINE_COUNT_BUDGET_BYTES)} counting budget. Use tail without line_numbers, use offset/limit ` +
				"(line numbers stay exact there), or grep to locate the region first.",
			details: { file },
		};
	}
	const unterminated = size > 0 && !endsWithNewline ? 1 : 0;
	const totalLines = counted ? (await scanForward(handle, size, 0, true, signal)).newlines + unterminated : null;
	const retain = cap + READ_WINDOW_SLACK_BYTES;
	// A trailing terminator ends the last line rather than starting a phantom
	// one, so it is one more newline to skip before the selection begins.
	const selectionStart = await scanBackward(handle, size, tail + (endsWithNewline ? 1 : 0), retain, signal);
	const windowStart = Math.max(selectionStart ?? 0, size - retain, 0);
	const cutFront = selectionStart === null || windowStart > selectionStart;
	let window = await readExact(handle, windowStart, size - windowStart);
	let skipped = 0;
	if (cutFront) {
		skipped = leadingContinuationBytes(window);
		window = window.subarray(skipped);
	}
	const decoded = decodeWindow(window, windowStart + skipped, pathArg, file);
	if (typeof decoded !== "string") return decoded;
	const sourceTruncation = truncateTail(decoded, { maxBytes: cap, maxLines: tail });
	let truncation = sourceTruncation;
	if (numbered && totalLines !== null) {
		const numberedContent = numberSourceLines(
			sourceTruncation.content,
			totalLines - sourceTruncation.outputLines + 1,
			sourceTruncation.outputLines,
		);
		truncation = truncateTail(numberedContent, { maxBytes: cap, maxLines: tail });
		if (sourceTruncation.lastLinePartial || truncation.lastLinePartial) {
			// Never return a tail fragment with a lost or fabricated complete
			// line label. Keep the suffix within the cap and mark it partial.
			const label = `${totalLines} | [partial line suffix] `;
			const suffix = truncateTail(lastLineOf(decoded), { maxBytes: cap - Buffer.byteLength(label) });
			truncation = { ...truncation, content: label + suffix.content, outputLines: 0, truncated: true };
		}
	}
	const shownLines = truncation.outputLines;
	// A front cut means the byte cap, not the tail count, bounded this call.
	const truncated = cutFront || selectionStart !== 0 || sourceTruncation.truncated || truncation.truncated;
	const totalBytes = size + (numbered && totalLines !== null ? numberedPrefixBytes(totalLines) : 0);
	let next: string | undefined;
	if (truncated && shownLines > 0) {
		if (totalLines !== null) {
			const firstShown = Math.max(1, totalLines - shownLines + 1);
			next = `offset=${Math.max(1, firstShown - shownLines)} limit=${shownLines}${numbered ? " line_numbers=true" : ""}`;
		} else if (!cutFront && !sourceTruncation.truncated && !truncation.truncated) {
			// Without a line count the earlier lines have no known offset; a
			// larger tail is the only exact continuation, and only while the
			// tail count rather than the byte cap bounded this call.
			next = `tail=${tail * 2}`;
		}
	}
	return {
		output: truncation.content,
		shownCount: shownLines,
		totalCount: totalLines,
		totalBytes,
		truncated,
		...(next !== undefined ? { next } : {}),
	};
}

async function readImage(
	handle: FileHandle,
	pathArg: string,
	file: ReadFileIdentity,
	reservation: ObservationReservation,
	options: ToolInvokeOptions | undefined,
): Promise<ToolResult> {
	if (file.bytes > IMAGE_MAX_BYTES) {
		return {
			kind: "error",
			message: `read: image too large (${file.bytes}B > 20MB); images are decoded whole. Downscale it first, for example with run_script and an image library.`,
			details: { file },
		};
	}
	if (options?.supportsImages !== true) {
		return {
			kind: "error",
			message:
				"IMAGE_INPUT_UNSUPPORTED: the routed model does not support image input. Choose a vision-capable model to inspect this file.",
			details: { file },
		};
	}
	const bytes = await readExact(handle, 0, file.bytes);
	const output = `Image: ${pathArg}`;
	commitObservationReservation(reservation);
	const image = await prepareBoundedImage(
		bytes,
		Math.min(reservation.callCapBytes, options.toolResultMaxBytes ?? readMaxBytes()) - Buffer.byteLength(output) - 512,
	);
	if (image === null) {
		return {
			kind: "error",
			message: "IMAGE_RESULT_TOO_LARGE: image could not be encoded within the tool result byte cap.",
			details: { file },
		};
	}
	return finalizeObservation({
		tool: ToolNames.Read,
		unit: "results",
		output,
		images: [image],
		shownCount: 1,
		totalCount: 1,
		truncated: false,
		details: { file },
		reservation,
		...(options ? { options } : {}),
	});
}

export const readTool: ToolSpec = {
	name: ToolNames.Read,
	description: `Read a UTF-8 text file or a PNG, JPEG, GIF, or WebP image when the routed model supports vision. Output is capped at ${DEFAULT_MAX_LINES} lines or ${
		DEFAULT_READ_MAX_BYTES / 1024
	}KB per call; truncated results say how to continue with offset/limit. Files of any size are read through one bounded window, so offset and tail stay cheap; files over 32MB report their line total as N+. Binary or non-UTF-8 files are refused with the failing byte offset. Pass tail=N to read the last N lines (jump to EOF) instead of paging from the top. Set line_numbers=true for citations: each source line is prefixed with its physical 1-based line number and " | "; these labels are not file content.`,
	parameters: Type.Object({
		path: Type.String({ description: "File path (relative or absolute)." }),
		line_numbers: Type.Optional(
			Type.Boolean({
				description: "Display physical source line numbers for citations. Default false preserves plain text.",
			}),
		),
		offset: Type.Optional(Type.Number({ description: "1-indexed start line." })),
		limit: Type.Optional(Type.Number({ description: "Max lines to read." })),
		tail: Type.Optional(
			Type.Number({ description: "Read the last N lines of the file (jump to EOF). Overrides offset/limit." }),
		),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args, options): Promise<ToolResult> {
		const pathArg = typeof args.path === "string" ? args.path : null;
		if (!pathArg) return { kind: "error", message: "read: missing path argument" };
		const filePath = resolveReadPath(pathArg);
		const request: ReadRequest = {
			pathArg,
			numbered: args.line_numbers === true,
			offset: typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 1,
			limit: typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : null,
			tail: typeof args.tail === "number" && args.tail > 0 ? Math.floor(args.tail) : null,
			signal: options?.signal,
		};
		// Reading the session's own offload files bypasses the shared turn pool
		// (an optionless reservation is untracked): the "full: <path>" escape
		// hatch appears exactly when the pool is exhausted, so charging these
		// reads to it made the hatch a dead end. The per-call byte cap still
		// bounds each slice.
		const reservation = isSessionOffloadPath(filePath, options?.sessionId)
			? reserveObservation(readMaxBytes())
			: reserveObservation(readMaxBytes(), options);
		let handle: FileHandle | null = null;
		let file: ReadFileIdentity | null = null;
		try {
			// stat before open: open() on a FIFO without a writer blocks a
			// threadpool thread forever and no signal can interrupt it, so only
			// a regular file is ever opened. The stat identity stamps the
			// results below that never open the file.
			const entry = await stat(filePath);
			file = { bytes: entry.size, mtimeMs: entry.mtimeMs };
			if (!entry.isFile()) return { kind: "error", message: `read: not a file: ${filePath}`, details: { file } };
			if (reservation.exhausted) {
				const exhausted = observationBudgetExhausted({
					tool: ToolNames.Read,
					unit: "lines",
					reservation,
					subject: `reading ${pathArg}`,
					hint: "Use offset/limit in a follow-up turn or grep/find for a narrower section.",
				});
				return { ...exhausted, details: { ...(exhausted.details ?? {}), file } };
			}
			// Every path below awaits descriptor reads, so charge the cap up
			// front for concurrent OBSERVE siblings; finalize reconciles it to
			// the bytes returned and the finally block refunds an error path.
			commitObservationReservation(reservation);
			handle = await open(filePath, "r");
			// The descriptor's own identity is what every read below describes.
			const opened = await handle.stat();
			file = { bytes: opened.size, mtimeMs: opened.mtimeMs };
			if (!opened.isFile()) return { kind: "error", message: `read: not a file: ${filePath}`, details: { file } };
			await readTestSeams.afterIdentity?.(file, filePath);
			const first = await readExact(handle, 0, Math.min(file.bytes, READ_SCAN_CHUNK_BYTES));
			if (detectSupportedImageMimeType(first) !== null)
				return await readImage(handle, pathArg, file, reservation, options);
			const nul = first.indexOf(0);
			if (nul >= 0) return refuseBinary(pathArg, nul, file);
			const lastByte =
				file.bytes <= first.length ? first[file.bytes - 1] : (await readExact(handle, file.bytes - 1, 1))[0];
			const plan: ReadPlan = {
				file,
				cap: reservation.callCapBytes,
				counted: file.bytes <= READ_LINE_COUNT_BUDGET_BYTES,
				endsWithNewline: file.bytes > 0 && lastByte === 0x0a,
			};
			const view = request.tail === null ? await readHead(handle, request, plan) : await readTail(handle, request, plan);
			if ("kind" in view) return view;
			const after = await handle.stat();
			const change: ReadFileIdentity | null =
				after.size !== file.bytes || after.mtimeMs !== file.mtimeMs ? { bytes: after.size, mtimeMs: after.mtimeMs } : null;
			const output = change === null ? view.output : `${view.output}\n\n${changedFileNotice(view, pathArg, file, change)}`;
			return finalizeObservation({
				tool: ToolNames.Read,
				unit: "lines",
				output,
				shownCount: view.shownCount,
				totalCount: view.totalCount,
				totalBytes: view.totalBytes,
				truncated: view.truncated,
				...(view.next !== undefined ? { next: view.next } : {}),
				...(view.omitNotice || change !== null ? { omitNotice: true } : {}),
				details: { file, ...(change !== null ? { fileChange: change } : {}) },
				reservation,
				...(options ? { options } : {}),
			});
		} catch (err) {
			if (err instanceof ReadCancelled) {
				return {
					kind: "error",
					message: `read: cancelled while scanning ${pathArg} at byte ${err.position}`,
					...(file !== null ? { details: { file } } : {}),
				};
			}
			const msg = err instanceof Error ? err.message : String(err);
			const code = (err as NodeJS.ErrnoException | undefined)?.code;
			if (code === "ENOENT") {
				return {
					kind: "error",
					message: `read: ${msg}. File not found at ${pathArg}. The path may be wrong. Try: code_nav, find, or ls to locate it.`,
				};
			}
			return { kind: "error", message: `read: ${msg}` };
		} finally {
			releaseObservation(reservation);
			if (handle !== null) await handle.close().catch(() => undefined);
		}
	},
};
