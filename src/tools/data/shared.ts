import { createReadStream, statSync } from "node:fs";

/**
 * Shared substrate for the structured-data readers (csv.ts, json.ts,
 * jsonl.ts): the fatal UTF-8 chunk decoder, the text stream with its byte
 * accounting, the typed refusals every reader returns instead of a guess, and
 * the cell classification the CSV and JSONL inspectors both use.
 *
 * Every reader streams. Nothing in this directory reads a data file whole,
 * and every result says how it was produced (`DataViewFlags`) so a sampled
 * scan can never pass for the complete dataset.
 */

export const DATA_FORMATS = ["csv", "tsv", "json", "jsonl"] as const;
export type DataFormat = (typeof DATA_FORMATS)[number];

export function isDataFormat(value: unknown): value is DataFormat {
	return typeof value === "string" && (DATA_FORMATS as ReadonlyArray<string>).includes(value);
}

/**
 * How a result was produced. `exact` means every reported figure and every
 * selected value covers the whole file verbatim; `sampled` means scanning
 * stopped before the end, so counts are lower bounds and `rowCount` is null;
 * `exact: false` with `sampled: false` means the scan was complete but a
 * selected value was cut to a budget, with a `$summary` or `$truncated`
 * placeholder marking each cut. Inspection samples are previews and are
 * exempt: a placeholder inside a sample is noted, and `exact` still speaks
 * for the counts. `converted` means a value was changed from its source text
 * (the readers never set it: inspection classifies and selection returns
 * source text or parsed JSON with precision preserved).
 */
export interface DataViewFlags {
	exact: boolean;
	sampled: boolean;
	converted: boolean;
}

export function exactView(): DataViewFlags {
	return { exact: true, sampled: false, converted: false };
}

export function sampledView(): DataViewFlags {
	return { exact: false, sampled: true, converted: false };
}

/** The scan was complete, but a returned value was cut to a budget. */
export function cutView(): DataViewFlags {
	return { exact: false, sampled: false, converted: false };
}

export type DataRefusalReason =
	| "not-found"
	| "not-a-file"
	| "read-error"
	| "invalid-utf8"
	| "binary"
	| "unsupported-format"
	| "aborted"
	| "invalid-json"
	| "nesting-too-deep"
	| "invalid-argument"
	| "pointer-not-found"
	| "selection-too-large"
	| "unknown-column";

/**
 * A typed refusal. The readers return one of these instead of interpreting
 * bytes they cannot honestly read: an invalid UTF-8 sequence names its byte
 * offset, a binary file says so, an unsupported format names the supported
 * ones, and a JSON syntax error names line, column, and byte offset.
 */
export interface DataRefusal {
	ok: false;
	reason: DataRefusalReason;
	message: string;
	path?: string;
	byteOffset?: number;
	line?: number;
	column?: number;
	supported?: ReadonlyArray<string>;
}

export class DataRefusalError extends Error {
	readonly refusal: DataRefusal;
	constructor(refusal: DataRefusal) {
		super(refusal.message);
		this.name = "DataRefusalError";
		this.refusal = refusal;
	}
}

export function refusal(
	reason: DataRefusalReason,
	message: string,
	extra: Omit<DataRefusal, "ok" | "reason" | "message"> = {},
): DataRefusal {
	return { ok: false, reason, message, ...extra };
}

export function isDataRefusal(value: unknown): value is DataRefusal {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { ok?: unknown }).ok === false &&
		typeof (value as { reason?: unknown }).reason === "string"
	);
}

/** Convert whatever a reader threw into the refusal it stands for. */
export function refusalFromError(error: unknown, path: string, signal?: AbortSignal | undefined): DataRefusal {
	if (error instanceof DataRefusalError) return { ...error.refusal, path };
	if (signal?.aborted) return refusal("aborted", "aborted before the scan finished", { path });
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code === "ENOENT") return refusal("not-found", `no file at ${path}`, { path });
	if (code === "EISDIR") return refusal("not-a-file", `${path} is a directory, not a data file`, { path });
	const message = error instanceof Error ? error.message : String(error);
	return refusal("read-error", `cannot read ${path}: ${message}`, { path });
}

function abortedRefusal(path: string): DataRefusal {
	return refusal("aborted", "aborted before the scan finished", { path });
}

