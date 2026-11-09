import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import { StringEnum } from "../../engine/ai.js";
import { DATA_FORMATS } from "../data/shared.js";
import type { ToolSurface } from "../lazy-tool.js";
import { resolveToCwd } from "../path-utils.js";

/**
 * The `data` capability's immutable surface, kept apart from its streaming
 * implementation so the registry can attach the schema and defer the readers
 * until the first call.
 */

export const DATA_TOOL_NAME = ToolNames.Data;

export const DATA_OPS = ["inspect", "select", "validate", "stats"] as const;
export type DataOp = (typeof DATA_OPS)[number];

const DESCRIPTION =
	"Inspect, select, validate, or summarize a structured or scientific data file read-only, without loading it whole. " +
	"Text and SQLite: CSV/TSV (delimiter and header detection, per-column types, sentinels such as NA counted, never converted), JSON (document shape, RFC 6901 pointer selection), JSON Lines (record windows), and SQLite (op=inspect lists tables, views and columns, and with table adds a row count and sample; op=select takes one SELECT, WITH, VALUES or EXPLAIN statement in sql, or a table with optional columns). op=validate checks a text file against its format. " +
	"Scientific: HDF5, NetCDF-4 (read as HDF5), classic NetCDF (CDF-1, CDF-2 and CDF-5) and Parquet. op=inspect reports the group and variable tree with dtype, shape, named dimensions, attributes with a cf block (units, long_name, standard_name, _FillValue, missing_value, scale_factor, add_offset, calendar, valid_min, valid_max, valid_range, coordinates), chunk shape and compression filters, and for Parquet the schema, row groups, per-column codecs and sizes, and footer statistics (min, max, null count) without scanning; variable narrows it to one variable or group. op=select reads a hyperslab of variable (start, count, stride; one entry per dimension; count omitted returns the first 200 elements, an explicit count above 2000 elements is refused) or a Parquet row window (offset, limit up to 1000, columns); values are raw as stored, with scale_factor and add_offset not applied. op=stats gives min, max, argmin and argmax (absolute index of the first min and max, one entry per dimension), mean, population std, NaN, infinity, fill-value and missing-value counts over the same selection (Parquet: variable names a numeric column, offset and limit the rows), streaming in slabs until max_bytes (default 256 MiB) or 60 s and saying when either cut it short. Fill and missing values come from the _FillValue and missing_value attributes only. On-disk size per HDF5 dataset is not reported (classic NetCDF and Parquet sizes are). The HDF5 reader (h5wasm 0.10.3) and Parquet reader (hyparquet 1.31.5) are downloaded once on first use from the npm registry, sha256-pinned and cached; offline, the refusal names the URL, the cache path and the run_script route (h5py, netCDF4 or pyarrow). " +
	"Every result carries view {exact, sampled, converted} and honest counts (rowCount null or complete false means the scan stopped early), and large integers or non-finite values are reported as $literal, never rounded. Refuses invalid UTF-8, binary, and unsupported formats with an actionable reason.";

function numberArg(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

/** An integer list from an array, a JSON array string, or a comma-separated string. */
function integerListArg(value: unknown): number[] | undefined {
	let items: unknown = value;
	if (typeof value === "string") {
		const text = value.trim().replace(/^\[|\]$/gu, "");
		if (text.length === 0) return undefined;
		items = text.split(",").map((part) => part.trim());
	}
	if (typeof items === "number") items = [items];
	if (!Array.isArray(items) || items.length === 0) return undefined;
	const out: number[] = [];
	for (const item of items) {
		const parsed = numberArg(item);
		if (parsed === undefined) return undefined;
		out.push(parsed);
	}
	return out;
}

export function headerArg(value: unknown): "auto" | boolean | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "boolean") return value;
	if (value === "auto") return "auto";
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

function columnsArg(value: unknown): Array<string | number> | undefined {
	if (typeof value === "string") {
		const parts = value
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		return parts.length > 0 ? parts : undefined;
	}
	if (!Array.isArray(value)) return undefined;
	const out: Array<string | number> = [];
	for (const entry of value) {
		if (typeof entry === "string" || (typeof entry === "number" && Number.isFinite(entry))) out.push(entry);
	}
	return out.length > 0 ? out : undefined;
}

/**
 * Accept the weak-model argument shapes without teaching every reader about
 * them: numbers as strings, `columns` as a comma-separated string, `header`
 * as "true"/"false", and `file`/`file_path` for `path`.
 */
