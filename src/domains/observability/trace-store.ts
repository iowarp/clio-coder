/**
 * Durable, rebuildable SQLite mirror of dispatch activity.
 *
 * Receipts, ledgers, and gate artifacts remain authoritative. This database is
 * deliberately a best-effort operator projection: callers enqueue small
 * writes, failures are reported, and dispatch correctness never depends on it.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
	DispatchCompletedPayload,
	DispatchEnqueuedPayload,
	DispatchFailedPayload,
	DispatchProgressPayload,
	DispatchStartedPayload,
} from "../../core/bus-events.js";
import { createRedactionTally, redactSecretsText } from "../evidence/redact.js";

export const TRACE_SCHEMA_VERSION = 1;
export const TRACE_DATABASE_FILE = "trace.sqlite";
export const TRACE_EVENT_POLL_LIMIT = 500;
export const TRACE_PAYLOAD_LIMIT_BYTES = 16 * 1024;
export const TRACE_WRITE_QUEUE_LIMIT = 2048;

type DatabaseSyncConstructor = typeof import("node:sqlite").DatabaseSync;
let sqliteConstructor: DatabaseSyncConstructor | null = null;

/**
 * Whether the operator asked to see where warnings come from.
 *
 * `--trace-warnings` is a request for more warning detail, not less, so the
 * filter below stands down for it. Dropping a warning the operator explicitly
 * asked to trace would be the one case where the suppression lies.
 */
function warningTracingRequested(): boolean {
	const flagged = (argument: string): boolean =>
		argument === "--trace-warnings" || argument.startsWith("--trace-warnings=");
	if (process.execArgv.some(flagged)) return true;
	const nodeOptions = process.env.NODE_OPTIONS;
	if (nodeOptions === undefined) return false;
	return nodeOptions.split(/\s+/).some(flagged);
}

/** Exactly the warning Node emits for the sqlite module, and nothing else. */
function isSqliteExperimentalWarning(args: readonly unknown[]): boolean {
	const [warning, second] = args;
	const type =
		typeof second === "string"
			? second
			: typeof second === "object" && second !== null && "type" in second
				? (second as { type?: unknown }).type
				: undefined;
	if (type !== "ExperimentalWarning") return false;
	const text = typeof warning === "string" ? warning : warning instanceof Error ? warning.message : "";
	return text.includes("SQLite is an experimental feature");
}

function requireSqlite(): DatabaseSyncConstructor {
	return (createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor }).DatabaseSync;
}

/**
 * Run one synchronous module load with the SQLite ExperimentalWarning dropped.
 *
 * The warning names a Node internal the operator never chose and it lands on
 * stderr in the middle of `clio trace` output, which is the fresh-install
 * opacity F1 was filed for. Workers are already spawned with
 * `--disable-warning=ExperimentalWarning` (dispatch/worker-spawn.ts), so
 * silencing it here is consistency rather than new policy.
 *
 * The filter is as narrow as the problem: it covers one synchronous call,
 * matches only the ExperimentalWarning naming SQLite, forwards everything else
 * untouched, and restores the original `process.emitWarning` in a `finally` so
 * a load that throws still hands the global back. An operator running with
 * `--trace-warnings` asked for more warning detail, not less, so the filter
 * stands down entirely for them.
 *
 * Exported for the contract test, which drives it with a load that emits both
 * warnings; production has exactly one caller.
 */
export function loadWithSqliteWarningSuppressed<T>(load: () => T): T {
	if (warningTracingRequested()) return load();
	const emitWarning = process.emitWarning;
	const forward = emitWarning.bind(process) as (...args: unknown[]) => void;
	process.emitWarning = ((...args: unknown[]) => {
		if (isSqliteExperimentalWarning(args)) return;
		forward(...args);
	}) as typeof process.emitWarning;
	try {
		return load();
	} finally {
		process.emitWarning = emitWarning;
	}
}

function databaseSyncConstructor(): DatabaseSyncConstructor {
	// Keep the load lazy so unrelated Clio commands never pay the warning or the
	// module cost; the trace writer/reader is the first real consumer.
	sqliteConstructor ??= loadWithSqliteWarningSuppressed(requireSqlite);
	return sqliteConstructor;
}

export function traceDatabasePath(stateDir: string): string {
	return join(stateDir, TRACE_DATABASE_FILE);
}

export class TraceSchemaVersionError extends Error {
	constructor(readonly found: number | null) {
		super(
			found === null
				? "trace database has no schema version"
				: `unsupported trace schema version ${found}; this Clio supports ${TRACE_SCHEMA_VERSION}`,
		);
		this.name = "TraceSchemaVersionError";
	}
}

export interface TraceEventInput {
	eventId: string;
	runId: string;
	phaseId: string;
	parentId?: string | null;
	type: string;
	name: string;
	payload?: unknown;
	tokens?: number | null;
	startedAt: string;
	endedAt?: string | null;
}

export interface TraceSpendInput {
	runId: string;
	phaseId: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	totalTokens: number;
	inputCostUsd?: number | null;
	outputCostUsd?: number | null;
	cacheReadCostUsd?: number | null;
	cacheWriteCostUsd?: number | null;
	totalCostUsd: number;
	contextTokens?: number | null;
	contextWindow?: number | null;
}

