/**
 * Fixed machine-readable projection of recent durable trace runs and phases.
 *
 * `trace runs --json` is an operator-directed terminal surface: it takes a
 * database path and a limit, and it emits `SELECT *`, which includes the
 * request text the operator typed. The GUI cannot reuse that transport. This
 * command accepts no identifier, path, or limit, opens only the default trace
 * database, selects a bounded newest-first window itself, and emits accounting
 * facts with no prompt text, no free-form description or error, and no path.
 *
 * It is deliberately a separate read from `fleet inspect --json` even though
 * both are keyed by run id. The ledger and the trace database are different
 * durable stores with different failure modes: an installation that never
 * enabled tracing has no trace database at all, and that must be an empty
 * answer here rather than a failure of the run journal.
 */

import { existsSync } from "node:fs";
import { clioStatePath } from "../core/xdg.js";
import { TraceReader, traceDatabasePath } from "../domains/observability/trace-store.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { truncateToWidth } from "../engine/tui-primitives.js";

export const TRACE_INSPECT_MAX_RUNS = 8;
export const TRACE_INSPECT_MAX_PHASES = 16;
export const TRACE_INSPECT_MAX_EVENT_KINDS = 12;
export const TRACE_INSPECT_MAX_PROCESS_KINDS = 8;

const IDENTITY_WIDTH = 128;
const STATUS_WIDTH = 64;

export interface TraceInspectPhase {
	readonly name: string;
	readonly kind: string;
	readonly owner: string;
	readonly status: string;
	readonly attempt: number;
	readonly retries: number;
	/** Whether the phase recorded an error, without the error text itself. */
	readonly failed: boolean;
	readonly elapsedMs: number | null;
	readonly totalTokens: number | null;
	readonly totalCostUsd: number | null;
}

/**
 * What a run's events were, in aggregate.
 *
 * Deliberately shapes and not rows. A trace event carries `payload_json` and a
 * free-form name, which are the class of value this boundary keeps host-side,
 * so the tail itself stays in the terminal and what crosses is how many events
 * of each kind there were and the span they cover. The counts come out of SQL,
 * so the payloads are not read on the way to counting them.
 */
export interface TraceInspectEvents {
	readonly total: number;
	readonly firstAt: string | null;
	readonly lastAt: string | null;
	readonly kinds: readonly { readonly kind: string; readonly count: number }[];
	readonly kindsTruncated: boolean;
}

/**
 * What a run's child processes were, in aggregate.
 *
 * Same rule, applied harder: a process row carries the command line, the pid,
 * and the host. None of that is needed to say a run spawned four workers and
 * one is still alive, and none of it crosses.
 */
export interface TraceInspectProcesses {
	readonly total: number;
	readonly running: number;
	readonly kinds: readonly { readonly kind: string; readonly total: number; readonly running: number }[];
	readonly kindsTruncated: boolean;
}

export interface TraceInspectRun {
	readonly runId: string;
	readonly agent: string;
	readonly target: string;
	readonly model: string;
	readonly runtime: string;
	readonly node: string | null;
	readonly status: string;
	readonly startedAt: string;
	readonly elapsedMs: number | null;
	readonly totalTokens: number | null;
	readonly totalCostUsd: number | null;
	readonly phases: readonly TraceInspectPhase[];
	readonly phasesTruncated: boolean;
	readonly events: TraceInspectEvents;
	readonly processes: TraceInspectProcesses;
}

export interface TraceInspectSnapshot {
	readonly version: 1;
	readonly generatedAt: string;
	/**
	 * False when this installation has no trace database. That is the ordinary
	 * state of an installation that never enabled tracing, and it has to stay
	 * distinguishable from a database that exists and holds no runs.
	 */
	readonly available: boolean;
	readonly runs: readonly TraceInspectRun[];
	readonly truncated: boolean;
}

function bounded(value: string, width: number): string {
	const sanitized = sanitizeCallTargetText(value);
	if (sanitized.length === 0) return "unavailable";
	return sanitizeCallTargetText(truncateToWidth(sanitized, width, "…", false));
}

function nullableBounded(value: string | null, width: number): string | null {
	return value === null ? null : bounded(value, width);
}

/** A finite non-negative count, or null when the store recorded none. */
function tally(value: number | null): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

/** A finite non-negative cost, or null. Kept as a number so the GUI formats it. */
function cost(value: number | null): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Wall time between two stamps. Null rather than zero when either is missing or
 * unparseable, because "still running" and "took no time" are different facts.
 */