export function throwIfAborted(signal: AbortSignal | undefined, path: string): void {
	if (signal?.aborted) throw new DataRefusalError(abortedRefusal(path));
}

/** Size and regular-file check, as a refusal when the path cannot be a data file. */
export function statDataFile(path: string): { size: number } | DataRefusal {
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return refusal("not-a-file", `${path} is not a regular file`, { path });
		return { size: stat.size };
	} catch (error) {
		return refusalFromError(error, path);
	}
}

// Well-formed UTF-8 byte sequences (Unicode 15, table 3-7). The decoder
// validates every sequence itself so an invalid byte is reported at its exact
// offset instead of surfacing as a silent U+FFFD from Buffer.toString.
const UTF8_LEAD_MIN = 0xc2;

/**
 * Incremental fatal UTF-8 decoder. `push` validates and decodes every complete
 * sequence in the chunk, carries an incomplete trailing sequence to the next
 * push, and throws an `invalid-utf8` refusal naming the absolute byte offset
 * where the first ill-formed sequence starts. `end` rejects a dangling partial
 * sequence.
 */
export class Utf8StreamDecoder {
	private pending: Buffer | null = null;
	/** Absolute byte offset of the first byte not yet decoded (the pending start). */
	private offset = 0;

	/** Absolute byte offset of the first byte the next decoded text will begin at. */
	get position(): number {
		return this.offset;
	}

	push(chunk: Buffer): string {
		const buffer = this.pending === null ? chunk : Buffer.concat([this.pending, chunk]);
		const length = buffer.length;
		let index = 0;
		while (index < length) {
			const lead = buffer[index] as number;
			if (lead < 0x80) {
				index += 1;
				continue;
			}
			let need: number;
			let secondMin = 0x80;
			let secondMax = 0xbf;
			if (lead >= UTF8_LEAD_MIN && lead <= 0xdf) need = 2;
			else if (lead === 0xe0) {
				need = 3;
				secondMin = 0xa0;
			} else if (lead >= 0xe1 && lead <= 0xec) need = 3;
			else if (lead === 0xed) {
				need = 3;
				secondMax = 0x9f;
			} else if (lead >= 0xee && lead <= 0xef) need = 3;
			else if (lead === 0xf0) {
				need = 4;
				secondMin = 0x90;
			} else if (lead >= 0xf1 && lead <= 0xf3) need = 4;
			else if (lead === 0xf4) {
				need = 4;
				secondMax = 0x8f;
			} else {
				throw this.invalid(index);
			}
			if (index + need > length) {
				// Incomplete at the chunk edge: validate what is present, carry the rest.
				const second = buffer[index + 1];
				if (second !== undefined && (second < secondMin || second > secondMax)) throw this.invalid(index);
				for (let k = 2; index + k < length; k += 1) {
					const byte = buffer[index + k] as number;
					if (byte < 0x80 || byte > 0xbf) throw this.invalid(index);
				}
				break;
			}
			const second = buffer[index + 1] as number;
			if (second < secondMin || second > secondMax) throw this.invalid(index);
			for (let k = 2; k < need; k += 1) {
				const byte = buffer[index + k] as number;
				if (byte < 0x80 || byte > 0xbf) throw this.invalid(index);
			}
			index += need;
		}
		const text = buffer.toString("utf8", 0, index);
		// Copy the carried tail: the caller may reuse its chunk buffer.
		this.pending = index < length ? Buffer.from(buffer.subarray(index)) : null;
		this.offset += index;
		return text;
	}

	end(): void {
		if (this.pending !== null) throw this.invalid(0);
	}

	private invalid(relativeIndex: number): DataRefusalError {
		const byteOffset = this.offset + relativeIndex;
		return new DataRefusalError(
			refusal(
				"invalid-utf8",
				`invalid UTF-8 sequence starting at byte offset ${byteOffset}; this is not a UTF-8 text file`,
				{
					byteOffset,
				},
			),
		);
	}
}

export interface TextChunk {
	text: string;
	/** Absolute byte offset of the first byte of `text` in the file. */
	byteOffset: number;
}

export interface TextStreamStats {
	/** Bytes read from disk so far, including a stripped byte-order mark. */
	bytesRead: number;
	bom: boolean;
}

