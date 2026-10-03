import { dirname } from "node:path";
import { runCommandVector } from "../../core/safe-exec.js";
import {
	cutView,
	type DataRefusal,
	type DataViewFlags,
	exactView,
	refusal,
	resolveMaxRows,
	sampledView,
} from "./shared.js";

/**
 * Read-only SQLite access for the `data` tool. Every statement runs in a
 * child `node` process, not in-process: node:sqlite is synchronous and has no
 * interrupt or progress handler on Node 22 or 24, so an expensive query run
 * here would freeze the TUI with no way to cancel it. The child is killed on
 * timeout or abort, and launching it with --disable-warning keeps the SQLite
 * ExperimentalWarning off every stream Clio owns.
 *
 * Read-only is enforced three times: the connection opens with readOnly,
 * `PRAGMA query_only` refuses writes the open flag would miss, and only one
 * SELECT, WITH, VALUES or EXPLAIN statement is accepted, so ATTACH (which
 * would open a file the path policy never saw) cannot run.
 */

const SQLITE_TIMEOUT_MS = 30_000;
const CHILD_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const CELL_TEXT_CAP = 2048;
const BLOB_HEX_BYTES = 32;
const SCHEMA_SQL_CAP = 2048;
const OBJECT_CAP = 500;
const COLUMN_ROW_CAP = 20_000;
const DEFAULT_SAMPLE_ROWS = 10;
const DEFAULT_SELECT_LIMIT = 50;
const MAX_ROWS_PER_CALL = 1000;
const DEFAULT_COUNT_ROWS = 100_000;
const ALLOWED_STATEMENTS = new Set(["select", "with", "values", "explain"]);

/**
 * The child program. Plain JavaScript so it runs verbatim under `node -e`; it
 * reads one JSON request on stdin, runs each query against one read-only
 * connection, and writes one JSON line. Values are encoded here because a
 * bigint or blob cannot cross JSON as itself.
 */
const CHILD_SCRIPT = String.raw`
const { DatabaseSync } = require("node:sqlite");
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
	const req = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	const out = (v) => process.stdout.write(JSON.stringify(v));
	const open = (immutable) => {
		const name = immutable ? "file:" + req.path.split("/").map(encodeURIComponent).join("/") + "?immutable=1" : req.path;
		const db = new DatabaseSync(name, { readOnly: true });
		db.prepare("SELECT count(*) FROM sqlite_schema").get();
		return db;
	};
	let db;
	let immutable = false;
	try {
		db = open(false);
	} catch (first) {
		try {
			db = open(true);
			immutable = true;
		} catch {
			out({ error: first.message });
			return;
		}
	}
	db.exec("PRAGMA query_only=ON");
	const encode = (v) => {
		if (typeof v === "bigint") return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : { $literal: v.toString(), precision: "unsafe-integer" };
		if (v instanceof Uint8Array) return { $blob: v.byteLength, hex: Buffer.from(v.subarray(0, req.blobHexBytes)).toString("hex") };
		if (typeof v === "number" && !Number.isFinite(v)) return { $literal: String(v), precision: "overflow" };
		if (typeof v === "string" && v.length > req.cellCap) return { $truncated: "string", length: v.length, text: v.slice(0, req.cellCap) };
		return v;
	};
	const results = [];
	for (const q of req.queries) {
		try {
			const st = db.prepare(q.sql);
			const tail = q.sql.slice(st.sourceSQL.length).replace(/--[^\n]*|\/\*[\s\S]*?\*\/|;|\s+/g, "");
			if (tail.length > 0) throw new Error("only one statement may run per call");
			st.setReturnArrays(true);
			st.setReadBigInts(true);
			const columns = st.columns().map((c) => ({ name: c.name, type: c.type ?? null }));
			const rows = [];
			let skipped = 0;
			let hasMore = false;
			for (const row of st.iterate(...(q.params || []))) {
				if (skipped < q.offset) { skipped += 1; continue; }
				if (rows.length >= q.limit) { hasMore = true; break; }
				rows.push(row.map(encode));
			}
			results.push({ columns, rows, hasMore });
		} catch (e) {
			results.push({ error: e.message });
		}
	}
	out({ immutable, results });
});
`;

