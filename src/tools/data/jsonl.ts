import {
	JSON_PRECISION_FIRST_CAP,
	JSON_SAMPLE_BUDGET_CHARS,
	type JsonPrecisionReport,
	type JsonValue,
	type JsonValueType,
	scanJsonText,
} from "./json.js";
import {
	cutView,
	type DataRefusal,
	DataRefusalError,
	type DataViewFlags,
	exactView,
	histogramRecord,
	type PrecisionIssue,
	refusalFromError,
	resolveMaxRows,
	sampledNotice,
	sampledView,
	statDataFile,
	streamTextChunks,
	type TextStreamStats,
	throwIfAborted,
} from "./shared.js";

/**
 * Streaming JSON Lines reader. Each non-blank line is one record and is
 * scanned with the same push parser json.ts uses for whole documents, so
 * precision facts, duplicate keys, and syntax faults carry the line number
 * they belong to. Memory holds one line, the bounded sample, and per-key
 * counters.
 */

export interface JsonlInvalidLine {
	line: number;
	message: string;
}

export interface JsonlInspectResult {
	ok: true;
	format: "jsonl";
	path: string;
	bytes: number;
	bytesScanned: number;
	view: DataViewFlags;
	/** Non-blank lines scanned. */
	rowsScanned: number;
	/** Non-blank lines in the file; null when the scan stopped at maxRows. */
	rowCount: number | null;
	/** Physical lines scanned, blank lines included. */
	linesScanned: number;
	blankLines: number;
	invalid: { count: number; first: JsonlInvalidLine[] };
	/** Root value types over the scanned records. */
	rootTypes: Record<string, number>;
	/** Top-level key presence over object records, in first-seen order, capped. */
	keys: { histogram: Record<string, number>; truncated: boolean };
	/** Top-level value types by key over object records. */
	keyTypes: Record<string, Record<string, number>>;
	maxDepth: number;
	duplicateKeys: { count: number; firstLine: number | null };
	precision: JsonPrecisionReport;
	/** First valid records, each within the sample budget; numbers with a precision issue keep their literal. */
	sample: Array<{ line: number; value: JsonValue }>;
	notes: string[];
}

export interface JsonlInspectOptions {
	sampleRows?: number;
	maxRows?: number | null;
	signal?: AbortSignal | undefined;
}

export const JSONL_DEFAULT_SAMPLE_ROWS = 10;
export const JSONL_DEFAULT_MAX_ROWS = 100_000;
const KEY_HISTOGRAM_CAP = 500;
const INVALID_FIRST_CAP = 10;

function oversizedMessage(chars: number): string {
	return `line is ${chars} characters, over the ${JSONL_MAX_LINE_CHARS}-character limit for one JSONL record; skipped without being read (a whole JSON document saved as .jsonl looks like this: read it with format json)`;
}

interface LineVisitor {
	/** A non-blank line within the length cap. Return false to stop. */
	onLine(text: string, line: number): boolean;
	/** A line longer than JSONL_MAX_LINE_CHARS, skipped without being held. Return false to stop. */
	onOversized(line: number, chars: number): boolean;
	onBlank?(line: number): void;
}

/** Longest line held in memory; a longer one is skipped and reported by line number. */
export const JSONL_MAX_LINE_CHARS = 1_048_576;

/**
 * Split decoded chunks into physical lines, stripping one trailing CR. A
 * partial line carries across chunks up to JSONL_MAX_LINE_CHARS; past that the
 * line is dropped as it streams and reported once its terminator arrives, so a
 * whole JSON document saved with a .jsonl name costs nothing to hold. The last
 * line needs no terminator.
 */
