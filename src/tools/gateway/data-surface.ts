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

export const DATA_OPS = ["inspect", "select", "validate"] as const;
export type DataOp = (typeof DATA_OPS)[number];

const DESCRIPTION =
	"Inspect, select, or validate a structured data file without loading it whole: CSV/TSV (delimiter and header detection, per-column types, sentinels such as NA counted, never converted), JSON (document shape, RFC 6901 pointer selection), and JSON Lines (record windows). op=inspect reports schema, dimensions, and a sample; op=select returns a bounded window of rows, records, or the value at a pointer; op=validate checks the whole file against its format. Every result carries view {exact, sampled, converted} and honest counts (rowCount null means the scan stopped early), and large integers or long floats are reported, never rounded. Refuses invalid UTF-8, binary, and unsupported formats (HDF5, NetCDF, Parquet: use run_script with a library) with an actionable reason.";

function numberArg(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
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
	for (const key of ["sample_rows", "offset", "limit"] as const) {
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

export const dataToolSurface = {
	name: DATA_TOOL_NAME,
	description: DESCRIPTION,
	parameters: Type.Object({
		op: StringEnum(DATA_OPS, { description: "inspect, select, or validate." }),
		path: Type.String({ description: "Data file, relative to the workspace root or absolute." }),
		format: Type.Optional(
			StringEnum(DATA_FORMATS, {
				description: "Format when the extension or content does not say: csv, tsv, json, jsonl.",
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
		offset: Type.Optional(Type.Number({ description: "select: 0-based first row, record, or array element." })),
		limit: Type.Optional(Type.Number({ description: "select: rows returned (default 50, max 1000)." })),
		columns: Type.Optional(
			Type.Array(Type.Union([Type.String(), Type.Number()]), {
				description: "select, CSV/TSV: header names or 0-based indices to project.",
			}),
		),
		pointer: Type.Optional(
			Type.String({ description: 'select, JSON: RFC 6901 pointer to the value to return; "" is the whole document.' }),
		),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	prepareArguments: prepareDataArguments,
	prepareAdmissionArguments: prepareDataAdmissionArguments,
} satisfies ToolSurface;