/**
 * `runs.assignment_id` for a turn the operator ran themselves.
 *
 * A dispatched run carries its assignment id here; a session turn has no
 * assignment, so the column holds this sentinel instead. That keeps session
 * turns and dispatched runs in one `runs` table, which is what an operator
 * asking "what did this session do" wants, and it avoids a schema bump:
 * TraceSchemaVersionError refuses a version mismatch outright, so every
 * existing trace.sqlite would need migrating for a column the sentinel already
 * expresses.
 *
 * A row bearing it has no receipt and no worker process. Nothing in the trace
 * read paths requires either, but a future reader that does must check this.
 */
export const SESSION_TRACE_ASSIGNMENT_ID = "session";

export interface SessionTurnUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	totalTokens: number;
	costUsd?: number | null;
}

/** Opens the runs/phases pair for one operator turn. */
export interface SessionTurnStart {
	kind: "start";
	runId: string;
	agent: string;
	target: string;
	model: string;
	runtime: string;
	prompt: string | null;
	at: string;
}

/** One row in that turn: the assistant message, a tool call, a tool result. */
export interface SessionTurnEvent {
	kind: "event";
	runId: string;
	eventId: string;
	type: string;
	name: string;
	payload?: unknown;
	tokens?: number | null;
	startedAt: string;
	endedAt?: string | null;
}

/** Closes the turn. `error` is the terminal failure text, when there was one. */
export interface SessionTurnFinish {
	kind: "finish";
	runId: string;
	status: "success" | "fail";
	error: string | null;
	usage: SessionTurnUsage | null;
	at: string;
}

export type SessionTurnTrace = SessionTurnStart | SessionTurnEvent | SessionTurnFinish;

export interface TraceGateCheck {
	item: string;
	ok: boolean;
	note: string;
}

export interface TraceGateResultInput {
	runId: string;
	phaseId: string;
	attempt: number;
	gate: string;
	passed: boolean;
	checks: ReadonlyArray<TraceGateCheck> | null;
	createdAt: string;
}

export interface TraceEnvelopeInput {
	envelopeId: string;
	runId: string;
	phaseId: string;
	agent: string;
	outputType: string;
	payload: unknown;
	valid: boolean;
	attempt: number;
	createdAt: string;
}

export interface TraceProcessInput {
	runId: string;
	kind: "orchestrator" | "worker";
	name: string;
	pid: number;
	command: string;
	startedAt: string;
}

export interface TraceEventRow {
	rowid: number;
	event_id: string;
	run_id: string;
	phase_id: string;
	parent_id: string | null;
	type: string;
	name: string;
	payload_json: string | null;
	tokens: number | null;
	started_at: string;
	ended_at: string | null;
}

export interface TraceRunRow {
	run_id: string;
	assignment_id: string;
	request: string | null;
	status: string;
	agent: string;
	target: string;
	model: string;
	runtime: string;
	node: string | null;
	started_at: string;
	ended_at: string | null;
	total_tokens: number | null;
	total_cost_usd: number | null;
}

export interface TracePhaseRow {
	phase_id: string;
	run_id: string;
	seq: number;
	name: string;
	kind: string;
	owner: string;
	description: string | null;
	status: string;
	attempt: number;
	retries: number;
	error: string | null;
	started_at: string | null;
	ended_at: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_write_tokens: number | null;
	reasoning_tokens: number | null;
	total_tokens: number | null;
	input_cost_usd: number | null;
	output_cost_usd: number | null;
	cache_read_cost_usd: number | null;
	cache_write_cost_usd: number | null;
	total_cost_usd: number | null;
	context_tokens: number | null;
	context_window: number | null;
}

export interface TraceProcessRow {
	id: number;
	run_id: string;
	kind: string;
	name: string;
	pid: number;
	command: string;
	command_digest: string;
	started_at: string;
	ended_at: string | null;
}

function applyConnectionPragmas(db: DatabaseSync): void {
	db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
}

function readVersion(db: DatabaseSync): number | null {
	const hasMeta = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='meta'").get() as
		| { found: number }
		| undefined;
	if (!hasMeta) return null;
	const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
	if (!row) return null;
	const parsed = Number.parseInt(row.value, 10);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

function assertSupportedVersion(db: DatabaseSync): void {
	const version = readVersion(db);
	if (version !== TRACE_SCHEMA_VERSION) throw new TraceSchemaVersionError(version);
}

const SCHEMA_SQL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta(key, value) VALUES ('schema_version', '${TRACE_SCHEMA_VERSION}');

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  request TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','running','success','fail')),
  agent TEXT NOT NULL,
  target TEXT NOT NULL,
  model TEXT NOT NULL,
  runtime TEXT NOT NULL,
  node TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  total_tokens INTEGER,
  total_cost_usd REAL
);

CREATE TABLE phases (
  phase_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  owner TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','success','fail')),
  attempt INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT,
  ended_at TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  reasoning_tokens INTEGER, total_tokens INTEGER,
  input_cost_usd REAL, output_cost_usd REAL, cache_read_cost_usd REAL, cache_write_cost_usd REAL,
  total_cost_usd REAL,
  context_tokens INTEGER, context_window INTEGER
);
CREATE INDEX phases_run_seq ON phases(run_id, seq);

CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  phase_id TEXT NOT NULL REFERENCES phases(phase_id),
  parent_id TEXT,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  payload_json TEXT,
  tokens INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX events_run_rowid ON events(run_id);
CREATE INDEX events_phase_rowid ON events(phase_id);

