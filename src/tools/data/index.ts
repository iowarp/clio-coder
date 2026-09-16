import { open } from "node:fs/promises";
import { extname } from "node:path";
import {
	type CsvHeaderOption,
	type CsvInspectResult,
	type CsvSelectResult,
	type CsvValidateResult,
	inspectCsv,
	selectCsv,
	validateCsv,
} from "./csv.js";
import {
	inspectJson,
	type JsonInspectResult,
	type JsonSelectResult,
	type JsonValidateResult,
	selectJson,
	validateJson,
} from "./json.js";
import {
	inspectJsonl,
	type JsonlInspectResult,
	type JsonlSelectResult,
	type JsonlValidateResult,
	selectJsonl,
	validateJsonl,
} from "./jsonl.js";
import {
	DATA_FORMATS,
	type DataFormat,
	type DataRefusal,
	isDataFormat,
	refusal,
	refusalFromError,
	statDataFile,
} from "./shared.js";

/**
 * Public entry points for structured-data inspection, selection, and
 * validation over CSV/TSV, JSON, and JSON Lines files. Every function streams,
 * returns a JSON-serializable result whose `view` says whether it is exact or
 * sampled, and refuses with a typed reason instead of guessing at bytes it
 * cannot read as the declared format.
 */

export type {
	CsvColumnReport,
	CsvHeaderOption,
	CsvInspectResult,
	CsvIssue,
	CsvRaggedRow,
	CsvSelectResult,
	CsvValidateResult,
} from "./csv.js";
export type {
	JsonDuplicateKeyReport,
	JsonInspectResult,
	JsonLiteralPlaceholder,
	JsonPrecisionReport,
	JsonSampleMember,
	JsonSelectResult,
	JsonSummaryPlaceholder,
	JsonTruncatedString,
	JsonValidateResult,
	JsonValue,
	JsonValueType,
} from "./json.js";
export type {
	JsonlInspectResult,
	JsonlInvalidLine,
	JsonlSelectedRecord,
	JsonlSelectResult,
	JsonlValidateResult,
} from "./jsonl.js";
export type {
	CellClass,
	ColumnType,
	DataFormat,
	DataRefusal,
	DataRefusalReason,
	DataViewFlags,
	PrecisionIssue,
	PrecisionKind,
} from "./shared.js";
export { DATA_FORMATS, isDataFormat, isDataRefusal, SENTINEL_TOKENS } from "./shared.js";

const EXTENSION_FORMATS: Readonly<Record<string, DataFormat>> = {
	".csv": "csv",
	".tsv": "tsv",
	".tab": "tsv",
	".json": "json",
	".jsonl": "jsonl",
	".ndjson": "jsonl",
};

const SNIFF_BYTES = 4096;

/**
 * Resolve the format of a data file: the explicit argument wins, then the
 * extension, then a bounded look at the first bytes. Null means the file is
 * not recognizably one of the supported formats; callers refuse with
 * `unsupported-format` rather than reading it as something it is not.
 */