async function forEachLine(
	path: string,
	signal: AbortSignal | undefined,
	stats: TextStreamStats,
	visitor: LineVisitor,
): Promise<{ lines: number; stopped: boolean }> {
	let carry = "";
	let skipping = false;
	let skippedChars = 0;
	let line = 0;
	let stopped = false;
	const emit = (text: string): boolean => {
		line += 1;
		const body = text.endsWith("\r") ? text.slice(0, -1) : text;
		if (body.trim().length === 0) {
			visitor.onBlank?.(line);
			return true;
		}
		return visitor.onLine(body, line);
	};
	const emitOversized = (chars: number): boolean => {
		line += 1;
		return visitor.onOversized(line, chars);
	};
	outer: for await (const chunk of streamTextChunks(path, { signal, stats })) {
		const text = chunk.text;
		let start = 0;
		for (;;) {
			const newline = text.indexOf("\n", start);
			if (newline === -1) break;
			const span = newline - start;
			if (skipping) {
				skipping = false;
				if (!emitOversized(skippedChars + span)) {
					stopped = true;
					break outer;
				}
			} else if (carry.length + span > JSONL_MAX_LINE_CHARS) {
				const chars = carry.length + span;
				carry = "";
				if (!emitOversized(chars)) {
					stopped = true;
					break outer;
				}
			} else {
				const lineText = carry.length === 0 ? text.slice(start, newline) : carry + text.slice(start, newline);
				carry = "";
				if (!emit(lineText)) {
					stopped = true;
					break outer;
				}
			}
			start = newline + 1;
		}
		const rest = text.length - start;
		if (rest === 0) continue;
		if (skipping) skippedChars += rest;
		else if (carry.length + rest > JSONL_MAX_LINE_CHARS) {
			skipping = true;
			skippedChars = carry.length + rest;
			carry = "";
		} else carry += text.slice(start);
	}
	throwIfAborted(signal, path);
	if (!stopped) {
		if (skipping) emitOversized(skippedChars);
		else if (carry.length > 0 && !emit(carry)) stopped = true;
	}
	return { lines: line, stopped };
}

