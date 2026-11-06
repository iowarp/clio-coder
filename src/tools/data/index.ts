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
import type { ScientificRequest, ScientificResult } from "./scientific-shared.js";
import {
	DATA_FORMATS,
	type DataFormat,
	type DataRefusal,
	isDataFormat,
	refusal,
	refusalFromError,
	statDataFile,
} from "./shared.js";
import type { SqliteInspectResult, SqliteSelectResult } from "./sqlite.js";

/**
 * Public entry points for structured-data inspection, selection, and
 * validation over CSV/TSV, JSON, and JSON Lines files, plus read-only
 * inspection and selection over SQLite databases. Every function streams,
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
export type { ScientificResult } from "./scientific-shared.js";
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
export type { SqliteColumn, SqliteInspectResult, SqliteObject, SqliteSelectResult } from "./sqlite.js";

const EXTENSION_FORMATS: Readonly<Record<string, DataFormat>> = {
	".csv": "csv",
	".tsv": "tsv",
	".tab": "tsv",
	".json": "json",
	".jsonl": "jsonl",
	".ndjson": "jsonl",
	".sqlite": "sqlite",
	".sqlite3": "sqlite",
	".db": "sqlite",
	".db3": "sqlite",
	".h5": "hdf5",
	".hdf5": "hdf5",
	".hdf": "hdf5",
	".he5": "hdf5",
	".nc": "netcdf",
	".nc4": "netcdf",
	".netcdf": "netcdf",
	".cdf": "netcdf",
	".parquet": "parquet",
	".parq": "parquet",
	".pq": "parquet",
};

// The SQLite header string, kept here so detection never loads the reader.
const SQLITE_MAGIC = "SQLite format 3\0";
const HDF5_MAGIC = Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);
/** HDF5 allows a user block before the superblock, so its signature may sit at 0, 512, 1024, 2048, ... */
const HDF5_SIGNATURE_OFFSETS = [0, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];

type ScientificFormat = "hdf5" | "netcdf" | "parquet";

function isScientificFormat(format: DataFormat): format is ScientificFormat {
	return format === "hdf5" || format === "netcdf" || format === "parquet";
}
type ScientificContainer = ScientificRequest["container"];

async function readPrefix(path: string, length: number, position: number): Promise<Buffer> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, position);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

async function hasHdf5Signature(path: string): Promise<boolean> {
	for (const offset of HDF5_SIGNATURE_OFFSETS) {
		const bytes = await readPrefix(path, HDF5_MAGIC.length, offset);
		if (bytes.length < HDF5_MAGIC.length) return false;
		if (bytes.equals(HDF5_MAGIC)) return true;
	}
	return false;
}

/**
 * The container a scientific file really is, from its signature: NetCDF-4 is
 * HDF5 underneath and goes to the HDF5 reader, classic NetCDF (CDF 1, 2 or 5)
 * to the native one. A file whose bytes match none is refused, whatever its
 * extension says.
 */
async function scientificContainer(path: string, format: DataFormat): Promise<ScientificContainer | DataRefusal> {
	const head = await readPrefix(path, 4, 0);
	if (format === "parquet") {
		if (head.toString("latin1") === "PAR1") return "parquet";
		return refusal("unsupported-format", `${path} does not start with the Parquet signature PAR1`, { path });
	}
	if (head.length === 4 && head.toString("latin1", 0, 3) === "CDF") {
		if ([1, 2, 5].includes(head[3] as number)) return "netcdf3";
		return refusal("unsupported-format", `${path} has CDF version byte ${head[3]}; classic NetCDF is version 1, 2 or 5`, {
			path,
		});
	}
	if (await hasHdf5Signature(path)) return "hdf5";
	return refusal(
		"unsupported-format",
		`${path} is neither HDF5 (NetCDF-4) nor classic NetCDF: it has no HDF5 signature and does not start with CDF`,
		{ path },
	);
}

async function runScientificOp(
	op: ScientificRequest["op"],
	path: string,
	format: DataFormat,
	request: Omit<ScientificRequest, "op" | "container" | "path">,
	signal: AbortSignal | undefined,
): Promise<ScientificResult | DataRefusal> {
	const container = await scientificContainer(path, format);
	if (typeof container !== "string") return container;
	return (await import("./scientific.js")).runScientific({ op, container, path, ...request }, signal);
}

/** The scientific request fields an options object carries, without undefined members. */
function scientificFields(options: ScientificOptions): Omit<ScientificRequest, "op" | "container" | "path"> {
	return {
		...(options.variable !== undefined ? { variable: options.variable } : {}),
		...(options.start !== undefined ? { start: options.start } : {}),
		...(options.count !== undefined ? { count: options.count } : {}),
		...(options.stride !== undefined ? { stride: options.stride } : {}),
		...(options.offset !== undefined ? { offset: options.offset } : {}),
		...(options.limit !== undefined ? { limit: options.limit } : {}),
		...(options.columns !== undefined ? { columns: options.columns.map(String) } : {}),
		...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
	};
}