export async function detectDataFormat(path: string, explicit?: string | null): Promise<DataFormat | null> {
	if (explicit !== undefined && explicit !== null) {
		const normalized = explicit.trim().toLowerCase();
		return isDataFormat(normalized) ? normalized : null;
	}
	const byExtension = EXTENSION_FORMATS[extname(path).toLowerCase()];
	if (byExtension !== undefined) return byExtension;
	let text: string;
	try {
		const handle = await open(path, "r");
		try {
			const buffer = Buffer.alloc(SNIFF_BYTES);
			const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
			text = buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
	if (text.startsWith("﻿")) text = text.slice(1);
	const trimmed = text.trimStart();
	if (trimmed.length === 0) return null;
	const first = trimmed[0];
	if (first === "[" || first === "{") {
		// One JSON document per line reads as JSONL when a second line also opens a value.
		const lines = trimmed.split(/\r?\n/u).filter((line) => line.trim().length > 0);
		const second = lines[1]?.trimStart()[0];
		if (lines.length > 1 && (second === "{" || second === "[") && (lines[0] ?? "").trimEnd().endsWith("}")) {
			return "jsonl";
		}
		return "json";
	}
	const firstLine = trimmed.split(/\r?\n/u)[0] ?? "";
	if (firstLine.includes("\t")) return "tsv";
	if (firstLine.includes(",") || firstLine.includes(";") || firstLine.includes("|")) return "csv";
	return null;
}

function unsupported(path: string, explicit: string | null | undefined): DataRefusal {
	const named = explicit === undefined || explicit === null ? "" : ` (${JSON.stringify(explicit)})`;
	return refusal(
		"unsupported-format",
		`${path} is not a supported structured-data format${named}; supported formats are ${DATA_FORMATS.join(", ")}. Pass format explicitly for a file with an unusual extension, or use run_script with a library for binary scientific formats.`,
		{ path, supported: DATA_FORMATS },
	);
}

export interface InspectDataOptions {
	/** csv, tsv, json, or jsonl; detected from the extension or content when omitted. */
	format?: string | null;
	/** CSV/TSV delimiter override (one character or \t). */
	delimiter?: string;
	/** CSV/TSV header handling: "auto" (default), true, or false. */
	header?: CsvHeaderOption;
	/** Rows (CSV, JSONL) or top-level elements/members (JSON) kept as the sample; default 10, max 1000. */
	sampleRows?: number;
	/** Rows scanned before the view becomes sampled; default 100000, null for unbounded. */
	maxRows?: number | null;
	signal?: AbortSignal | undefined;
}

export type InspectDataResult = CsvInspectResult | JsonInspectResult | JsonlInspectResult;

export async function inspectData(
	path: string,
	options: InspectDataOptions = {},
): Promise<InspectDataResult | DataRefusal> {
	const stat = statDataFile(path);
	if ("ok" in stat) return stat;
	const format = await detectDataFormat(path, options.format);
	if (format === null) return unsupported(path, options.format);
	const shared = {
		...(options.sampleRows !== undefined ? { sampleRows: options.sampleRows } : {}),
		...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
		signal: options.signal,
	};
	try {
		switch (format) {
			case "csv":
			case "tsv":
				return await inspectCsv(path, {
					...shared,
					format,
					...(options.delimiter !== undefined ? { delimiter: options.delimiter } : {}),
					...(options.header !== undefined ? { header: options.header } : {}),
				});
			case "json":
				return await inspectJson(path, shared);
			case "jsonl":
				return await inspectJsonl(path, shared);
		}
	} catch (error) {
		return refusalFromError(error, path, options.signal);
	}
}

export interface SelectDataOptions {
	format?: string | null;
	delimiter?: string;
	header?: CsvHeaderOption;
	/** CSV, JSONL, and JSON array windows: 0-based first row. */
	offset?: number;
	/** Rows returned; default 50, max 1000. */
	limit?: number;
	/** CSV/TSV: header names or 0-based indices to project. */
	columns?: ReadonlyArray<string | number>;
	/** JSON: RFC 6901 pointer to the value to return; "" is the whole document. */
	pointer?: string;
	signal?: AbortSignal | undefined;
}

export type SelectDataResult = CsvSelectResult | JsonSelectResult | JsonlSelectResult;

export async function selectData(
	path: string,
	options: SelectDataOptions = {},
): Promise<SelectDataResult | DataRefusal> {
	const stat = statDataFile(path);
	if ("ok" in stat) return stat;
	const format = await detectDataFormat(path, options.format);
	if (format === null) return unsupported(path, options.format);
	const window = {
		...(options.offset !== undefined ? { offset: options.offset } : {}),
		...(options.limit !== undefined ? { limit: options.limit } : {}),
		signal: options.signal,
	};
	try {
		switch (format) {
			case "csv":
			case "tsv":
				return await selectCsv(path, {
					...window,
					format,
					...(options.delimiter !== undefined ? { delimiter: options.delimiter } : {}),
					...(options.header !== undefined ? { header: options.header } : {}),
					...(options.columns !== undefined ? { columns: options.columns } : {}),
				});
			case "json":
				if (options.columns !== undefined) {
					return refusal("invalid-argument", "columns applies to CSV/TSV; use pointer for a JSON document", { path });
				}
				return await selectJson(path, {
					...window,
					...(options.pointer !== undefined ? { pointer: options.pointer } : {}),
				});
			case "jsonl":
				if (options.pointer !== undefined) {
					return refusal(
						"invalid-argument",
						"pointer applies to a JSON document; JSONL selects records by offset and limit",
						{
							path,
						},
					);
				}
				return await selectJsonl(path, window);
		}
	} catch (error) {
		return refusalFromError(error, path, options.signal);
	}
}

export interface ValidateDataOptions {
	format?: string | null;
	delimiter?: string;
	header?: CsvHeaderOption;
	/** Rows checked before the verdict becomes partial; default 100000, null for the whole file. */
	maxRows?: number | null;
	signal?: AbortSignal | undefined;
}

export type ValidateDataResult = CsvValidateResult | JsonValidateResult | JsonlValidateResult;

export async function validateData(
	path: string,
	options: ValidateDataOptions = {},
): Promise<ValidateDataResult | DataRefusal> {
	const stat = statDataFile(path);
	if ("ok" in stat) return stat;
	const format = await detectDataFormat(path, options.format);
	if (format === null) return unsupported(path, options.format);
	const shared = {
		...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
		signal: options.signal,
	};
	try {
		switch (format) {
			case "csv":
			case "tsv":
				return await validateCsv(path, {
					...shared,
					format,
					...(options.delimiter !== undefined ? { delimiter: options.delimiter } : {}),
					...(options.header !== undefined ? { header: options.header } : {}),
				});
			case "json":
				return await validateJson(path, shared);
			case "jsonl":
				return await validateJsonl(path, shared);
		}
	} catch (error) {
		return refusalFromError(error, path, options.signal);
	}
}