export async function inspectJsonl(
	path: string,
	options: JsonlInspectOptions = {},
): Promise<JsonlInspectResult | DataRefusal> {
	const stat = statDataFile(path);
	if ("ok" in stat) return stat;
	const sampleRows = Math.max(0, Math.min(1000, Math.floor(options.sampleRows ?? JSONL_DEFAULT_SAMPLE_ROWS)));
	const maxRows = resolveMaxRows(options.maxRows, JSONL_DEFAULT_MAX_ROWS);
	const stats: TextStreamStats = { bytesRead: 0, bom: false };
	const state = {
		records: 0,
		blank: 0,
		stoppedAtRows: false,
		invalidCount: 0,
		invalidFirst: [] as JsonlInvalidLine[],
		rootTypes: new Map<string, number>(),
		keys: new Map<string, number>(),
		keysTruncated: false,
		keyTypes: new Map<string, Map<string, number>>(),
		maxDepth: 0,
		duplicateCount: 0,
		duplicateFirstLine: null as number | null,
		precisionCount: 0,
		precisionFirst: [] as PrecisionIssue[],
		sample: [] as Array<{ line: number; value: JsonValue }>,
		sampleCuts: 0,
	};
	let scanOutcome: { lines: number; stopped: boolean };
	try {
		scanOutcome = await forEachLine(path, options.signal, stats, {
			onBlank() {
				state.blank += 1;
			},
			onOversized(line, chars) {
				if (state.records >= maxRows) {
					state.stoppedAtRows = true;
					return false;
				}
				state.records += 1;
				state.invalidCount += 1;
				if (state.invalidFirst.length < INVALID_FIRST_CAP) {
					state.invalidFirst.push({ line, message: oversizedMessage(chars) });
				}
				return true;
			},
			onLine(text, line) {
				if (state.records >= maxRows) {
					state.stoppedAtRows = true;
					return false;
				}
				state.records += 1;
				const wantSample = state.sample.length < sampleRows;
				let scan: ReturnType<typeof scanJsonText>;
				try {
					scan = scanJsonText(text, {
						pointerPrefix: "",
						materializeBudgetChars: wantSample ? JSON_SAMPLE_BUDGET_CHARS : null,
					});
				} catch (error) {
					if (!(error instanceof DataRefusalError)) throw error;
					state.invalidCount += 1;
					if (state.invalidFirst.length < INVALID_FIRST_CAP) {
						state.invalidFirst.push({ line, message: error.refusal.message });
					}
					return true;
				}
				state.rootTypes.set(scan.root, (state.rootTypes.get(scan.root) ?? 0) + 1);
				if (scan.root === "object") {
					for (const key of new Set(scan.keys)) {
						const seen = state.keys.get(key);
						if (seen === undefined) {
							if (state.keys.size >= KEY_HISTOGRAM_CAP) {
								state.keysTruncated = true;
								continue;
							}
							state.keys.set(key, 1);
						} else state.keys.set(key, seen + 1);
						const type = scan.memberTypes.get(key) as JsonValueType | undefined;
						if (type === undefined) continue;
						let types = state.keyTypes.get(key);
						if (types === undefined) {
							types = new Map();
							state.keyTypes.set(key, types);
						}
						types.set(type, (types.get(type) ?? 0) + 1);
					}
				}
				if (scan.maxDepth > state.maxDepth) state.maxDepth = scan.maxDepth;
				if (scan.duplicateKeys > 0) {
					state.duplicateCount += scan.duplicateKeys;
					if (state.duplicateFirstLine === null) state.duplicateFirstLine = line;
				}
				for (const issue of scan.precision) {
					state.precisionCount += 1;
					if (state.precisionFirst.length < JSON_PRECISION_FIRST_CAP) state.precisionFirst.push({ ...issue, line });
				}
				if (wantSample && scan.value !== undefined) {
					state.sample.push({ line, value: scan.value });
					if (scan.valueTruncated) state.sampleCuts += 1;
				}
				return true;
			},
		});
	} catch (error) {
		return refusalFromError(error, path, options.signal);
	}
	const sampled = state.stoppedAtRows;
	const notes: string[] = [];
	if (stats.bom) notes.push("a UTF-8 byte-order mark was stripped");
	if (sampled) notes.push(sampledNotice(state.records, "records"));
	if (state.invalidCount > 0)
		notes.push(`${state.invalidCount} line(s) are not valid JSON and are listed with their fault`);
	if (state.keysTruncated) notes.push(`key histogram capped at ${KEY_HISTOGRAM_CAP} distinct keys`);
	if (state.sampleCuts > 0) {
		notes.push(
			`${state.sampleCuts} sample record(s) were cut to the preview budget and carry $summary or $truncated placeholders; the counts are exact`,
		);
	}
	const keyTypes: Record<string, Record<string, number>> = {};
	for (const [key, types] of state.keyTypes) keyTypes[key] = histogramRecord(types);
	return {
		ok: true,
		format: "jsonl",
		path,
		bytes: stat.size,
		bytesScanned: stats.bytesRead,
		view: sampled ? sampledView() : exactView(),
		rowsScanned: state.records,
		rowCount: sampled ? null : state.records,
		linesScanned: scanOutcome.lines,
		blankLines: state.blank,
		invalid: { count: state.invalidCount, first: state.invalidFirst },
		rootTypes: histogramRecord(state.rootTypes),
		keys: { histogram: histogramRecord(state.keys), truncated: state.keysTruncated },
		keyTypes,
		maxDepth: state.maxDepth,
		duplicateKeys: { count: state.duplicateCount, firstLine: state.duplicateFirstLine },
		precision: { count: state.precisionCount, first: state.precisionFirst },
		sample: state.sample,
		notes,
	};
}

export interface JsonlSelectOptions {
	/** 0-based first record (non-blank line) to return. */
	offset?: number;
	limit?: number;
	signal?: AbortSignal | undefined;
}

export const JSONL_SELECT_DEFAULT_LIMIT = 50;
export const JSONL_SELECT_MAX_LIMIT = 1000;
const SELECT_LINE_BUDGET_CHARS = 1_048_576;

export type JsonlSelectedRecord =
	| { line: number; value: JsonValue; truncated: boolean }
	| { line: number; error: string };