export interface ScientificOptions {
	/** HDF5/NetCDF: variable or group path; Parquet stats: column. */
	variable?: string;
	/** HDF5/NetCDF hyperslab, one entry per dimension. */
	start?: number[];
	count?: number[];
	stride?: number[];
	offset?: number;
	limit?: number;
	columns?: ReadonlyArray<string | number>;
	/** stats: raw bytes read before the pass stops. */
	maxBytes?: number;
}

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
		const head = await readPrefix(path, 8, 0);
		if (head.equals(HDF5_MAGIC)) return "hdf5";
		if (head.length >= 4 && head.toString("latin1", 0, 3) === "CDF" && [1, 2, 5].includes(head[3] as number))
			return "netcdf";
		if (head.length >= 4 && head.toString("latin1", 0, 4) === "PAR1") return "parquet";
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
	if (text.startsWith(SQLITE_MAGIC)) return "sqlite";
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
		`${path} is not a supported structured-data format${named}; supported formats are ${DATA_FORMATS.join(", ")}. Pass format explicitly for a file with an unusual extension, or use run_script with a library for other binary formats.`,
		{ path, supported: DATA_FORMATS },
	);
}

export interface InspectDataOptions extends Pick<ScientificOptions, "variable"> {
	/** Detected from the extension or content when omitted. */
	format?: string | null;
	/** CSV/TSV delimiter override (one character or \t). */
	delimiter?: string;
	/** CSV/TSV header handling: "auto" (default), true, or false. */
	header?: CsvHeaderOption;
	/** SQLite: the table to count and sample. */
	table?: string;
	/** Rows (CSV, JSONL, SQLite table) or top-level elements/members (JSON) kept as the sample; default 10, max 1000. */
	sampleRows?: number;
	/** Rows scanned before the view becomes sampled; default 100000, null for unbounded. */
	maxRows?: number | null;
	signal?: AbortSignal | undefined;
}

export type InspectDataResult =
	| CsvInspectResult
	| JsonInspectResult
	| JsonlInspectResult
	| SqliteInspectResult
	| ScientificResult;

export async function inspectData(
	path: string,
	options: InspectDataOptions = {},
): Promise<InspectDataResult | DataRefusal> {
	const stat = statDataFile(path);
	if ("ok" in stat) return stat;
	const format = await detectDataFormat(path, options.format);
	if (format === null) return unsupported(path, options.format);
	if (isScientificFormat(format)) {
		return runScientificOp("inspect", path, format, scientificFields(options), options.signal);
	}
	if (options.variable !== undefined) {
		return refusal("invalid-argument", "variable applies to HDF5, NetCDF and Parquet files", { path });
	}
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
			case "sqlite":
				return await (await import("./sqlite.js")).inspectSqlite(path, stat.size, {
					...shared,
					...(options.table !== undefined ? { table: options.table } : {}),
				});
		}
	} catch (error) {
		return refusalFromError(error, path, options.signal);
	}
}

export interface SelectDataOptions extends Pick<ScientificOptions, "variable" | "start" | "count" | "stride"> {
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
	/** SQLite: one read-only SELECT, WITH, VALUES or EXPLAIN statement. */
	sql?: string;
	/** SQLite: a table to select from instead of sql. */
	table?: string;
	signal?: AbortSignal | undefined;
}

export type SelectDataResult =
	| CsvSelectResult
	| JsonSelectResult
	| JsonlSelectResult
	| SqliteSelectResult
	| ScientificResult;

export async function selectData(
	path: string,
	options: SelectDataOptions = {},
): Promise<SelectDataResult | DataRefusal> {
	const stat = statDataFile(path);
	if ("ok" in stat) return stat;
	const format = await detectDataFormat(path, options.format);
	if (format === null) return unsupported(path, options.format);
	if (isScientificFormat(format)) {
		return runScientificOp("select", path, format, scientificFields(options), options.signal);
	}
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
			case "sqlite":
				if (options.pointer !== undefined) {
					return refusal("invalid-argument", "pointer applies to a JSON document; SQLite selects with sql or table", {
						path,
					});
				}
				return await (await import("./sqlite.js")).selectSqlite(path, stat.size, {
					...window,
					...(options.sql !== undefined ? { sql: options.sql } : {}),
					...(options.table !== undefined ? { table: options.table } : {}),
					...(options.columns !== undefined ? { columns: options.columns } : {}),
				});
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
			case "sqlite":
			case "hdf5":
			case "netcdf":
			case "parquet":
				return refusal(
					"invalid-argument",
					`validate covers text formats; use op=inspect on a ${format === "sqlite" ? "SQLite database" : `${format} file`} instead`,
					{ path },
				);
		}
	} catch (error) {
		return refusalFromError(error, path, options.signal);
	}
}

export interface StatsDataOptions extends ScientificOptions {
	format?: string | null;
	signal?: AbortSignal | undefined;
}

/**
 * Summary statistics over a declared selection of an HDF5 or NetCDF variable
 * (a hyperslab) or a Parquet column (a row window), streamed under a byte cap
 * that the result reports when it cut the pass short.
 */
export async function statsData(path: string, options: StatsDataOptions = {}): Promise<ScientificResult | DataRefusal> {
	const stat = statDataFile(path);
	if ("ok" in stat) return stat;
	const format = await detectDataFormat(path, options.format);
	if (format === null) return unsupported(path, options.format);
	if (!isScientificFormat(format)) {
		return refusal(
			"invalid-argument",
			`stats covers HDF5, NetCDF and Parquet; for ${format} use op=inspect, or op=select with sql on SQLite`,
			{ path },
		);
	}
	try {
		return await runScientificOp("stats", path, format, scientificFields(options), options.signal);
	} catch (error) {
		return refusalFromError(error, path, options.signal);
	}
}