type Cell = unknown;

interface ChildQuery {
	sql: string;
	params?: Array<string | number>;
	offset: number;
	limit: number;
}

interface ChildRows {
	columns: Array<{ name: string; type: string | null }>;
	rows: Cell[][];
	hasMore: boolean;
}

type ChildResult = ChildRows | { error: string };

export interface SqliteColumn {
	name: string;
	type: string | null;
	notNull: boolean;
	default: string | null;
	primaryKey: number;
	/** 0 ordinary, 1 hidden virtual-table column, 2 or 3 generated column. */
	hidden: number;
}

export interface SqliteObject {
	type: string;
	name: string;
	table: string;
	sql: string | null;
}

export interface SqliteInspectResult {
	ok: true;
	format: "sqlite";
	path: string;
	bytes: number;
	view: DataViewFlags;
	/** Opened with immutable=1 because a plain read-only open failed; an uncheckpointed WAL is not seen. */
	immutable: boolean;
	objects: SqliteObject[];
	objectsTruncated: boolean;
	tables: Array<{ name: string; type: string; columns: SqliteColumn[] }>;
	/** Present when `table` was named: bounded row count and a sample. */
	table?: {
		name: string;
		/** Exact row count, or null when it exceeds rowsCounted. */
		rowCount: number | null;
		rowsCounted: number;
		columns: Array<{ name: string; type: string | null }>;
		sample: Cell[][];
	};
	notes: string[];
}

export interface SqliteSelectResult {
	ok: true;
	format: "sqlite";
	path: string;
	bytes: number;
	view: DataViewFlags;
	immutable: boolean;
	sql: string;
	columns: Array<{ name: string; type: string | null }>;
	offset: number;
	limit: number;
	returned: number;
	hasMore: boolean;
	/** Rows as arrays aligned with `columns`; placeholders mark cut text, blobs, and unsafe integers. */
	rows: Cell[][];
	notes: string[];
}

function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

function clampRows(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(MAX_ROWS_PER_CALL, Math.max(1, Math.floor(value)));
}

function mapSqliteError(path: string, message: string): DataRefusal {
	if (/readonly database|only one statement/u.test(message)) {
		return refusal(
			"statement-not-allowed",
			`${message}: data runs one read-only SELECT, WITH, VALUES or EXPLAIN statement`,
			{ path },
		);
	}
	if (/no such table/u.test(message)) return refusal("unknown-table", message, { path });
	if (/no such column/u.test(message)) return refusal("unknown-column", message, { path });
	if (/not a database|encrypted/u.test(message)) {
		return refusal("unsupported-format", `${path}: ${message}. Use run_script with a library for this file.`, {
			path,
		});
	}
	return refusal("read-error", `sqlite: ${message}`, { path });
}

async function runChild(
	path: string,
	queries: ChildQuery[],
	signal: AbortSignal | undefined,
): Promise<{ immutable: boolean; results: ChildResult[] } | DataRefusal> {
	const request = JSON.stringify({ path, queries, cellCap: CELL_TEXT_CAP, blobHexBytes: BLOB_HEX_BYTES });
	const cwd = dirname(path);
	const result = await runCommandVector(
		process.execPath,
		["--disable-warning=ExperimentalWarning", "-e", CHILD_SCRIPT],
		{
			input: request,
			cwd,
			workspaceRoot: cwd,
			timeoutMs: SQLITE_TIMEOUT_MS,
			maxOutputBytes: CHILD_MAX_OUTPUT_BYTES,
			killGraceMs: 0,
			...(signal !== undefined ? { signal } : {}),
		},
	);
	if (result.aborted) return refusal("aborted", "aborted before the query finished", { path });
	if (result.timedOut) {
		return refusal(
			"timed-out",
			`query ran past ${SQLITE_TIMEOUT_MS / 1000}s and was stopped; narrow it with WHERE, an indexed column, or a smaller LIMIT`,
			{ path },
		);
	}
	if (result.outputCapped) {
		return refusal("selection-too-large", "the result exceeded the output cap; select fewer columns or rows", { path });
	}
	let parsed: { immutable?: boolean; results?: ChildResult[]; error?: string };
	try {
		parsed = JSON.parse(result.stdout) as typeof parsed;
	} catch {
		const detail = result.stderr.trim() || `exit ${result.exitCode ?? result.signal}`;
		return refusal("read-error", `sqlite reader failed: ${detail}`, { path });
	}
	if (parsed.error !== undefined) return mapSqliteError(path, parsed.error);
	return { immutable: parsed.immutable === true, results: parsed.results ?? [] };
}

