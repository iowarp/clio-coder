/**
 * trace-store.ts's `runs`/`phases` tables hold both dispatch runs and
 * interactive session turns under one schema, previously distinguishable only
 * by the historical sentinel `assignment_id = "session"`, which
 * docs/architecture/trace-store.md never named as a reliable discriminator.
 * The new `runs.source` column is explicit, and a database written before
 * the column existed must gain it in place, backfilled from that sentinel,
 * the same way `processes.host`/`processes.birth_token` were added without a
 * schema-version bump.
 */
import { strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { SESSION_TRACE_ASSIGNMENT_ID, TraceReader, TraceStore } from "../../src/domains/observability/trace-store.js";

// Mirrors trace-store.ts's own lazy accessor; node:sqlite is not always
// importable as a static ESM binding on every supported Node build.
function databaseSyncConstructor() {
	return (
		createRequire(import.meta.url)("node:sqlite") as {
			DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync;
		}
	).DatabaseSync;
}

// The schema exactly as it stood immediately before the `source` column was
// added: every table SCHEMA_SQL still creates today, with `runs` missing
// only that one column.
const PRE_SOURCE_SCHEMA_SQL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta(key, value) VALUES ('schema_version', '1');

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
  ended_at TEXT,
  host TEXT,
  birth_token TEXT
);
CREATE INDEX processes_run_live ON processes(run_id, ended_at);
`;

describe("trace-store runs.source column and its migration", () => {
	let dir: string;

	before(() => {
		dir = mkdtempSync(join(tmpdir(), "clio-trace-source-"));
	});
	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function seedLegacyDatabase(path: string): void {
		const raw = new (databaseSyncConstructor())(path);
		raw.exec("PRAGMA journal_mode=WAL;");
		raw.exec(`BEGIN IMMEDIATE; ${PRE_SOURCE_SCHEMA_SQL} COMMIT;`);
		raw
			.prepare(
				`INSERT INTO runs (run_id, assignment_id, request, status, agent, target, model, runtime, started_at)
			 VALUES ('run-legacy-dispatch', 'assign-1', NULL, 'success', 'coder', 'mini', 'test-model', 'subprocess', '2026-01-01T00:00:00.000Z')`,
			)
			.run();
		raw
			.prepare(
				`INSERT INTO runs (run_id, assignment_id, request, status, agent, target, model, runtime, started_at)
			 VALUES ('run-legacy-session', ?, NULL, 'success', 'main', 'mini', 'test-model', 'sdk', '2026-01-01T00:00:00.000Z')`,
			)
			.run(SESSION_TRACE_ASSIGNMENT_ID);
		raw.close();
	}

	it("a read-only reader derives source on a pre-source database no writer has ever opened", () => {
		const path = join(dir, "legacy-reader-only.sqlite");
		seedLegacyDatabase(path);

		const reader = new TraceReader(path);
		try {
			strictEqual(reader.run("run-legacy-dispatch")?.source, "dispatch");
			strictEqual(reader.run("run-legacy-session")?.source, "session");
			const bySource = Object.fromEntries(reader.runs(10).map((row) => [row.run_id, row.source]));
			strictEqual(bySource["run-legacy-dispatch"], "dispatch");
			strictEqual(bySource["run-legacy-session"], "session");
		} finally {
			reader.close();
		}
	});

	it("a TraceStore writer backfills source in place, and a reader opened afterward sees the real column", () => {
		const path = join(dir, "legacy-then-migrated.sqlite");
		seedLegacyDatabase(path);

		const store = new TraceStore(path);
		store.close();

		const reader = new TraceReader(path);
		try {
			strictEqual(reader.run("run-legacy-dispatch")?.source, "dispatch");
			strictEqual(reader.run("run-legacy-session")?.source, "session");
		} finally {
			reader.close();
		}
	});

	it("tags a fresh database's rows with source at write time, without relying on backfill", () => {
		const path = join(dir, "fresh.sqlite");
		const store = new TraceStore(path);
		store.upsertRun({
			runId: "run-fresh-dispatch",
			agentId: "coder",
			targetId: "mini",
			wireModelId: "test-model",
			runtimeId: "rt-1",
			runtimeKind: "subprocess",
			requestOrigin: "user",
		});
		store.recordSessionTurn({
			kind: "start",
			runId: "run-fresh-session",
			agent: "main",
			target: "mini",
			model: "test-model",
			runtime: "sdk",
			prompt: null,
			at: new Date().toISOString(),
		});
		store.close();

		const reader = new TraceReader(path);
		try {
			strictEqual(reader.run("run-fresh-dispatch")?.source, "dispatch");
			strictEqual(reader.run("run-fresh-session")?.source, "session");
		} finally {
			reader.close();
		}
	});
});