export function prepareDataArguments(args: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...args };
	if (typeof out.path !== "string") {
		const alias = out.file ?? out.file_path ?? out.filePath;
		if (typeof alias === "string") out.path = alias;
	}
	if (typeof out.path === "string") out.path = out.path.trim();
	for (const key of ["start", "count", "stride"] as const) {
		const parsed = integerListArg(out[key]);
		if (parsed !== undefined) out[key] = parsed;
		else if (out[key] !== undefined) delete out[key];
	}
	if (typeof out.variable !== "string") {
		const alias = out.dataset ?? out.column;
		if (typeof alias === "string") out.variable = alias;
	}
	for (const key of ["sample_rows", "offset", "limit", "max_bytes"] as const) {
		const parsed = numberArg(out[key]);
		if (parsed !== undefined) out[key] = parsed;
		else if (out[key] !== undefined) delete out[key];
	}
	if (out.max_rows !== undefined && out.max_rows !== null) {
		const parsed = numberArg(out.max_rows);
		if (parsed !== undefined) out.max_rows = parsed;
		else delete out.max_rows;
	}
	const header = headerArg(out.header);
	if (header !== undefined) out.header = header;
	else if (out.header !== undefined) delete out.header;
	const columns = columnsArg(out.columns);
	if (columns !== undefined) out.columns = columns;
	else if (out.columns !== undefined) delete out.columns;
	return out;
}

/** Freeze the reader's normalized target before path policy admission. */
export function prepareDataAdmissionArguments(
	args: Record<string, unknown>,
	cwd = process.cwd(),
): Record<string, unknown> {
	const prepared = prepareDataArguments(args);
	if (typeof prepared.path === "string" && prepared.path.length > 0) prepared.path = resolveToCwd(prepared.path, cwd);
	return prepared;
}

export const dataToolSurface: ToolSurface = {
	name: DATA_TOOL_NAME,
	description: DESCRIPTION,
	parameters: Type.Object({
		op: StringEnum(DATA_OPS, { description: "inspect, select, validate, or stats." }),
		path: Type.String({ description: "Data file, relative to the workspace root or absolute." }),
		format: Type.Optional(
			StringEnum(DATA_FORMATS, {
				description:
					"Format when the extension or content does not say: csv, tsv, json, jsonl, sqlite, hdf5, netcdf, parquet.",
			}),
		),
		delimiter: Type.Optional(Type.String({ description: "CSV/TSV: one delimiter character (or \\t)." })),
		header: Type.Optional(
			Type.Union([Type.Boolean(), Type.Literal("auto")], {
				description: 'CSV/TSV: "auto" (default) detects a header row; true or false forces it.',
			}),
		),
		sample_rows: Type.Optional(
			Type.Number({ description: "inspect: rows or top-level members kept as the sample (default 10, max 1000)." }),
		),
		max_rows: Type.Optional(
			Type.Union([Type.Number(), Type.Null()], {
				description:
					"inspect and validate: rows scanned before the view becomes sampled or the verdict partial (default 100000; null scans the whole file).",
			}),
		),
		offset: Type.Optional(
			Type.Number({ description: "select: 0-based first row, record, or array element; Parquet stats: first row." }),
		),
		limit: Type.Optional(
			Type.Number({
				description: "select: rows returned (default 50, max 1000); Parquet stats: rows summarized (default all).",
			}),
		),
		columns: Type.Optional(
			Type.Array(Type.Union([Type.String(), Type.Number()]), {
				description: "select, CSV/TSV: header names or 0-based indices to project; SQLite with table: column names.",
			}),
		),
		pointer: Type.Optional(
			Type.String({ description: 'select, JSON: RFC 6901 pointer to the value to return; "" is the whole document.' }),
		),
		sql: Type.Optional(
			Type.String({
				description:
					"select, SQLite: one read-only SELECT, WITH, VALUES or EXPLAIN statement, stopped after 30 s; offset and limit window its rows.",
			}),
		),
		variable: Type.Optional(
			Type.String({
				description:
					"HDF5/NetCDF: variable or group path (inspect narrows to it; select and stats read it). Parquet stats: the column.",
			}),
		),
		start: Type.Optional(
			Type.Array(Type.Number(), {
				description: "HDF5/NetCDF select and stats: 0-based first index per dimension (default 0).",
			}),
		),
		count: Type.Optional(
			Type.Array(Type.Number(), {
				description: "HDF5/NetCDF select and stats: elements per dimension (default: the rest of the dimension).",
			}),
		),
		stride: Type.Optional(
			Type.Array(Type.Number(), { description: "HDF5/NetCDF select and stats: step per dimension (default 1)." }),
		),
		max_bytes: Type.Optional(
			Type.Number({
				description:
					"stats: raw bytes read before the pass stops and reports itself incomplete (default 268435456, max 8 GiB).",
			}),
		),
		table: Type.Optional(
			Type.String({ description: "SQLite: inspect counts and samples this table; select reads it instead of sql." }),
		),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	prepareArguments: prepareDataArguments,
	prepareAdmissionArguments: prepareDataAdmissionArguments,
};
