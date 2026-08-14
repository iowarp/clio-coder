import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clioStatePath } from "../core/xdg.js";
import {
	TRACE_EVENT_POLL_LIMIT,
	type TraceEventRow,
	type TracePhaseRow,
	type TraceProcessRow,
	TraceReader,
	type TraceRunRow,
	traceDatabasePath,
} from "../domains/observability/trace-store.js";

const HELP = `Usage:
  clio trace runs [--db PATH] [--limit N]
  clio trace phases <runId> [--db PATH]
  clio trace tail <runId> [--follow] [--db PATH]
  clio trace procs <runId> [--db PATH]
  clio trace sql <SELECT query> [--db PATH]
  clio trace ui [--db PATH] [--port N]        source checkout only

The viewer ships with the repository, not the npm package, so from an installed
clio the subcommands above are the way in. They read the same database.
`;

interface ParsedTraceArgs {
	positional: string[];
	db: string;
	/** True when --db named the path, so a miss is the operator's path, not the default. */
	dbExplicit: boolean;
	follow: boolean;
	limit: number;
	port: number;
}

function parseTraceArgs(args: string[]): ParsedTraceArgs {
	const positional: string[] = [];
	let db = traceDatabasePath(clioStatePath());
	let dbExplicit = false;
	let follow = false;
	let limit = 50;
	let port = 0;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--follow") follow = true;
		else if (arg === "--db" || arg === "--limit" || arg === "--port") {
			const value = args[index + 1];
			if (value === undefined) throw new Error(`${arg} requires a value`);
			index += 1;
			if (arg === "--db") {
				db = resolve(value);
				dbExplicit = true;
			} else if (arg === "--limit") limit = parseInteger(value, "--limit", 1, 500);
			else port = parseInteger(value, "--port", 0, 65_535);
		} else if (arg?.startsWith("--db=")) {
			db = resolve(arg.slice(5));
			dbExplicit = true;
		} else if (arg?.startsWith("--limit=")) limit = parseInteger(arg.slice(8), "--limit", 1, 500);
		else if (arg?.startsWith("--port=")) port = parseInteger(arg.slice(7), "--port", 0, 65_535);
		else if (arg?.startsWith("-")) throw new Error(`unknown trace flag: ${arg}`);
		else if (arg !== undefined) positional.push(arg);
	}
	return { positional, db, dbExplicit, follow, limit, port };
}

