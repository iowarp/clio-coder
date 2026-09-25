/**
 * The trace store no longer creates the `envelopes` table or the four itemized
 * phase cost columns: no writer ever filled them. A trace.sqlite written by an
 * earlier build still carries both, so the writer and the reader must open it,
 * the phase rows must keep the closed shape the GUI validates, and pruning a
 * run must remove its legacy envelope rows before the run they reference.
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { TraceReader, TraceStore } from "../../src/domains/observability/trace-store.js";

const scratch = mkdtempSync(join(tmpdir(), "clio-coder-trace-legacy-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function rawDatabase(path: string): import("node:sqlite").DatabaseSync {
	const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
		DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync;
	};
	return new DatabaseSync(path);
}

const LEGACY_COST_COLUMNS = ["input_cost_usd", "output_cost_usd", "cache_read_cost_usd", "cache_write_cost_usd"];

it("opens, reads and prunes a database that still has the envelopes table and itemized cost columns", () => {
	const path = join(scratch, "trace.sqlite");
	const store = new TraceStore(path);
	const endedAt = "2026-01-01T00:00:05.000Z";
	store.upsertRun(
		{
			runId: "run-legacy",
			agentId: "coder",
			targetId: "local",
			wireModelId: "model",
			runtimeId: "fixture",
			runtimeKind: "http",
			requestOrigin: "internal",
		},
		"2026-01-01T00:00:00.000Z",
	);
	store.db.prepare("UPDATE runs SET status='success', ended_at=? WHERE run_id='run-legacy'").run(endedAt);
	store.close();

	// Recreate what an earlier build wrote: the table and columns it created at
	// schema time, with a row in each.
	const legacy = rawDatabase(path);
	const hasEnvelopes = legacy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='envelopes'").get();
	if (!hasEnvelopes) {
		legacy.exec(`CREATE TABLE envelopes (
  envelope_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  phase_id TEXT NOT NULL REFERENCES phases(phase_id),
  agent TEXT NOT NULL,
  output_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK(valid IN (0,1)),
  attempt INTEGER NOT NULL,
  created_at TEXT NOT NULL
);`);
	}
	const phaseColumns = new Set(
		(legacy.prepare("PRAGMA table_info(phases)").all() as { name: string }[]).map((column) => column.name),
	);
	for (const column of LEGACY_COST_COLUMNS) {
		if (!phaseColumns.has(column)) legacy.exec(`ALTER TABLE phases ADD COLUMN ${column} REAL;`);
	}
	legacy.prepare("UPDATE phases SET input_cost_usd=0.5 WHERE run_id='run-legacy'").run();
	legacy
		.prepare("INSERT INTO envelopes VALUES ('envelope-1','run-legacy','run-legacy','coder','result','{}',1,0,?)")
		.run(endedAt);
	legacy.close();

	const reopened = new TraceStore(path);
	const reader = new TraceReader(path);
	try {
		const [phase] = reader.phases("run-legacy");
		ok(phase, "the legacy phase row must still read");
		for (const column of LEGACY_COST_COLUMNS) equal(column in phase, false, `${column} must not reach readers`);
		equal(phase.run_id, "run-legacy");

		const pruned = reopened.prune({ maxAgeDays: 1 }, "2026-02-01T00:00:00.000Z");
		equal(pruned.runsRemoved, 1);
		deepStrictEqual(reader.phases("run-legacy"), []);
		equal(reader.run("run-legacy"), null);
	} finally {
		reader.close();
		reopened.close();
	}
});

it("creates no envelopes table and no itemized cost columns in a new database", () => {
	const path = join(scratch, "fresh.sqlite");
	new TraceStore(path).close();
	const db = rawDatabase(path);
	try {
		equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='envelopes'").get(), undefined);
		const columns = (db.prepare("PRAGMA table_info(phases)").all() as { name: string }[]).map((column) => column.name);
		for (const column of LEGACY_COST_COLUMNS) equal(columns.includes(column), false);
	} finally {
		db.close();
	}
});
