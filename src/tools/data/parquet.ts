import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from "node:zlib";
import {
	DEFAULT_STATS_BYTES,
	type EncodedValue,
	encodeValue,
	INSPECT_RESULT_BYTES,
	jsonBytes,
	MAX_STATS_BYTES,
	type NumericBlock,
	refuse,
	type ScientificRequest,
	type ScientificResult,
	SELECT_VALUE_BYTES,
	SLAB_BYTES,
	STATS_DEADLINE_MS,
	StatsAccumulator,
	viewFor,
} from "./scientific-shared.js";

/**
 * Parquet through hyparquet. The footer is read first and alone, so inspect
 * costs the footer's bytes whatever the file size; select and stats read only
 * the column chunks of the row groups their window touches. Snappy is built
 * into hyparquet; GZIP, ZSTD and BROTLI pages decompress through node:zlib.
 * LZ4 pages are refused with the codec named.
 */

interface ColumnStatistics {
	min_value?: unknown;
	max_value?: unknown;
	min?: unknown;
	max?: unknown;
	null_count?: bigint | number;
	distinct_count?: bigint | number;
	is_min_value_exact?: boolean;
	is_max_value_exact?: boolean;
}

interface ColumnMeta {
	type: string;
	path_in_schema: string[];
	codec: string;
	encodings: string[];
	num_values: bigint | number;
	total_compressed_size: bigint | number;
	total_uncompressed_size: bigint | number;
	statistics?: ColumnStatistics;
}

interface RowGroup {
	num_rows: bigint | number;
	total_byte_size: bigint | number;
	total_compressed_size?: bigint | number;
	columns: Array<{ meta_data?: ColumnMeta }>;
}

interface SchemaElement {
	name: string;
	type?: string;
	repetition_type?: string;
	num_children?: number;
	converted_type?: string;
	logical_type?: { type: string; [key: string]: unknown };
	type_length?: number;
	precision?: number;
	scale?: number;
}

interface FileMetaData {
	version: number;
	num_rows: bigint | number;
	created_by?: string;
	schema: SchemaElement[];
	row_groups: RowGroup[];
	key_value_metadata?: Array<{ key: string; value?: string }>;
}

type AsyncBuffer = { byteLength: number };

type Decompressor = (input: Uint8Array, outputLength: number) => Uint8Array;

export interface ParquetLibrary {
	asyncBufferFromFile(path: string): Promise<AsyncBuffer>;
	parquetMetadataAsync(file: AsyncBuffer): Promise<FileMetaData>;
	parquetReadObjects(options: {
		file: AsyncBuffer;
		metadata: FileMetaData;
		columns?: string[];
		rowStart: number;
		rowEnd: number;
		compressors: Record<string, Decompressor>;
	}): Promise<Array<Record<string, unknown>>>;
}

const COMPRESSORS: Record<string, Decompressor> = {
	GZIP: (input) => new Uint8Array(gunzipSync(input)),
	ZSTD: (input) => new Uint8Array(zstdDecompressSync(input)),
	BROTLI: (input) => new Uint8Array(brotliDecompressSync(input)),
};
const SUPPORTED_CODECS = new Set(["UNCOMPRESSED", "SNAPPY", "GZIP", "ZSTD", "BROTLI"]);

const DEFAULT_SELECT_ROWS = 50;
const MAX_SELECT_ROWS = 1000;
const ROW_GROUPS_LISTED = 50;
const COLUMNS_LISTED = 200;
const KEY_VALUE_CHARS = 256;

function n(value: bigint | number | undefined): number {
	return value === undefined ? 0 : Number(value);
}