function rowsOf(path: string, result: ChildResult | undefined): ChildRows | DataRefusal {
	if (result === undefined) return refusal("read-error", "sqlite reader returned no result", { path });
	if ("error" in result) return mapSqliteError(path, result.error);
	return result;
}

function immutableNote(immutable: boolean): string[] {
	return immutable
		? [
				"opened with immutable=1 because a read-only open failed (WAL without a writable -shm, or a hot journal); changes still in the WAL are not visible",
			]
		: [];
}

export interface SqliteInspectOptions {
	table?: string;
	sampleRows?: number;
	maxRows?: number | null;
	signal?: AbortSignal | undefined;
}

export async function inspectSqlite(
	path: string,
	bytes: number,
	options: SqliteInspectOptions = {},
): Promise<SqliteInspectResult | DataRefusal> {
	const queries: ChildQuery[] = [
		{
			sql: "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
			offset: 0,
			limit: OBJECT_CAP,
		},
		{
			sql: `SELECT m.name, m.type, p.name, p.type, p."notnull", p.dflt_value, p.pk, p.hidden
				FROM sqlite_schema m JOIN pragma_table_xinfo(m.name) p
				WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid`,
			offset: 0,
			limit: COLUMN_ROW_CAP,
		},
	];
	const countCap = resolveMaxRows(options.maxRows, DEFAULT_COUNT_ROWS);
	const sampleRows = clampRows(options.sampleRows, DEFAULT_SAMPLE_ROWS);
	if (options.table !== undefined) {
		const from = quoteIdentifier(options.table);
		const countLimit = Number.isFinite(countCap) ? ` LIMIT ${countCap + 1}` : "";
		queries.push(
			{ sql: `SELECT count(*) FROM (SELECT 1 FROM ${from}${countLimit})`, offset: 0, limit: 1 },
			{ sql: `SELECT * FROM ${from}`, offset: 0, limit: sampleRows },
		);
	}
	const child = await runChild(path, queries, options.signal);
	if ("ok" in child) return child;
	const objectRows = rowsOf(path, child.results[0]);
	if ("ok" in objectRows) return objectRows;
	const columnRows = rowsOf(path, child.results[1]);
	if ("ok" in columnRows) return columnRows;
	const notes = immutableNote(child.immutable);
	let view = exactView();
	const objects = objectRows.rows.map(([type, name, table, sql]) => {
		const text = typeof sql === "string" ? sql : null;
		return {
			type: String(type),
			name: String(name),
			table: String(table),
			sql: text !== null && text.length > SCHEMA_SQL_CAP ? `${text.slice(0, SCHEMA_SQL_CAP)}…` : text,
		};
	});
	if (objectRows.hasMore) notes.push(`schema listing capped at ${OBJECT_CAP} objects`);
	const tables = new Map<string, { name: string; type: string; columns: SqliteColumn[] }>();
	for (const [tableName, tableType, name, type, notNull, dflt, pk, hidden] of columnRows.rows) {
		const key = String(tableName);
		let entry = tables.get(key);
		if (entry === undefined) {
			entry = { name: key, type: String(tableType), columns: [] };
			tables.set(key, entry);
		}
		entry.columns.push({
			name: String(name),
			type: typeof type === "string" && type.length > 0 ? type : null,
			notNull: notNull === 1,
			default: typeof dflt === "string" ? dflt : null,
			primaryKey: typeof pk === "number" ? pk : 0,
			hidden: typeof hidden === "number" ? hidden : 0,
		});
	}
	if (columnRows.hasMore) notes.push(`column listing capped at ${COLUMN_ROW_CAP} columns`);
	const result: SqliteInspectResult = {
		ok: true,
		format: "sqlite",
		path,
		bytes,
		view,
		immutable: child.immutable,
		objects,
		objectsTruncated: objectRows.hasMore,
		tables: [...tables.values()],
		notes,
	};
	if (options.table !== undefined) {
		const count = rowsOf(path, child.results[2]);
		if ("ok" in count) return count;
		const sample = rowsOf(path, child.results[3]);
		if ("ok" in sample) return sample;
		const counted = typeof count.rows[0]?.[0] === "number" ? (count.rows[0][0] as number) : 0;
		const overflow = counted > countCap;
		if (overflow) {
			view = sampledView();
			notes.push(`more than ${countCap} rows; rowCount is null. Pass max_rows null to count them all`);
		}
		result.view = view;
		result.table = {
			name: options.table,
			rowCount: overflow ? null : counted,
			rowsCounted: overflow ? countCap : counted,
			columns: sample.columns,
			sample: sample.rows,
		};
	} else {
		notes.push("pass table to get a row count and a sample of one table");
	}
	return result;
}