CREATE TABLE envelopes (
  envelope_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  phase_id TEXT NOT NULL REFERENCES phases(phase_id),
  agent TEXT NOT NULL,
  output_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK(valid IN (0,1)),
  attempt INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE gate_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  phase_id TEXT NOT NULL REFERENCES phases(phase_id),
  attempt INTEGER NOT NULL,
  gate TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK(passed IN (0,1)),
  violations_json TEXT NOT NULL,
  checks_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX gate_results_phase_attempt ON gate_results(phase_id, attempt);

CREATE TABLE agent_sessions (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  agent TEXT NOT NULL,
  runtime TEXT NOT NULL,
  model TEXT NOT NULL,
  session_id TEXT,
  context_tokens INTEGER,
  context_window INTEGER,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  PRIMARY KEY (run_id, agent)
);

CREATE TABLE processes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  pid INTEGER NOT NULL,
  command TEXT NOT NULL,
  command_digest TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX processes_run_live ON processes(run_id, ended_at);
`;

export class TraceStore {
	readonly db: DatabaseSync;

	constructor(readonly path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new (databaseSyncConstructor())(path);
		applyConnectionPragmas(this.db);
		const version = readVersion(this.db);
		if (version === null) this.db.exec(`BEGIN IMMEDIATE; ${SCHEMA_SQL} COMMIT;`);
		else if (version !== TRACE_SCHEMA_VERSION) throw new TraceSchemaVersionError(version);
	}

	close(): void {
		this.db.close();
	}

	transaction(action: () => void): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			action();
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	upsertRun(input: DispatchEnqueuedPayload, at = new Date().toISOString()): void {
		this.transaction(() => {
			this.db
				.prepare(`INSERT INTO runs
          (run_id, assignment_id, request, status, agent, target, model, runtime, node, started_at)
          VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET request=excluded.request, agent=excluded.agent,
            target=excluded.target, model=excluded.model, runtime=excluded.runtime, node=excluded.node`)
				.run(
					input.runId,
					input.runId,
					input.task === undefined ? null : traceText(input.task, 2000),
					input.agentId,
					input.targetId,
					input.wireModelId,
					input.runtimeId,
					input.node ?? null,
					at,
				);
			this.db
				.prepare(`INSERT INTO phases
          (phase_id, run_id, seq, name, kind, owner, description, status, started_at)
          VALUES (?, ?, 0, ?, 'agent', ?, ?, 'queued', NULL)
          ON CONFLICT(phase_id) DO NOTHING`)
				.run(
					input.runId,
					input.runId,
					traceText(input.agentId, 256),
					traceText(input.agentId, 256),
					input.task === undefined ? null : traceText(input.task, 2000),
				);
		});
	}

	startRun(input: DispatchStartedPayload, at = new Date().toISOString()): void {
		this.upsertRun(input, at);
		this.transaction(() => {
			this.db.prepare("UPDATE runs SET status='running', started_at=? WHERE run_id=?").run(at, input.runId);
			this.db.prepare("UPDATE phases SET status='running', started_at=? WHERE phase_id=?").run(at, input.runId);
			this.insertEventRaw({
				eventId: `${input.runId}:agent_start`,
				runId: input.runId,
				phaseId: input.runId,
				type: "agent_start",
				name: input.agentId,
				payload: { target: input.targetId, model: input.wireModelId, runtime: input.runtimeId },
				startedAt: at,
			});
			if (input.pid !== null) {
				this.db
					.prepare(`INSERT INTO processes(run_id, kind, name, pid, command, command_digest, started_at)
            VALUES (?, 'worker', ?, ?, ?, ?, ?)`)
					.run(
						input.runId,
						input.agentId,
						input.pid,
						traceText(input.processCommand ?? "[]", 2000),
						sha256(input.processCommand ?? "[]"),
						at,
					);
			}
			this.db
				.prepare(`INSERT INTO agent_sessions
          (run_id, agent, runtime, model, session_id, context_tokens, context_window, created_at, last_used_at)
          VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)
          ON CONFLICT(run_id, agent) DO UPDATE SET runtime=excluded.runtime, model=excluded.model,
            context_window=excluded.context_window, last_used_at=excluded.last_used_at`)
				.run(
					input.runId,
					traceText(input.agentId, 256),
					traceText(input.runtimeId, 256),
					traceText(input.wireModelId, 256),
					input.contextWindow ?? null,
					at,
					at,
				);
		});
	}

	insertEvent(input: TraceEventInput): void {
		this.transaction(() => this.insertEventRaw(input));
	}

	private insertEventRaw(input: TraceEventInput): void {
		this.db
			.prepare(`INSERT INTO events
        (event_id, run_id, phase_id, parent_id, type, name, payload_json, tokens, started_at, ended_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET name=excluded.name, payload_json=excluded.payload_json,
          tokens=excluded.tokens, started_at=excluded.started_at, ended_at=excluded.ended_at`)
			.run(
				input.eventId,
				input.runId,
				input.phaseId,
				input.parentId ?? null,
				input.type,
				traceText(input.name, 512),
				input.payload === undefined ? null : boundedJson(input.payload),
				input.tokens ?? null,
				input.startedAt,
				input.endedAt ?? null,
			);
	}

	recordSpend(input: TraceSpendInput): void {
		this.transaction(() => {
			this.db
				.prepare(`UPDATE phases SET input_tokens=?, output_tokens=?, cache_read_tokens=?, cache_write_tokens=?,
          reasoning_tokens=?, total_tokens=?, input_cost_usd=?, output_cost_usd=?, cache_read_cost_usd=?,
          cache_write_cost_usd=?, total_cost_usd=?, context_tokens=?, context_window=? WHERE phase_id=? AND run_id=?`)
				.run(
					input.inputTokens,
					input.outputTokens,
					input.cacheReadTokens,
					input.cacheWriteTokens,
					input.reasoningTokens,
					input.totalTokens,
					input.inputCostUsd ?? null,
					input.outputCostUsd ?? null,
					input.cacheReadCostUsd ?? null,
					input.cacheWriteCostUsd ?? null,
					input.totalCostUsd,
					input.contextTokens ?? null,
					input.contextWindow ?? null,
					input.phaseId,
					input.runId,
				);
			this.db
				.prepare("UPDATE runs SET total_tokens=?, total_cost_usd=? WHERE run_id=?")
				.run(input.totalTokens, input.totalCostUsd, input.runId);
		});
	}

	recordContext(runId: string, contextTokens: number, contextWindow: number | null, at: string): void {
		this.transaction(() => {
			this.db
				.prepare("UPDATE phases SET context_tokens=?, context_window=COALESCE(?, context_window) WHERE run_id=?")
				.run(contextTokens, contextWindow, runId);
			this.db
				.prepare(`UPDATE agent_sessions SET context_tokens=?, context_window=COALESCE(?, context_window),
          last_used_at=? WHERE run_id=?`)
				.run(contextTokens, contextWindow, at, runId);
		});
	}

	recordGate(input: TraceGateResultInput): void {
		const violations = input.checks?.filter((check) => !check.ok).map((check) => `${check.item}: ${check.note}`) ?? [];
		this.transaction(() => {
			this.db
				.prepare("DELETE FROM gate_results WHERE run_id=? AND phase_id=? AND attempt=? AND gate=?")
				.run(input.runId, input.phaseId, input.attempt, input.gate);
			this.db
				.prepare(`INSERT INTO gate_results
          (run_id, phase_id, attempt, gate, passed, violations_json, checks_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(
					input.runId,
					input.phaseId,
					input.attempt,
					input.gate,
					input.passed ? 1 : 0,
					JSON.stringify(violations),
					input.checks === null ? null : JSON.stringify(input.checks),
					input.createdAt,
				);
			this.insertEventRaw({
				eventId: `${input.runId}:gate:${input.gate}:${input.attempt}`,
				runId: input.runId,
				phaseId: input.phaseId,
				type: input.passed ? "gate_pass" : "gate_fail",
				name: input.gate,
				payload: { attempt: input.attempt, checks: input.checks, violations },
				startedAt: input.createdAt,
			});
		});
	}

	recordEnvelope(input: TraceEnvelopeInput): void {
		this.transaction(() => {
			this.db
				.prepare(`INSERT OR REPLACE INTO envelopes
          (envelope_id, run_id, phase_id, agent, output_type, payload_json, valid, attempt, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(
					input.envelopeId,
					input.runId,
					input.phaseId,
					input.agent,
					input.outputType,
					boundedJson(input.payload),
					input.valid ? 1 : 0,
					input.attempt,
					input.createdAt,
				);
		});
	}

	startProcess(input: TraceProcessInput): number {
		let id = 0;
		this.transaction(() => {
			const result = this.db
				.prepare(`INSERT INTO processes(run_id, kind, name, pid, command, command_digest, started_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
				.run(
					input.runId,
					input.kind,
					traceText(input.name, 256),
					input.pid,
					traceText(input.command, 2000),
					sha256(input.command),
					input.startedAt,
				);
			id = Number(result.lastInsertRowid);
		});
		return id;
	}

	endProcesses(runId: string, endedAt: string): void {
		this.transaction(() => {
			this.db.prepare("UPDATE processes SET ended_at=? WHERE run_id=? AND ended_at IS NULL").run(endedAt, runId);
		});
	}

	recordRetryDenied(runId: string, agentId: string, detail: string | null, at: string): void {
		this.transaction(() => {
			const phase = this.db.prepare("SELECT phase_id FROM phases WHERE run_id=? ORDER BY seq LIMIT 1").get(runId) as
				| { phase_id: string }
				| undefined;
			if (!phase) return;
			this.insertEventRaw({
				eventId: `${runId}:retry_denied:${at}`,
				runId,
				phaseId: phase.phase_id,
				type: "error",
				name: "retry denied",
				payload: { agent: agentId, detail, reason: "retry_denied" },
				startedAt: at,
			});
		});
	}

	finishRun(
		input: DispatchCompletedPayload | DispatchFailedPayload,
		success: boolean,
		at = new Date().toISOString(),
	): void {
		this.transaction(() => {
			const fallbackStartedAt =
				typeof input.durationMs === "number" ? new Date(Math.max(0, Date.parse(at) - input.durationMs)).toISOString() : at;
			this.db
				.prepare(`INSERT INTO runs
          (run_id, assignment_id, request, status, agent, target, model, runtime, node, started_at)
          VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO NOTHING`)
				.run(
					input.runId,
					input.lineage?.rootRunId ?? input.runId,
					input.task === undefined ? null : traceText(input.task, 2000),
					input.agentId,
					input.targetId,
					input.wireModelId,
					input.runtimeId,
					input.node ?? null,
					fallbackStartedAt,
				);
			this.db
				.prepare(`INSERT INTO phases
          (phase_id, run_id, seq, name, kind, owner, description, status, started_at)
          VALUES (?, ?, 0, ?, 'agent', ?, ?, 'running', ?)
          ON CONFLICT(phase_id) DO NOTHING`)
				.run(
					input.runId,
					input.runId,
					traceText(input.agentId, 256),
					traceText(input.agentId, 256),
					input.task === undefined ? null : traceText(input.task, 2000),
					fallbackStartedAt,
				);
			this.db
				.prepare("UPDATE runs SET assignment_id=?, status=?, ended_at=?, total_tokens=?, total_cost_usd=? WHERE run_id=?")
				.run(
					input.lineage?.rootRunId ?? input.runId,
					success ? "success" : "fail",
					at,
					input.tokenCount ?? null,
					input.costUsd ?? null,
					input.runId,
				);
			this.db
				.prepare(`UPDATE phases SET status=?, attempt=?, retries=?, ended_at=?, error=?, input_tokens=?, output_tokens=?,
          cache_read_tokens=?, cache_write_tokens=?, reasoning_tokens=?, total_tokens=?, total_cost_usd=?
          WHERE phase_id=?`)
				.run(
					success ? "success" : "fail",
					input.lineage?.attempt ?? 0,
					input.lineage?.attempt ?? 0,
					at,
					success ? null : input.outcomeDetail,
					input.inputTokenCount ?? null,
					input.outputTokenCount ?? null,
					input.cacheReadTokenCount ?? null,
					input.cacheWriteTokenCount ?? null,
					input.reasoningTokenCount ?? null,
					input.tokenCount ?? null,
					input.costUsd ?? null,
					input.runId,
				);
			this.db.prepare("UPDATE processes SET ended_at=? WHERE run_id=? AND ended_at IS NULL").run(at, input.runId);
			this.insertEventRaw({
				eventId: `${input.runId}:agent_end`,
				runId: input.runId,
				phaseId: input.runId,
				type: "agent_end",
				name: input.agentId,
				payload: {
					outcome: input.outcome,
					outcomeDetail: input.outcomeDetail,
					usage: terminalUsage(input),
					cost: input.costUsd ?? null,
					contextWindow: input.contextWindow ?? null,
				},
				tokens: input.tokenCount ?? null,
				startedAt: at,
			});
			this.insertEventRaw({
				eventId: `${input.runId}:phase_end`,
				runId: input.runId,
				phaseId: input.runId,
				type: "phase_end",
				name: input.agentId,
				payload: { status: success ? "success" : "fail" },
				startedAt: at,
			});
		});
	}

	/**
	 * Record one fact about a turn the operator ran in the chat loop.
	 *
	 * The three shapes reuse the dispatch tables exactly: `start` opens the
	 * runs/phases pair, `event` appends to the same `events` table a worker's
	 * tool calls land in, and `finish` closes both with the turn's usage. The
	 * phase id is the run id, as it is for a dispatched run's single phase, so
	 * `clio trace phases` and `clio trace tail` need no session-specific path.
	 */
	recordSessionTurn(input: SessionTurnTrace): void {
		if (input.kind === "start") {
			this.startSessionTurn(input);
			return;
		}
		if (input.kind === "event") {
			this.transaction(() => {
				this.insertEventRaw({
					eventId: `${input.runId}:${input.eventId}`,
					runId: input.runId,
					phaseId: input.runId,
					parentId: `${input.runId}:turn_start`,
					type: input.type,
					name: input.name,
					...(input.payload === undefined ? {} : { payload: input.payload }),
					tokens: input.tokens ?? null,
					startedAt: input.startedAt,
					endedAt: input.endedAt ?? null,
				});
			});
			return;
		}
		this.finishSessionTurn(input);
	}

	private startSessionTurn(input: SessionTurnStart): void {
		this.transaction(() => {
			this.db
				.prepare(`INSERT INTO runs
          (run_id, assignment_id, request, status, agent, target, model, runtime, node, started_at)
          VALUES (?, ?, ?, 'running', ?, ?, ?, ?, NULL, ?)
          ON CONFLICT(run_id) DO NOTHING`)
				.run(
					input.runId,
					SESSION_TRACE_ASSIGNMENT_ID,
					input.prompt === null ? null : traceText(input.prompt, 2000),
					traceText(input.agent, 256),
					traceText(input.target, 256),
					traceText(input.model, 256),
					traceText(input.runtime, 256),
					input.at,
				);
			this.db
				.prepare(`INSERT INTO phases
          (phase_id, run_id, seq, name, kind, owner, description, status, started_at)
          VALUES (?, ?, 0, ?, 'session', ?, ?, 'running', ?)
          ON CONFLICT(phase_id) DO NOTHING`)
				.run(
					input.runId,
					input.runId,
					traceText(input.agent, 256),
					traceText(input.agent, 256),
					input.prompt === null ? null : traceText(input.prompt, 2000),
					input.at,
				);
			this.insertEventRaw({
				eventId: `${input.runId}:turn_start`,
				runId: input.runId,
				phaseId: input.runId,
				type: "agent_start",
				name: input.agent,
				payload: { target: input.target, model: input.model, runtime: input.runtime, session: true },
				startedAt: input.at,
			});
		});
	}

	private finishSessionTurn(input: SessionTurnFinish): void {
		const usage = input.usage;
		this.transaction(() => {
			this.db
				.prepare("UPDATE runs SET status=?, ended_at=?, total_tokens=?, total_cost_usd=? WHERE run_id=?")
				.run(input.status, input.at, usage?.totalTokens ?? null, usage?.costUsd ?? null, input.runId);
			this.db
				.prepare(`UPDATE phases SET status=?, ended_at=?, error=?, input_tokens=?, output_tokens=?,
          cache_read_tokens=?, cache_write_tokens=?, reasoning_tokens=?, total_tokens=?, total_cost_usd=?
          WHERE phase_id=?`)
				.run(
					input.status,
					input.at,
					input.error,
					usage?.inputTokens ?? null,
					usage?.outputTokens ?? null,
					usage?.cacheReadTokens ?? null,
					usage?.cacheWriteTokens ?? null,
					usage?.reasoningTokens ?? null,
					usage?.totalTokens ?? null,
					usage?.costUsd ?? null,
					input.runId,
				);
			this.insertEventRaw({
				eventId: `${input.runId}:turn_end`,
				runId: input.runId,
				phaseId: input.runId,
				type: "agent_end",
				name: input.status,
				payload: { status: input.status, error: input.error, usage },
				tokens: usage?.totalTokens ?? null,
				startedAt: input.at,
			});
		});
	}
}

export class TraceReader {
	readonly db: DatabaseSync;

	constructor(readonly path: string) {
		this.db = new (databaseSyncConstructor())(path, { readOnly: true });
		// journal_mode is queried rather than changed: changing it is a write and
		// readonly consumers must remain readonly. The writer creates WAL first.
		this.db.exec("PRAGMA busy_timeout=5000;");
		assertSupportedVersion(this.db);
		const mode = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
		if (mode.journal_mode.toLowerCase() !== "wal")
			throw new Error(`trace database journal mode is ${mode.journal_mode}, expected WAL`);
	}

	close(): void {
		this.db.close();
	}

	runs(limit = 50): TraceRunRow[] {
		return this.db
			.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?")
			.all(clampInt(limit, 1, 500)) as unknown as TraceRunRow[];
	}

	run(runId: string): TraceRunRow | null {
		return (
			(this.db.prepare("SELECT * FROM runs WHERE run_id=?").get(runId) as unknown as TraceRunRow | undefined) ?? null
		);
	}

	phases(runId: string): TracePhaseRow[] {
		return this.db
			.prepare("SELECT * FROM phases WHERE run_id=? ORDER BY seq, phase_id")
			.all(runId) as unknown as TracePhaseRow[];
	}

	events(runId: string, afterRowid = 0, limit = TRACE_EVENT_POLL_LIMIT): TraceEventRow[] {
		return this.db
			.prepare(`SELECT rowid, event_id, run_id, phase_id, parent_id, type, name, payload_json,
        tokens, started_at, ended_at FROM events
        WHERE run_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`)
			.all(
				runId,
				Math.max(0, Math.trunc(afterRowid)),
				clampInt(limit, 1, TRACE_EVENT_POLL_LIMIT),
			) as unknown as TraceEventRow[];
	}

	processes(runId: string): TraceProcessRow[] {
		return this.db
			.prepare("SELECT * FROM processes WHERE run_id=? ORDER BY ended_at IS NOT NULL, id")
			.all(runId) as unknown as TraceProcessRow[];
	}

	gateResults(runId: string): Record<string, SQLInputValue>[] {
		return this.db
			.prepare("SELECT * FROM gate_results WHERE run_id=? ORDER BY phase_id, attempt, id")
			.all(runId) as Record<string, SQLInputValue>[];
	}

	envelopes(runId: string): Record<string, SQLInputValue>[] {
		return this.db
			.prepare("SELECT * FROM envelopes WHERE run_id=? ORDER BY created_at, envelope_id")
			.all(runId) as Record<string, SQLInputValue>[];
	}

	select(sql: string): Record<string, SQLInputValue>[] {
		assertSelectOnly(sql);
		return this.db.prepare(sql).all() as Record<string, SQLInputValue>[];
	}
}

export interface DispatchTraceMirror {
	enqueue(channel: string, payload: unknown): void;
	/**
	 * Mirror one fact about the operator's own turn. Queued on the same chain as
	 * dispatch events, so a turn's start, events and finish keep their order and
	 * a session row never precedes the run row its events reference.
	 */
	enqueueSessionTurn(trace: SessionTurnTrace): void;
	flush(): Promise<void>;
	close(): Promise<void>;
}

interface ToolStart {
	toolCallId: string;
	tool: string;
	args: unknown;
	startedAt: string;
}

export function createDispatchTraceMirror(
	path: string,
	options: { warn?: (message: string) => void; now?: () => string } = {},
): DispatchTraceMirror {
	const warn = options.warn ?? ((message: string) => process.stderr.write(`[clio:trace] ${message}\n`));
	const now = options.now ?? (() => new Date().toISOString());
	let store: TraceStore | null = null;
	let chain: Promise<void> = Promise.resolve();
	let closed = false;
	let degraded = false;
	let pendingWrites = 0;
	let droppedProgress = 0;
	const starts = new Map<string, ToolStart>();
	const seen = new Map<string, number>();
	const contextWindows = new Map<string, number>();
	const gateRuns = new Map<string, { role: string; cycle: number }>();

	const getStore = (): TraceStore => {
		store ??= new TraceStore(path);
		return store;
	};
	const schedule = (work: () => void): void => {
		if (closed || degraded) return;
		pendingWrites += 1;
		chain = chain.then(
			() =>
				new Promise<void>((resolve) => {
					setImmediate(() => {
						try {
							if (degraded) {
								pendingWrites -= 1;
								return resolve();
							}
							work();
						} catch (error) {
							if (!degraded) warn(error instanceof Error ? error.message : String(error));
							degraded = true;
						}
						pendingWrites -= 1;
						resolve();
					});
				}),
		);
	};

	return {
		enqueue(channel, raw): void {
			const observedAt = now();
			if (pendingWrites >= TRACE_WRITE_QUEUE_LIMIT && !isCriticalTraceEvent(channel, raw)) {
				droppedProgress += 1;
				return;
			}
			schedule(() => {
				if (!isRecord(raw)) return;
				if (channel === "dispatch.enqueued") {
					const payload = raw as unknown as DispatchEnqueuedPayload;
					getStore().upsertRun(payload, observedAt);
					if (payload.contextWindow !== undefined) contextWindows.set(payload.runId, payload.contextWindow);
					if (payload.gate !== undefined) gateRuns.set(payload.runId, payload.gate);
				} else if (channel === "dispatch.started")
					getStore().startRun(raw as unknown as DispatchStartedPayload, observedAt);
				else if (channel === "dispatch.progress")
					recordProgress(
						getStore(),
						raw as unknown as DispatchProgressPayload,
						starts,
						seen,
						contextWindows,
						gateRuns,
						observedAt,
					);
				else if (channel === "dispatch.completed")
					getStore().finishRun(raw as unknown as DispatchCompletedPayload, true, observedAt);
				else if (channel === "dispatch.failed")
					recordFailure(getStore(), raw as unknown as DispatchFailedPayload, observedAt);
			});
		},
		enqueueSessionTurn(trace): void {
			// A session turn is low-frequency and every one of its rows is the
			// record itself rather than display detail, so none of it is eligible
			// for the progress drop the queue limit applies to dispatch chatter.
			schedule(() => getStore().recordSessionTurn(trace));
		},
		async flush(): Promise<void> {
			await chain;
			if (droppedProgress > 0) {
				warn(`dropped ${droppedProgress} display-only progress events because the trace queue was full`);
				droppedProgress = 0;
			}
		},
		async close(): Promise<void> {
			closed = true;
			await chain;
			if (droppedProgress > 0)
				warn(`dropped ${droppedProgress} display-only progress events because the trace queue was full`);
			store?.close();
		},
	};
}

function recordProgress(
	store: TraceStore,
	payload: DispatchProgressPayload,
	starts: Map<string, ToolStart>,
	seen: Map<string, number>,
	contextWindows: Map<string, number>,
	gateRuns: Map<string, { role: string; cycle: number }>,
	at: string,
): void {
	if (!isRecord(payload.event)) return;
	const event = payload.event;
	const type = typeof event.type === "string" ? event.type : "progress";
	const toolCallId = stringValue(event.toolCallId) ?? stringValue(event.tool_call_id);
	if (
		type === "message_end" &&
		isRecord(event.message) &&
		event.message.role === "assistant" &&
		event.message.stopReason !== "error" &&
		event.message.stopReason !== "aborted" &&
		isRecord(event.message.usage)
	) {
		const usage = event.message.usage;
		const contextTokens =
			finiteNonNegative(usage.totalTokens) ??
			finiteNonNegative(usage.total_tokens) ??
			[usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
				.map((value) => finiteNonNegative(value) ?? 0)
				.reduce((sum, value) => sum + value, 0);
		store.recordContext(payload.runId, contextTokens, contextWindows.get(payload.runId) ?? null, at);
	}
	const gate = gateRuns.get(payload.runId);
	if (type === "message_end" && gate !== undefined && isRecord(event.message) && event.message.role === "assistant") {
		const result = structuredGateResult(messageText(event.message));
		if (result !== null) {
			store.recordGate({
				runId: payload.runId,
				phaseId: payload.runId,
				attempt: gate.cycle,
				gate: gate.role,
				passed: result.passed,
				checks: result.checks,
				createdAt: at,
			});
		}
	}
	if ((type === "tool_execution_start" || type === "clio_tool_start") && toolCallId !== null) {
		starts.set(`${payload.runId}:${toolCallId}`, {
			toolCallId,
			tool: stringValue(event.toolName) ?? stringValue(event.tool) ?? "tool",
			args: event.args ?? null,
			startedAt: at,
		});
		return;
	}
	if ((type === "tool_execution_end" || type === "clio_tool_finish") && toolCallId !== null) {
		const key = `${payload.runId}:${toolCallId}`;
		const start = starts.get(key);
		const duration = finiteNonNegative(event.durationMs);
		const startedAt = start?.startedAt ?? (duration === null ? at : new Date(Date.parse(at) - duration).toISOString());
		const tool = start?.tool ?? stringValue(event.toolName) ?? stringValue(event.tool) ?? "tool";
		const args = start?.args ?? event.args ?? null;
		const result = event.result ?? event.resultSnippet ?? null;
		const ok = event.isError !== true && event.outcome !== "error" && event.outcome !== "blocked";
		store.insertEvent({
			eventId: `${payload.runId}:tool:${toolCallId}`,
			runId: payload.runId,
			phaseId: payload.runId,
			parentId: `${payload.runId}:agent_start`,
			type: "tool_call",
			name: readableToolName(tool, args),
			payload: {
				tool,
				tool_call_id: toolCallId,
				args,
				result_snippet: boundedSnippet(result),
				ok,
				duration_ms: duration,
				agent: payload.agentId,
			},
			startedAt,
			endedAt: at,
		});
		starts.delete(key);
		return;
	}
	const sequence = (seen.get(payload.runId) ?? 0) + 1;
	seen.set(payload.runId, sequence);
	store.insertEvent({
		eventId: `${payload.runId}:event:${sequence}`,
		runId: payload.runId,
		phaseId: payload.runId,
		parentId: `${payload.runId}:agent_start`,
		type: normalizeEventType(type),
		name: eventName(event, type),
		payload: projectProgressPayload(type, event),
		tokens: eventTokens(event),
		startedAt: at,
	});
}

function terminalUsage(input: DispatchCompletedPayload | DispatchFailedPayload): Record<string, number | null> | null {
	if (input.tokenCount === undefined) return null;
	return {
		input: input.inputTokenCount ?? 0,
		output: input.outputTokenCount ?? 0,
		cache_read: input.cacheReadTokenCount ?? 0,
		cache_write: input.cacheWriteTokenCount ?? 0,
		reasoning_tokens: input.reasoningTokenCount ?? 0,
		total_tokens: input.tokenCount,
	};
}

function recordFailure(store: TraceStore, input: DispatchFailedPayload, at: string): void {
	if (input.reason === "retry_denied") {
		store.recordRetryDenied(input.runId, input.agentId, input.outcomeDetail, at);
		return;
	}
	store.finishRun(input, false, at);
}

function isCriticalTraceEvent(channel: string, raw: unknown): boolean {
	if (channel !== "dispatch.progress") return true;
	if (!isRecord(raw) || !isRecord(raw.event)) return false;
	const type = raw.event.type;
	return (
		type === "tool_execution_start" ||
		type === "tool_execution_end" ||
		type === "clio_tool_start" ||
		type === "clio_tool_finish" ||
		type === "message_end" ||
		type === "attempt_start"
	);
}

function projectProgressPayload(type: string, event: Record<string, unknown>): Record<string, unknown> {
	if (type === "message_end") {
		const message = isRecord(event.message) ? event.message : {};
		return {
			role: message.role ?? null,
			stopReason: message.stopReason ?? null,
			usage: isRecord(message.usage) ? message.usage : null,
			model: message.model ?? null,
		};
	}
	const projected: Record<string, unknown> = { sourceType: type };
	for (const key of ["level", "status", "attempt", "reason", "dueAt", "previousRunId", "runId"] as const) {
		const value = event[key];
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") projected[key] = value;
	}
	return projected;
}

function messageText(message: Record<string, unknown>): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("");
}

function structuredGateResult(text: string): { passed: boolean; checks: TraceGateCheck[] } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		return null;
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.checks) || parsed.checks.length === 0) return null;
	const checks: TraceGateCheck[] = [];
	for (const raw of parsed.checks) {
		if (
			!isRecord(raw) ||
			typeof raw.name !== "string" ||
			typeof raw.passed !== "boolean" ||
			typeof raw.evidence !== "string"
		) {
			return null;
		}
		checks.push({ item: raw.name, ok: raw.passed, note: raw.evidence });
	}
	if (parsed.verdict !== undefined && parsed.verdict !== "pass" && parsed.verdict !== "fail") return null;
	if (parsed.winner !== undefined && (!Number.isSafeInteger(parsed.winner) || (parsed.winner as number) < 1))
		return null;
	if (parsed.verdict === undefined && parsed.winner === undefined) return null;
	return { passed: parsed.verdict === "pass" || parsed.winner !== undefined, checks };
}