export interface TextStreamOptions {
	signal?: AbortSignal | undefined;
	stats: TextStreamStats;
	highWaterMark?: number;
}

const BINARY_SNIFF_BYTES = 8192;
const DEFAULT_HIGH_WATER_MARK = 64 * 1024;

/**
 * Stream a file as decoded UTF-8 text chunks. Refuses a binary file (a NUL byte
 * within the first 8 KiB), an ill-formed UTF-8 file (at its byte offset), and
 * an abort; strips one leading byte-order mark and records it. Breaking out of
 * the loop destroys the underlying stream, so a reader that stops early never
 * reads the rest of the file.
 */
export async function* streamTextChunks(path: string, options: TextStreamOptions): AsyncGenerator<TextChunk, void> {
	const { signal, stats } = options;
	throwIfAborted(signal, path);
	const stream = createReadStream(path, { highWaterMark: options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK });
	const onAbort = (): void => {
		stream.destroy(new DataRefusalError(abortedRefusal(path)));
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	const decoder = new Utf8StreamDecoder();
	let sniffRemaining = BINARY_SNIFF_BYTES;
	let first = true;
	try {
		for await (const raw of stream) {
			const chunk = raw as Buffer;
			throwIfAborted(signal, path);
			stats.bytesRead += chunk.length;
			if (sniffRemaining > 0) {
				const probe = chunk.subarray(0, Math.min(sniffRemaining, chunk.length));
				const nul = probe.indexOf(0);
				if (nul !== -1) {
					throw new DataRefusalError(
						refusal("binary", `NUL byte at offset ${stats.bytesRead - chunk.length + nul}; this is a binary file`, {
							byteOffset: stats.bytesRead - chunk.length + nul,
						}),
					);
				}
				sniffRemaining -= probe.length;
			}
			let byteOffset = decoder.position;
			let text = decoder.push(chunk);
			if (first) {
				first = false;
				if (text.startsWith("﻿")) {
					stats.bom = true;
					text = text.slice(1);
					byteOffset += 3;
				}
			}
			if (text.length > 0) yield { text, byteOffset };
		}
		decoder.end();
	} catch (error) {
		throw error instanceof DataRefusalError ? error : new DataRefusalError(refusalFromError(error, path, signal));
	} finally {
		signal?.removeEventListener("abort", onAbort);
		stream.destroy();
	}
}

export type CellClass = "empty" | "sentinel" | "integer" | "float" | "boolean" | "date" | "string";
export type ColumnType = "integer" | "float" | "boolean" | "date" | "string" | "empty" | "mixed";

/** Tokens counted as missing-value sentinels. Counted, never converted. */
export const SENTINEL_TOKENS: ReadonlySet<string> = new Set(["NA", "N/A", "NaN", "null", "NULL", "None", "-"]);

const INTEGER_PATTERN = /^[+-]?\d+$/u;
const FLOAT_PATTERN = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/u;
const BOOLEAN_PATTERN = /^(?:true|false)$/iu;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u;

/** Classify one CSV cell by its source text. Whitespace is content: " " is a string, "" is empty. */
export function classifyCell(text: string): CellClass {
	if (text.length === 0) return "empty";
	if (SENTINEL_TOKENS.has(text)) return "sentinel";
	if (INTEGER_PATTERN.test(text)) return "integer";
	if (FLOAT_PATTERN.test(text)) return "float";
	if (BOOLEAN_PATTERN.test(text)) return "boolean";
	if (DATE_PATTERN.test(text)) return "date";
	return "string";
}

export function emptyCellHistogram(): Record<CellClass, number> {
	return { empty: 0, sentinel: 0, integer: 0, float: 0, boolean: 0, date: 0, string: 0 };
}

/**
 * The column type a histogram of cell classes supports. Only typed cells vote:
 * empties and sentinels are missing values, not evidence of a type. Integers
 * and floats together are float; any other mixture is mixed.
 */
export function inferColumnType(histogram: Record<CellClass, number>): ColumnType {
	const typed = (["integer", "float", "boolean", "date", "string"] as const).filter((cls) => histogram[cls] > 0);
	if (typed.length === 0) return "empty";
	if (typed.length === 1) return typed[0] as ColumnType;
	if (typed.every((cls) => cls === "integer" || cls === "float")) return "float";
	return "mixed";
}

export type PrecisionKind =
	| "unsafe-integer"
	| "excess-digits"
	| "inexact"
	| "overflow"
	| "underflow"
	| "oversized-literal";

export interface PrecisionIssue {
	kind: PrecisionKind;
	literal: string;
	/** JSON pointer of the value (JSON and JSONL). */
	path?: string;
	/** 1-based data row (CSV) or record line (JSONL). */
	row?: number;
	line?: number;
	/** 0-based column index (CSV). */
	column?: number;
}

const MAX_SIGNIFICANT_DIGITS = 17;
export const MAX_NUMBER_LITERAL_CHARS = 512;

/**
 * Canonical decimal form of a number literal: sign, significant digits with
 * leading and trailing zeros stripped, and a decimal exponent. Two literals
 * denote the same real number exactly when their canonical forms match, which
 * makes the form comparable across the source text and what JavaScript prints
 * for the double it parsed to. Null when the text is not a plain decimal.
 */
function canonicalDecimal(literal: string): string | null {
	const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(literal);
	if (match === null) return null;
	const intDigits = match[2] ?? "";
	const fracDigits = match[3] ?? "";
	if (intDigits.length === 0 && fracDigits.length === 0) return null;
	let digits = (intDigits + fracDigits).replace(/^0+/u, "");
	if (digits.length === 0) return "0";
	let exponent = Number(match[4] ?? "0") - fracDigits.length;
	const trimmed = digits.replace(/0+$/u, "");
	exponent += digits.length - trimmed.length;
	digits = trimmed;
	return `${match[1] === "-" ? "-" : ""}${digits}e${exponent}`;
}

/**
 * Whether reading this number literal as an IEEE double would misstate what
 * the text says. The double is judged by its canonical decimal form: when the
 * shortest round-trip form JavaScript prints for it differs from the literal's
 * own canonical form, the double does not denote the literal's value. The kind
 * names why: an integer beyond 2^53 - 1, more than 17 significant digits, a
 * value that overflows to infinity, one that underflows to zero, or a literal
 * within those limits that still has no exact double (`inexact`). A literal the
 * double represents exactly returns null.
 */
export function numberLiteralPrecision(literal: string): PrecisionKind | null {
	if (literal.length > MAX_NUMBER_LITERAL_CHARS) return "oversized-literal";
	const canonical = canonicalDecimal(literal);
	if (canonical === null) return null;
	const value = Number(literal);
	if (!Number.isFinite(value)) return "overflow";
	if (value === 0) return canonical === "0" ? null : "underflow";
	if (canonical === canonicalDecimal(String(value))) return null;
	const exponentAt = canonical.indexOf("e");
	const digits = canonical.slice(canonical.startsWith("-") ? 1 : 0, exponentAt);
	const exponent = Number(canonical.slice(exponentAt + 1));
	if (exponent >= 0 && Math.abs(value) > Number.MAX_SAFE_INTEGER) return "unsafe-integer";
	if (digits.length > MAX_SIGNIFICANT_DIGITS) return "excess-digits";
	return "inexact";
}

/**
 * Row bound for a scan. `undefined` takes the default, `null` (or a
 * non-finite number) means unbounded, and anything else is clamped to at
 * least one row.
 */
export function resolveMaxRows(value: number | null | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (value === null || !Number.isFinite(value)) return Number.POSITIVE_INFINITY;
	return Math.max(1, Math.floor(value));
}

export const SAMPLE_TEXT_CAP = 512;

/** Bound one sample cell for a report; the flag says whether anything was cut. */
export function capText(text: string, cap = SAMPLE_TEXT_CAP): { text: string; truncated: boolean } {
	if (text.length <= cap) return { text, truncated: false };
	return { text: `${Array.from(text).slice(0, cap).join("")}…`, truncated: true };
}

export function sampledNotice(rowsScanned: number, unit: string): string {
	return `sampled: ${rowsScanned} ${unit} scanned of an unknown total; counts are lower bounds and rowCount is null`;
}

/** Deterministic histogram rendering: insertion order, plain object. */
export function histogramRecord(map: ReadonlyMap<string, number>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [key, count] of map) out[key] = count;
	return out;
}