export async function runTraceCommand(args: string[]): Promise<number> {
	// Asking for help is not a usage error. Every other subcommand answers
	// `--help` on stdout with status 0; this one reported `unknown trace flag:
	// --help` on stderr and exited 2, so the one thing a lost user reliably
	// types was the one thing that looked broken.
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	let parsed: ParsedTraceArgs;
	try {
		parsed = parseTraceArgs(args);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${HELP}`);
		return 2;
	}
	const [command, runId] = parsed.positional;
	if (!command || command === "help") {
		process.stdout.write(HELP);
		return command === "help" ? 0 : 2;
	}
	if (command === "ui") return runTraceUi(parsed.db, parsed.port);

	// A database that was never written is the empty state, not a failure. Handing
	// the absent path to node:sqlite produced "unable to open database file",
	// which named neither the file nor a next step, and loading the module leaked
	// its ExperimentalWarning onto the user's stderr on a fresh install. A path
	// the operator typed is a different claim, so a --db that is not there stays
	// an error and says which path it means.
	if (!existsSync(parsed.db)) return missingDatabase(parsed);

	let reader: TraceReader;
	try {
		reader = new TraceReader(parsed.db);
	} catch (error) {
		process.stderr.write(`trace database: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	try {
		switch (command) {
			case "runs":
				printRuns(reader.runs(parsed.limit));
				return 0;
			case "phases":
				if (!runId) return missingRunId(command);
				printPhases(reader.phases(runId));
				return 0;
			case "tail":
				if (!runId) return missingRunId(command);
				await tail(reader, runId, parsed.follow);
				return 0;
			case "procs":
				if (!runId) return missingRunId(command);
				printProcesses(reader.processes(runId));
				return 0;
			case "sql": {
				const query = parsed.positional.slice(1).join(" ");
				if (!query) {
					process.stderr.write("trace sql requires a SELECT query\n");
					return 2;
				}
				process.stdout.write(`${JSON.stringify(reader.select(query), jsonBigInt, 2)}\n`);
				return 0;
			}
			default:
				process.stderr.write(`unknown trace command: ${command}\n${HELP}`);
				return 2;
		}
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	} finally {
		reader.close();
	}
}

async function tail(reader: TraceReader, runId: string, follow: boolean): Promise<void> {
	let cursor = 0;
	let idleTerminalPolls = 0;
	for (;;) {
		const rows = reader.events(runId, cursor, TRACE_EVENT_POLL_LIMIT);
		for (const row of rows) {
			process.stdout.write(`${formatEvent(row)}\n`);
			cursor = Math.max(cursor, row.rowid);
		}
		if (!follow) return;
		const status = reader.run(runId)?.status;
		idleTerminalPolls = rows.length === 0 && status !== "queued" && status !== "running" ? idleTerminalPolls + 1 : 0;
		if (idleTerminalPolls >= 2) return;
		await new Promise<void>((resolveWait) => setTimeout(resolveWait, 500));
	}
}

function formatEvent(row: TraceEventRow): string {
	const duration =
		row.ended_at === null ? "" : ` ${Math.max(0, Date.parse(row.ended_at) - Date.parse(row.started_at))}ms`;
	return `${row.rowid.toString().padStart(6)} ${row.started_at} ${row.type.padEnd(18)} ${row.name}${duration}`;
}

function printRuns(rows: TraceRunRow[]): void {
	process.stdout.write("STATUS   STARTED                      TOKENS       COST RUN\n");
	for (const row of rows) {
		process.stdout.write(
			`${row.status.padEnd(8)} ${row.started_at.padEnd(28)} ${formatNumber(row.total_tokens).padStart(8)} ${formatCost(row.total_cost_usd).padStart(10)} ${row.run_id}\n`,
		);
	}
}

function printPhases(rows: TracePhaseRow[]): void {
	process.stdout.write("STATUS   TRY OWNER              TOKENS       COST PHASE\n");
	for (const row of rows) {
		process.stdout.write(
			`${row.status.padEnd(8)} ${String(row.attempt + 1).padStart(3)} ${row.owner.slice(0, 18).padEnd(18)} ${formatNumber(row.total_tokens).padStart(8)} ${formatCost(row.total_cost_usd).padStart(10)} ${row.name}\n`,
		);
	}
}

function printProcesses(rows: TraceProcessRow[]): void {
	process.stdout.write("STATE  PID      KIND         NAME                 COMMAND\n");
	for (const row of rows) {
		process.stdout.write(
			`${(row.ended_at === null ? "live" : "ended").padEnd(6)} ${String(row.pid).padEnd(8)} ${row.kind.padEnd(12)} ${row.name.slice(0, 20).padEnd(20)} ${row.command}\n`,
		);
	}
}

async function runTraceUi(db: string, port: number): Promise<number> {
	const candidates = [
		fileURLToPath(new URL("../apps/trace-viewer/server.mjs", import.meta.url)),
		fileURLToPath(new URL("../../apps/trace-viewer/server.mjs", import.meta.url)),
	];
	const entry = await firstExisting(candidates);
	if (entry === null) {
		process.stderr.write(
			"trace viewer is available only from a source checkout; apps/trace-viewer/server.mjs was not found\n" +
				"  the npm package does not carry the viewer, so an installed clio cannot start it\n" +
				`  the same run is readable here: clio trace runs --db ${db}\n` +
				"  from a checkout of the repository: npm run trace:ui\n",
		);
		return 1;
	}
	const module = (await import(pathToFileURL(entry).href)) as {
		startTraceViewer(options: { db: string; port: number }): Promise<{ url: string; close(): Promise<void> }>;
	};
	const server = await module.startTraceViewer({ db, port });
	process.stdout.write(`Trace viewer: ${server.url}\n`);
	await new Promise<void>((resolveStop) => {
		const stop = (): void => {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
			void server.close().finally(resolveStop);
		};
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
	});
	return 0;
}

async function firstExisting(paths: string[]): Promise<string | null> {
	for (const path of paths) {
		try {
			await access(path);
			return path;
		} catch {
			// Try the next source-checkout location.
		}
	}
	return null;
}

function parseInteger(value: string, flag: string, min: number, max: number): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < min || parsed > max)
		throw new Error(`${flag} must be an integer in [${min}, ${max}]`);
	return parsed;
}

function missingDatabase(parsed: ParsedTraceArgs): number {
	if (parsed.dbExplicit) {
		process.stderr.write(
			`trace database not found: ${parsed.db}\n` +
				`  --db named this path. omit it to read the default at ${traceDatabasePath(clioStatePath())}\n`,
		);
		return 1;
	}
	process.stdout.write(
		`no trace database yet at ${parsed.db}. rows are recorded when a dispatch executes or an interactive turn runs; run \`clio run "<task>"\` or start a session to create one.\n`,
	);
	return 0;
}

function missingRunId(command: string): number {
	process.stderr.write(`trace ${command} requires a run id\n`);
	return 2;
}

function formatNumber(value: number | null): string {
	return value === null ? "—" : value.toLocaleString("en-US");
}

function formatCost(value: number | null): string {
	return value === null ? "—" : `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function jsonBigInt(_key: string, value: unknown): unknown {
	return typeof value === "bigint" ? value.toString() : value;
}