function elapsed(startedAt: string | null, endedAt: string | null): number | null {
	if (startedAt === null || endedAt === null) return null;
	const start = Date.parse(startedAt);
	const end = Date.parse(endedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
	return Math.max(0, end - start);
}

function eventSummary(reader: TraceReader, runId: string): TraceInspectEvents {
	const span = reader.eventSpan(runId);
	const all = reader.eventKindCounts(runId);
	const visible = all.slice(0, TRACE_INSPECT_MAX_EVENT_KINDS);
	return {
		total: tally(span.total) ?? 0,
		firstAt: span.firstAt,
		lastAt: span.lastAt,
		kinds: visible.map((entry) => ({ kind: bounded(entry.type, STATUS_WIDTH), count: tally(entry.count) ?? 0 })),
		kindsTruncated: all.length > visible.length,
	};
}

function processSummary(reader: TraceReader, runId: string): TraceInspectProcesses {
	const all = reader.processKindCounts(runId);
	const visible = all.slice(0, TRACE_INSPECT_MAX_PROCESS_KINDS);
	return {
		total: all.reduce((sum, entry) => sum + (tally(entry.total) ?? 0), 0),
		running: all.reduce((sum, entry) => sum + (tally(entry.running) ?? 0), 0),
		kinds: visible.map((entry) => ({
			kind: bounded(entry.kind, STATUS_WIDTH),
			total: tally(entry.total) ?? 0,
			running: tally(entry.running) ?? 0,
		})),
		kindsTruncated: all.length > visible.length,
	};
}

/** Pure payload builder, exported so the fixed contract is testable without subprocess capture. */
function traceInspectSnapshot(
	now: () => number = Date.now,
	databasePath: string = traceDatabasePath(clioStatePath()),
): TraceInspectSnapshot {
	const generatedAt = new Date(now()).toISOString();
	if (!existsSync(databasePath)) {
		return { version: 1, generatedAt, available: false, runs: [], truncated: false };
	}
	let reader: TraceReader;
	try {
		reader = new TraceReader(databasePath);
	} catch {
		// A database that exists but will not open is not an empty installation,
		// and it is not this command's job to diagnose it. Report it as present
		// with nothing readable rather than inventing either extreme.
		return { version: 1, generatedAt, available: true, runs: [], truncated: false };
	}
	try {
		const selected = reader.runs(TRACE_INSPECT_MAX_RUNS + 1);
		const window = selected.slice(0, TRACE_INSPECT_MAX_RUNS);
		const runs = window.map((row): TraceInspectRun => {
			const allPhases = reader.phases(row.run_id);
			const visible = allPhases.slice(0, TRACE_INSPECT_MAX_PHASES);
			return {
				runId: bounded(row.run_id, IDENTITY_WIDTH),
				agent: bounded(row.agent, IDENTITY_WIDTH),
				target: bounded(row.target, IDENTITY_WIDTH),
				model: bounded(row.model, IDENTITY_WIDTH),
				runtime: bounded(row.runtime, IDENTITY_WIDTH),
				node: nullableBounded(row.node, IDENTITY_WIDTH),
				status: bounded(row.status, STATUS_WIDTH),
				startedAt: row.started_at,
				elapsedMs: elapsed(row.started_at, row.ended_at),
				totalTokens: tally(row.total_tokens),
				totalCostUsd: cost(row.total_cost_usd),
				phases: visible.map(
					(phase): TraceInspectPhase => ({
						name: bounded(phase.name, IDENTITY_WIDTH),
						kind: bounded(phase.kind, STATUS_WIDTH),
						owner: bounded(phase.owner, IDENTITY_WIDTH),
						status: bounded(phase.status, STATUS_WIDTH),
						attempt: tally(phase.attempt) ?? 0,
						retries: tally(phase.retries) ?? 0,
						// The error text can quote a path, a URL, or a model reply, so only
						// the fact that one was recorded crosses.
						failed: phase.error !== null && phase.error !== "",
						elapsedMs: elapsed(phase.started_at, phase.ended_at),
						totalTokens: tally(phase.total_tokens),
						totalCostUsd: cost(phase.total_cost_usd),
					}),
				),
				phasesTruncated: allPhases.length > visible.length,
				events: eventSummary(reader, row.run_id),
				processes: processSummary(reader, row.run_id),
			};
		});
		return {
			version: 1,
			generatedAt,
			available: true,
			runs,
			truncated: selected.length > window.length,
		};
	} finally {
		reader.close();
	}
}

/**
 * `clio-coder trace inspect --json`, and nothing else.
 *
 * `fixed` is false as soon as the caller supplied a database, a limit, a follow,
 * or any other positional. The whole point of this command is that its argv is
 * not a surface: a GUI host can invoke it and be certain the process it started
 * cannot be steered into reading a different file or a wider window.
 */
export function runTraceInspect(fixed: boolean): number {
	if (!fixed) {
		process.stderr.write("clio-coder trace inspect: usage: clio-coder trace inspect --json\n");
		return 2;
	}
	process.stdout.write(`${JSON.stringify(traceInspectSnapshot(), null, 2)}\n`);
	return 0;
}