function normalizeEventType(type: string): string {
	if (type === "message_end") return "log";
	if (type === "attempt_start") return "handoff";
	return type.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "progress";
}

function eventName(event: Record<string, unknown>, fallback: string): string {
	return stringValue(event.name) ?? stringValue(event.message) ?? fallback;
}

function eventTokens(event: Record<string, unknown>): number | null {
	if (!isRecord(event.message) || !isRecord(event.message.usage)) return null;
	return finiteNonNegative(event.message.usage.totalTokens) ?? finiteNonNegative(event.message.usage.total_tokens);
}

function readableToolName(tool: string, args: unknown): string {
	if (isRecord(args)) {
		const target = stringValue(args.command) ?? stringValue(args.path) ?? stringValue(args.file_path);
		if (target !== null) return traceText(`${tool}: ${target.replace(/\s+/g, " ").trim()}`, 160);
	}
	return traceText(tool, 160);
}

function boundedSnippet(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	const encoded =
		typeof value === "string"
			? value
			: JSON.stringify(value, (_key, current: unknown) => (typeof current === "bigint" ? current.toString() : current));
	const text = encoded ?? String(value);
	return Buffer.byteLength(text) <= 4096 ? text : `${Buffer.from(text).subarray(0, 4093).toString("utf8")}…`;
}