export interface JsonlSelectResult {
	ok: true;
	format: "jsonl";
	path: string;
	bytes: number;
	bytesScanned: number;
	view: DataViewFlags;
	offset: number;
	limit: number;
	returned: number;
	hasMore: boolean;
	/** Records parsed to produce the window, skipped prefix included. */
	rowsScanned: number;
	records: JsonlSelectedRecord[];
	precision: JsonPrecisionReport;
	/** Duplicate object keys inside the returned records; materialization kept the last value. */
	duplicateKeys: { count: number; firstLine: number | null };
	notes: string[];
}

export async function selectJsonl(
	path: string,
	options: JsonlSelectOptions = {},
): Promise<JsonlSelectResult | DataRefusal> {
	const stat = statDataFile(path);
	if ("ok" in stat) return stat;
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	const limit = Math.max(1, Math.min(JSONL_SELECT_MAX_LIMIT, Math.floor(options.limit ?? JSONL_SELECT_DEFAULT_LIMIT)));
	const stats: TextStreamStats = { bytesRead: 0, bom: false };
	const state = {
		records: 0,
		hasMore: false,
		out: [] as JsonlSelectedRecord[],
		precisionCount: 0,
		precisionFirst: [] as PrecisionIssue[],
		duplicateCount: 0,
		duplicateFirstLine: null as number | null,
	};
	try {
		await forEachLine(path, options.signal, stats, {
			onOversized(line, chars) {
				const index = state.records;
				state.records += 1;
				if (index < offset) return true;
				if (state.out.length >= limit) {
					state.hasMore = true;
					return false;
				}
				state.out.push({ line, error: oversizedMessage(chars) });
				return true;
			},
			onLine(text, line) {
				const index = state.records;
				state.records += 1;
				if (index < offset) return true;
				if (state.out.length >= limit) {
					state.hasMore = true;
					return false;
				}
				try {
					const scan = scanJsonText(text, { materializeBudgetChars: SELECT_LINE_BUDGET_CHARS });
					for (const issue of scan.precision) {
						state.precisionCount += 1;
						if (state.precisionFirst.length < JSON_PRECISION_FIRST_CAP) state.precisionFirst.push({ ...issue, line });
					}
					if (scan.duplicateKeys > 0) {
						state.duplicateCount += scan.duplicateKeys;
						if (state.duplicateFirstLine === null) state.duplicateFirstLine = line;
					}
					state.out.push({ line, value: scan.value ?? null, truncated: scan.valueTruncated });
				} catch (error) {
					if (!(error instanceof DataRefusalError)) throw error;
					state.out.push({ line, error: error.refusal.message });
				}
				return true;
			},
		});
	} catch (error) {
		return refusalFromError(error, path, options.signal);
	}
	const notes: string[] = [];
	if (stats.bom) notes.push("a UTF-8 byte-order mark was stripped");
	const truncated = state.out.filter((record) => "truncated" in record && record.truncated).length;
	if (truncated > 0) {
		notes.push(
			`${truncated} record(s) were cut to the per-record budget or the string cap; $summary and $truncated placeholders mark the cuts`,
		);
	}
	if (state.duplicateCount > 0) {
		notes.push(`${state.duplicateCount} duplicate object key(s) in the returned records; the last value was kept`);
	}
	return {
		ok: true,
		format: "jsonl",
		path,
		bytes: stat.size,
		bytesScanned: stats.bytesRead,
		view: truncated > 0 ? cutView() : exactView(),
		offset,
		limit,
		returned: state.out.length,
		hasMore: state.hasMore,
		rowsScanned: state.records,
		records: state.out,
		precision: { count: state.precisionCount, first: state.precisionFirst },
		duplicateKeys: { count: state.duplicateCount, firstLine: state.duplicateFirstLine },
		notes,
	};
}

export interface JsonlValidateOptions {
	maxRows?: number | null;
	signal?: AbortSignal | undefined;
}