function countCutCells(rows: Cell[][]): number {
	let cut = 0;
	for (const row of rows) {
		for (const cell of row) {
			if (typeof cell === "object" && cell !== null && ("$truncated" in cell || "$blob" in cell)) cut += 1;
		}
	}
	return cut;
}

/** First keyword of a statement, past leading whitespace and comments. */
function leadingKeyword(sql: string): string {
	const stripped = sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/u, "");
	return (/^[A-Za-z]+/u.exec(stripped)?.[0] ?? "").toLowerCase();
}

export interface SqliteSelectOptions {
	sql?: string;
	table?: string;
	columns?: ReadonlyArray<string | number>;
	offset?: number;
	limit?: number;
	signal?: AbortSignal | undefined;
}

export async function selectSqlite(
	path: string,
	bytes: number,
	options: SqliteSelectOptions = {},
): Promise<SqliteSelectResult | DataRefusal> {
	if ((options.sql === undefined) === (options.table === undefined)) {
		return refusal("invalid-argument", "SQLite select takes exactly one of sql or table", { path });
	}
	let sql: string;
	if (options.sql !== undefined) {
		if (options.columns !== undefined) {
			return refusal("invalid-argument", "columns applies to table; name the columns in the sql instead", { path });
		}
		const keyword = leadingKeyword(options.sql);
		if (!ALLOWED_STATEMENTS.has(keyword)) {
			return refusal(
				"statement-not-allowed",
				`'${keyword || options.sql.trim().slice(0, 20)}' is not allowed: data runs one read-only SELECT, WITH, VALUES or EXPLAIN statement`,
				{ path },
			);
		}
		sql = options.sql;
	} else {
		const columns = options.columns ?? [];
		if (columns.some((column) => typeof column !== "string")) {
			return refusal("invalid-argument", "SQLite columns are names, not indices", { path });
		}
		const projection = columns.length > 0 ? columns.map((column) => quoteIdentifier(String(column))).join(", ") : "*";
		sql = `SELECT ${projection} FROM ${quoteIdentifier(options.table as string)}`;
	}
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	const limit = clampRows(options.limit, DEFAULT_SELECT_LIMIT);
	const child = await runChild(path, [{ sql, offset, limit }], options.signal);
	if ("ok" in child) return child;
	const rows = rowsOf(path, child.results[0]);
	if ("ok" in rows) return rows;
	const cut = countCutCells(rows.rows);
	const notes = immutableNote(child.immutable);
	if (cut > 0) notes.push(`${cut} cell(s) carry a $truncated or $blob placeholder; the rows are otherwise verbatim`);
	return {
		ok: true,
		format: "sqlite",
		path,
		bytes,
		view: cut > 0 ? cutView() : exactView(),
		immutable: child.immutable,
		sql,
		columns: rows.columns,
		offset,
		limit,
		returned: rows.rows.length,
		hasMore: rows.hasMore,
		rows: rows.rows,
		notes,
	};
}