function boundedJson(value: unknown): string {
	const serialized = JSON.stringify(value, (_key, current: unknown) =>
		typeof current === "bigint" ? current.toString() : current,
	);
	const json = serialized === undefined ? undefined : redactSecretsText(serialized, createRedactionTally());
	if (json === undefined) return "null";
	if (Buffer.byteLength(json) <= TRACE_PAYLOAD_LIMIT_BYTES) return json;
	return JSON.stringify({
		truncated: true,
		snippet: Buffer.from(json)
			.subarray(0, TRACE_PAYLOAD_LIMIT_BYTES - 128)
			.toString("utf8"),
	});
}

function traceText(value: string, maxChars: number): string {
	return redactSecretsText(value, createRedactionTally())
		.replace(/[\r\n\t]+/g, " ")
		.slice(0, maxChars);
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertSelectOnly(sql: string): void {
	const trimmed = sql.trim();
	if (!/^(SELECT|WITH)\b/i.test(trimmed)) throw new Error("trace sql accepts SELECT or read-only WITH queries only");
	if (trimmed.includes(";")) throw new Error("trace sql accepts exactly one statement");
	if (/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|ATTACH|DETACH|VACUUM|PRAGMA)\b/i.test(trimmed)) {
		throw new Error("trace sql query is not read-only");
	}
}

function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNonNegative(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