export interface JsonlValidateResult {
	ok: true;
	format: "jsonl";
	path: string;
	bytes: number;
	bytesScanned: number;
	view: DataViewFlags;
	/** True when every scanned record parsed and the scan reached the end; null when it stopped at maxRows without a fault. */
	valid: boolean | null;
	complete: boolean;
	rowsScanned: number;
	rowCount: number | null;
	linesScanned: number;
	blankLines: number;
	invalid: { count: number; first: JsonlInvalidLine[] };
	duplicateKeys: { count: number; firstLine: number | null };
	precision: JsonPrecisionReport;
	notes: string[];
}

export async function validateJsonl(
	path: string,
	options: JsonlValidateOptions = {},
): Promise<JsonlValidateResult | DataRefusal> {
	const stat = statDataFile(path);
	if ("ok" in stat) return stat;
	const maxRows = resolveMaxRows(options.maxRows, JSONL_DEFAULT_MAX_ROWS);
	const stats: TextStreamStats = { bytesRead: 0, bom: false };
	const state = {
		records: 0,
		blank: 0,
		stoppedAtRows: false,
		invalidCount: 0,
		invalidFirst: [] as JsonlInvalidLine[],
		duplicateCount: 0,
		duplicateFirstLine: null as number | null,
		precisionCount: 0,
		precisionFirst: [] as PrecisionIssue[],
	};
	let scanOutcome: { lines: number; stopped: boolean };
	try {
		scanOutcome = await forEachLine(path, options.signal, stats, {
			onBlank() {
				state.blank += 1;
			},
			onOversized(line, chars) {
				if (state.records >= maxRows) {
					state.stoppedAtRows = true;
					return false;
				}
				state.records += 1;
				state.invalidCount += 1;
				if (state.invalidFirst.length < INVALID_FIRST_CAP) {
					state.invalidFirst.push({ line, message: oversizedMessage(chars) });
				}
				return true;
			},
			onLine(text, line) {
				if (state.records >= maxRows) {
					state.stoppedAtRows = true;
					return false;
				}
				state.records += 1;
				try {
					const scan = scanJsonText(text);
					if (scan.duplicateKeys > 0) {
						state.duplicateCount += scan.duplicateKeys;
						if (state.duplicateFirstLine === null) state.duplicateFirstLine = line;
					}
					for (const issue of scan.precision) {
						state.precisionCount += 1;
						if (state.precisionFirst.length < JSON_PRECISION_FIRST_CAP) state.precisionFirst.push({ ...issue, line });
					}
				} catch (error) {
					if (!(error instanceof DataRefusalError)) throw error;
					state.invalidCount += 1;
					if (state.invalidFirst.length < INVALID_FIRST_CAP) {
						state.invalidFirst.push({ line, message: error.refusal.message });
					}
				}
				return true;
			},
		});
	} catch (error) {
		return refusalFromError(error, path, options.signal);
	}
	const complete = !state.stoppedAtRows;
	const notes: string[] = [];
	if (stats.bom) notes.push("a UTF-8 byte-order mark was stripped");
	if (!complete) {
		notes.push(
			`validation incomplete: stopped after ${state.records} records; pass maxRows null to validate the whole file`,
		);
	}
	if (state.invalidCount > 0) notes.push(`${state.invalidCount} line(s) are not valid JSON`);
	if (state.duplicateCount > 0)
		notes.push(`${state.duplicateCount} duplicate object key(s); JSON.parse would keep the last value`);
	return {
		ok: true,
		format: "jsonl",
		path,
		bytes: stat.size,
		bytesScanned: stats.bytesRead,
		view: complete ? exactView() : sampledView(),
		valid: state.invalidCount > 0 ? false : complete ? true : null,
		complete,
		rowsScanned: state.records,
		rowCount: complete ? state.records : null,
		linesScanned: scanOutcome.lines,
		blankLines: state.blank,
		invalid: { count: state.invalidCount, first: state.invalidFirst },
		duplicateKeys: { count: state.duplicateCount, firstLine: state.duplicateFirstLine },
		precision: { count: state.precisionCount, first: state.precisionFirst },
		notes,
	};
}