function errorText(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

async function open(lib: ParquetLibrary, path: string): Promise<{ file: AsyncBuffer; metadata: FileMetaData }> {
	const file = await lib.asyncBufferFromFile(path);
	try {
		return { file, metadata: await lib.parquetMetadataAsync(file) };
	} catch (error) {
		refuse("read-error", `cannot read the Parquet footer of ${path}: ${errorText(error)}`);
	}
}

interface LeafColumn {
	path: string;
	element: SchemaElement;
	/** Index into each row group's `columns`. */
	index: number;
}

/** Leaf columns in footer order, which is the order of every row group's column chunks. */
function leafColumns(schema: ReadonlyArray<SchemaElement>): LeafColumn[] {
	const leaves: LeafColumn[] = [];
	let cursor = 1;
	const visit = (prefix: string[]): void => {
		const element = schema[cursor];
		if (element === undefined) return;
		cursor += 1;
		const path = [...prefix, element.name];
		const children = element.num_children ?? 0;
		if (children === 0) leaves.push({ path: path.join("."), element, index: leaves.length });
		for (let child = 0; child < children; child += 1) visit(path);
	};
	const rootChildren = schema[0]?.num_children ?? 0;
	for (let child = 0; child < rootChildren; child += 1) visit([]);
	return leaves;
}

function topLevelFields(schema: ReadonlyArray<SchemaElement>): string[] {
	const names: string[] = [];
	let cursor = 1;
	const skip = (): void => {
		const element = schema[cursor];
		cursor += 1;
		for (let child = 0; child < (element?.num_children ?? 0); child += 1) skip();
	};
	for (let child = 0; child < (schema[0]?.num_children ?? 0); child += 1) {
		const element = schema[cursor];
		if (element !== undefined) names.push(element.name);
		skip();
	}
	return names;
}

function logicalType(element: SchemaElement): string | undefined {
	const logical = element.logical_type;
	if (logical !== undefined) {
		const { type, ...rest } = logical;
		const detail = Object.entries(rest)
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
		return detail.length > 0 ? `${type}(${detail.join(", ")})` : type;
	}
	return element.converted_type;
}

function comparable(value: unknown): number | bigint | string | null {
	if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") return value;
	if (value instanceof Date) return value.getTime();
	return null;
}

/** Column statistics folded across row groups: exact extrema and null count when every row group carries them. */
function foldStatistics(leaf: LeafColumn, rowGroups: ReadonlyArray<RowGroup>): Record<string, unknown> {
	let min: unknown;
	let max: unknown;
	let nullCount = 0;
	let withStats = 0;
	let withNulls = 0;
	let legacy = false;
	let inexact = false;
	let foldable = true;
	for (const group of rowGroups) {
		const stats = group.columns[leaf.index]?.meta_data?.statistics;
		if (stats === undefined) continue;
		withStats += 1;
		if (stats.null_count !== undefined) {
			withNulls += 1;
			nullCount += n(stats.null_count);
		}
		let low = stats.min_value;
		let high = stats.max_value;
		if (low === undefined && high === undefined && (stats.min !== undefined || stats.max !== undefined)) {
			low = stats.min;
			high = stats.max;
			legacy = true;
		}
		if (stats.is_min_value_exact === false || stats.is_max_value_exact === false) inexact = true;
		if (low !== undefined) {
			const key = comparable(low);
			if (key === null) foldable = false;
			else if (min === undefined || key < (comparable(min) as typeof key)) min = low;
		}
		if (high !== undefined) {
			const key = comparable(high);
			if (key === null) foldable = false;
			else if (max === undefined || key > (comparable(max) as typeof key)) max = high;
		}
	}
	const out: Record<string, unknown> = { rowGroupsWithStatistics: withStats, rowGroups: rowGroups.length };
	if (withStats === 0) return out;
	if (foldable) {
		if (min !== undefined) out.min = encodeValue(min);
		if (max !== undefined) out.max = encodeValue(max);
		if (withStats < rowGroups.length && (min !== undefined || max !== undefined)) {
			out.extremaCover = "only the row groups that carry statistics";
		}
	} else out.extrema = "not comparable across row groups (binary values); select rows to see them";
	if (withNulls === rowGroups.length) out.nullCount = nullCount;
	else if (withNulls > 0) out.nullCountAtLeast = nullCount;
	if (legacy)
		out.legacyMinMax = "from the deprecated min/max fields, whose order may be wrong for unsigned or string columns";
	if (inexact) out.inexact = "a writer marked some min or max values as truncated bounds rather than exact values";
	return out;
}

function sumOver(
	rowGroups: ReadonlyArray<RowGroup>,
	index: number,
	field: "total_compressed_size" | "total_uncompressed_size",
): number {
	return rowGroups.reduce((total, group) => total + n(group.columns[index]?.meta_data?.[field]), 0);
}

function codecsOf(rowGroups: ReadonlyArray<RowGroup>, index: number): string[] {
	return [
		...new Set(
			rowGroups
				.map((group) => group.columns[index]?.meta_data?.codec)
				.filter((codec): codec is string => codec !== undefined),
		),
	];
}

function refuseUnsupportedCodecs(metadata: FileMetaData, leaves: ReadonlyArray<LeafColumn>, path: string): void {
	for (const leaf of leaves) {
		for (const codec of codecsOf(metadata.row_groups, leaf.index)) {
			if (!SUPPORTED_CODECS.has(codec)) {
				refuse(
					"unsupported-format",
					`column ${leaf.path} in ${path} is compressed with ${codec}, which this reader does not decode (it decodes ${[...SUPPORTED_CODECS].join(", ")}); use run_script with pyarrow`,
				);
			}
		}
	}
}

export async function inspectParquet(lib: ParquetLibrary, request: ScientificRequest): Promise<ScientificResult> {
	const { file, metadata } = await open(lib, request.path);
	const leaves = leafColumns(metadata.schema);
	const groups = metadata.row_groups;
	const describe = (leaf: LeafColumn, withStats: boolean): Record<string, unknown> => {
		const entry: Record<string, unknown> = {
			name: leaf.path,
			physicalType: leaf.element.type ?? "group",
			...(logicalType(leaf.element) !== undefined ? { logicalType: logicalType(leaf.element) } : {}),
			repetition: leaf.element.repetition_type ?? "REQUIRED",
			codecs: codecsOf(groups, leaf.index),
			compressedBytes: sumOver(groups, leaf.index, "total_compressed_size"),
			uncompressedBytes: sumOver(groups, leaf.index, "total_uncompressed_size"),
		};
		if (leaf.element.type_length !== undefined) entry.typeLength = leaf.element.type_length;
		if (withStats) entry.statistics = foldStatistics(leaf, groups);
		return entry;
	};
	const keyValues: Record<string, EncodedValue> = {};
	for (const pair of metadata.key_value_metadata ?? []) {
		const value = pair.value ?? null;
		keyValues[pair.key] =
			value !== null && value.length > KEY_VALUE_CHARS
				? { $truncated: "string", length: value.length, text: value.slice(0, KEY_VALUE_CHARS) }
				: value;
	}
	const build = (columnCount: number, withStats: boolean): ScientificResult => {
		const cut = columnCount < leaves.length || groups.length > ROW_GROUPS_LISTED || !withStats;
		return {
			format: "parquet",
			view: viewFor(true, cut),
			path: request.path,
			fileBytes: file.byteLength,
			rows: n(metadata.num_rows),
			formatVersion: metadata.version,
			...(metadata.created_by !== undefined ? { createdBy: metadata.created_by } : {}),
			columnCount: leaves.length,
			columns: leaves.slice(0, columnCount).map((leaf) => describe(leaf, withStats)),
			rowGroupCount: groups.length,
			rowGroups: groups.slice(0, ROW_GROUPS_LISTED).map((group, index) => ({
				index,
				rows: n(group.num_rows),
				compressedBytes: group.columns.reduce((total, column) => total + n(column.meta_data?.total_compressed_size), 0),
				uncompressedBytes: n(group.total_byte_size),
			})),
			...(Object.keys(keyValues).length > 0 ? { keyValueMetadata: keyValues } : {}),
			notes: [
				"statistics come from the footer as the writer recorded them; nothing was scanned",
				...(columnCount < leaves.length ? [`${leaves.length - columnCount} columns are not listed to fit the result`] : []),
				...(groups.length > ROW_GROUPS_LISTED ? [`only the first ${ROW_GROUPS_LISTED} row groups are listed`] : []),
				...(!withStats ? ["column statistics were dropped to fit the result; use op=stats on one column"] : []),
			],
		};
	};
	let columnCount = Math.min(leaves.length, COLUMNS_LISTED);
	let result = build(columnCount, true);
	if (jsonBytes(result) > INSPECT_RESULT_BYTES) result = build(columnCount, false);
	while (jsonBytes(result) > INSPECT_RESULT_BYTES && columnCount > 1) {
		columnCount = Math.max(1, Math.floor(columnCount * 0.75));
		result = build(columnCount, false);
	}
	return result;
}

function windowArgs(
	request: ScientificRequest,
	rows: number,
	defaultLimit: number,
	maxLimit: number,
): { offset: number; limit: number } {
	const offset = request.offset ?? 0;
	if (!Number.isInteger(offset) || offset < 0)
		refuse("invalid-argument", `offset must be a non-negative integer; got ${offset}`);
	if (offset > rows) refuse("invalid-argument", `offset ${offset} is past the last row (the file has ${rows} rows)`);
	const limit = request.limit ?? defaultLimit;
	if (!Number.isInteger(limit) || limit < 1)
		refuse("invalid-argument", `limit must be a positive integer; got ${limit}`);
	return { offset, limit: Math.min(limit, maxLimit) };
}

export async function selectParquet(lib: ParquetLibrary, request: ScientificRequest): Promise<ScientificResult> {
	const { file, metadata } = await open(lib, request.path);
	const rows = n(metadata.num_rows);
	const fields = topLevelFields(metadata.schema);
	const columns = request.columns;
	if (columns !== undefined) {
		const unknown = columns.filter((column) => !fields.includes(column));
		if (unknown.length > 0) {
			refuse(
				"unknown-column",
				`no column ${unknown.map((name) => JSON.stringify(name)).join(", ")} in ${request.path}; columns are ${fields.slice(0, 50).join(", ")}`,
			);
		}
	}
	const leaves = leafColumns(metadata.schema).filter(
		(leaf) => columns === undefined || columns.includes(leaf.path.split(".")[0] as string),
	);
	refuseUnsupportedCodecs(metadata, leaves, request.path);
	const requestedLimit = request.limit ?? DEFAULT_SELECT_ROWS;
	const { offset, limit } = windowArgs(request, rows, DEFAULT_SELECT_ROWS, MAX_SELECT_ROWS);
	const end = Math.min(rows, offset + limit);
	let objects: Array<Record<string, unknown>>;
	try {
		objects = await lib.parquetReadObjects({
			file,
			metadata,
			...(columns !== undefined ? { columns } : {}),
			rowStart: offset,
			rowEnd: end,
			compressors: COMPRESSORS,
		});
	} catch (error) {
		refuse("read-error", `cannot read rows ${offset} to ${end} of ${request.path}: ${errorText(error)}`);
	}
	let encoded = objects.map((row) => encodeValue(row) as Record<string, EncodedValue>);
	let byteCut = false;
	while (encoded.length > 1 && jsonBytes(encoded) > SELECT_VALUE_BYTES) {
		encoded = encoded.slice(0, Math.max(1, Math.floor(encoded.length / 2)));
		byteCut = true;
	}
	if (jsonBytes(encoded) > SELECT_VALUE_BYTES) {
		refuse(
			"selection-too-large",
			`row ${offset} alone renders past ${SELECT_VALUE_BYTES / 1024} KiB; select fewer columns`,
		);
	}
	const returned = encoded.length;
	const hasMore = offset + returned < rows;
	const limitCut = requestedLimit > MAX_SELECT_ROWS;
	return {
		format: "parquet",
		view: viewFor(true, byteCut),
		path: request.path,
		columns: columns ?? fields,
		offset,
		limit,
		returned,
		total: rows,
		hasMore,
		...(byteCut || limitCut
			? {
					truncated: {
						reason: byteCut ? "byte-cap" : "row-cap",
						note: byteCut
							? `the rows render past ${SELECT_VALUE_BYTES / 1024} KiB, so ${returned} of the ${end - offset} requested rows are returned; continue at offset ${offset + returned} or select fewer columns`
							: `limit ${requestedLimit} is above the ${MAX_SELECT_ROWS}-row cap; ${MAX_SELECT_ROWS} rows were read`,
					},
				}
			: {}),
		rows: encoded,
	};
}

const NUMERIC_PHYSICAL = new Set(["INT32", "INT64", "FLOAT", "DOUBLE"]);

export async function statsParquet(lib: ParquetLibrary, request: ScientificRequest): Promise<ScientificResult> {
	if (request.variable === undefined)
		refuse("invalid-argument", "stats on Parquet needs variable: the column to summarize");
	const { file, metadata } = await open(lib, request.path);
	const rows = n(metadata.num_rows);
	const column = request.variable;
	const leaf = leafColumns(metadata.schema).find((candidate) => candidate.path === column);
	if (leaf === undefined) {
		refuse(
			"unknown-column",
			`no column ${JSON.stringify(column)} in ${request.path}; columns are ${topLevelFields(metadata.schema).slice(0, 50).join(", ")}`,
		);
	}
	if (column.includes("."))
		refuse("invalid-argument", `${column} is nested; op=stats summarizes top-level numeric columns`);
	const logical = logicalType(leaf.element);
	if (
		!NUMERIC_PHYSICAL.has(leaf.element.type ?? "") ||
		(logical !== undefined && /DATE|TIME|STRING|DECIMAL/u.test(logical))
	) {
		refuse(
			"invalid-argument",
			`${column} is ${leaf.element.type}${logical !== undefined ? ` (${logical})` : ""}; op=stats summarizes integer and float columns. op=inspect reports the footer's min, max and null count for every column`,
		);
	}
	refuseUnsupportedCodecs(metadata, [leaf], request.path);
	const { offset, limit } = windowArgs(request, rows, rows, Number.MAX_SAFE_INTEGER);
	const end = Math.min(rows, offset + limit);
	const maxBytes = Math.min(MAX_STATS_BYTES, Math.max(1, request.maxBytes ?? DEFAULT_STATS_BYTES));
	const accumulator = new StatsAccumulator(null, []);
	const deadline = performance.now() + STATS_DEADLINE_MS;
	let scanned = 0;
	let bytesDecoded = 0;
	let stoppedBy: "byte-cap" | "deadline" | null = null;
	let groupStart = 0;
	outer: for (const group of metadata.row_groups) {
		const groupRows = n(group.num_rows);
		const groupEnd = groupStart + groupRows;
		const from = Math.max(offset, groupStart);
		const to = Math.min(end, groupEnd);
		if (from < to) {
			// Bytes are the column chunk's decoded size, charged per row in proportion; a step holds about one slab.
			const chunkBytes = n(group.columns[leaf.index]?.meta_data?.total_uncompressed_size);
			const bytesPerRow = groupRows > 0 ? chunkBytes / groupRows : 0;
			const stepRows = Math.max(1, bytesPerRow > 0 ? Math.floor(SLAB_BYTES / bytesPerRow) : to - from);
			for (let first = from; first < to; first += stepRows) {
				const last = Math.min(to, first + stepRows);
				const stepBytes = Math.ceil((last - first) * bytesPerRow);
				if (bytesDecoded + stepBytes > maxBytes) {
					stoppedBy = "byte-cap";
					break outer;
				}
				if (performance.now() > deadline) {
					stoppedBy = "deadline";
					break outer;
				}
				let objects: Array<Record<string, unknown>>;
				try {
					objects = await lib.parquetReadObjects({
						file,
						metadata,
						columns: [column],
						rowStart: first,
						rowEnd: last,
						compressors: COMPRESSORS,
					});
				} catch (error) {
					refuse("read-error", `cannot read ${column} rows ${first} to ${last}: ${errorText(error)}`);
				}
				accumulator.add(objects.map((row) => row[column] as number | bigint | null) as NumericBlock);
				scanned += last - first;
				bytesDecoded += stepBytes;
			}
		}
		groupStart = groupEnd;
		if (groupStart >= end) break;
	}
	const selected = end - offset;
	const complete = stoppedBy === null;
	return {
		format: "parquet",
		view: viewFor(complete, false),
		path: request.path,
		variable: column,
		physicalType: leaf.element.type,
		...(logical !== undefined ? { logicalType: logical } : {}),
		offset,
		rowsSelected: selected,
		rowsScanned: scanned,
		bytesDecoded,
		maxBytes,
		complete,
		...(stoppedBy !== null
			? {
					stoppedBy,
					note:
						stoppedBy === "byte-cap"
							? `the pass stopped at the ${maxBytes}-byte cap after ${scanned} of ${selected} rows; every figure covers only rows ${offset} to ${offset + scanned}. Raise max_bytes (up to ${MAX_STATS_BYTES}) or narrow offset and limit`
							: `the pass stopped after ${STATS_DEADLINE_MS / 1000} s at ${scanned} of ${selected} rows; every figure covers only those rows`,
				}
			: {}),
		...accumulator.summary(leaf.element.type === "FLOAT"),
		stdDefinition: "population (ddof=0) over valid values",
	};
}
