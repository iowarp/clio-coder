import { deepStrictEqual, equal, match, strictEqual, throws } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import type { DispatchEnqueuedPayload } from "../../src/core/bus-events.js";
import {
	createDispatchTraceMirror,
	resolveTraceRetentionPolicy,
	TRACE_SCHEMA_VERSION,
	TraceReader,
	TraceSchemaVersionError,
	TraceStore,
} from "../../src/domains/observability/trace-store.js";

const scratch = mkdtempSync(join(tmpdir(), "clio-trace-store-"));

function path(name: string): string {
	return join(scratch, `${name}-${Math.random().toString(16).slice(2)}.sqlite`);
}

function run(runId = "run-1"): DispatchEnqueuedPayload {
	return {
		runId,
		agentId: "coder",
		task: "implement the trace",
		requestOrigin: "agent",
		targetId: "local",
		wireModelId: "model",
		runtimeId: "native",
		runtimeKind: "subprocess",
	};
}

describe("durable trace store", () => {
	// Nested inside the describe, not at module top level: under
	// --experimental-test-isolation=none every file shares one root test
	// context, so a top-level after() runs at the end of the whole process,
	// not the end of this file's suite.
	after(() => rmSync(scratch, { recursive: true, force: true }));

	it("creates the exact schema version with WAL connection settings", () => {
		const file = path("schema");
		const store = new TraceStore(file);
		try {
			const version = store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string };
			equal(Number(version.value), TRACE_SCHEMA_VERSION);
			equal((store.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
			equal((store.db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous, 1);
			equal((store.db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 5000);
			const tables = store.db
				.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
				.all()
				.map((row) => (row as { name: string }).name);
			deepStrictEqual(tables, [
				"agent_sessions",
				"envelopes",
				"events",
				"gate_results",
				"meta",
				"phases",
				"processes",
				"runs",
			]);
		} finally {
			store.close();
		}
	});

	it("resolves operator retention overrides without changing the defaults", () => {
		deepStrictEqual(resolveTraceRetentionPolicy({}, {}), { maxAgeDays: 30, maxBytes: 128 * 1024 * 1024 });
		deepStrictEqual(
			resolveTraceRetentionPolicy(
				{},
				{ CLIO_CODER_TRACE_RETENTION_DAYS: "14", CLIO_CODER_TRACE_MAX_BYTES: String(64 * 1024 * 1024) },
			),
			{ maxAgeDays: 14, maxBytes: 64 * 1024 * 1024 },
		);
	});

	it("refuses readers for unknown schema versions", () => {
		const file = path("future");
		const db = new DatabaseSync(file);
		db.exec(
			"CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES('schema_version','99')",
		);
		db.close();
		throws(
			() => new TraceReader(file),
			(error) => error instanceof TraceSchemaVersionError && error.found === 99,
		);
	});

	it("preserves insertion order and a monotonic rowid cursor", () => {
		const file = path("cursor");
		const store = new TraceStore(file);
		store.upsertRun(run());
		for (const index of [1, 2, 3]) {
			store.insertEvent({
				eventId: `e${index}`,
				runId: "run-1",
				phaseId: "run-1",
				type: "log",
				name: `event ${index}`,
				startedAt: `2026-01-01T00:00:0${index}Z`,
			});
		}
		store.close();
		const reader = new TraceReader(file);
		try {
			const first = reader.events("run-1", 0, 2);
			deepStrictEqual(
				first.map((event) => event.event_id),
				["e1", "e2"],
			);
			const second = reader.events("run-1", first.at(-1)?.rowid, 500);
			deepStrictEqual(
				second.map((event) => event.event_id),
				["e3"],
			);
			strictEqual((second[0]?.rowid ?? 0) > (first.at(-1)?.rowid ?? 0), true);
		} finally {
			reader.close();
		}
	});

	it("folds a real tool start/end into one spanning row", async () => {
		const file = path("tools");
		let tick = 0;
		const mirror = createDispatchTraceMirror(file, { now: () => `2026-01-01T00:00:0${tick++}Z` });
		mirror.enqueue("dispatch.enqueued", run());
		mirror.enqueue("dispatch.progress", {
			runId: "run-1",
			agentId: "coder",
			event: { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "npm test" } },
		});
		mirror.enqueue("dispatch.progress", {
			runId: "run-1",
			agentId: "coder",
			event: {
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "bash",
				result: "api_key=123456789-secret-value",
				isError: false,
			},
		});
		await mirror.close();
		const reader = new TraceReader(file);
		try {
			const rows = reader.events("run-1");
			equal(rows.length, 1);
			equal(rows[0]?.type, "tool_call");
			equal(rows[0]?.name, "bash: npm test");
			equal(rows[0]?.started_at, "2026-01-01T00:00:01Z");
			equal(rows[0]?.ended_at, "2026-01-01T00:00:02Z");
			match(rows[0]?.payload_json ?? "", /\[redacted:assignment\]/);
			strictEqual(rows[0]?.payload_json?.includes("123456789-secret-value"), false);
		} finally {
			reader.close();
		}
	});

	it("stores itemized spend that reconciles and keeps reasoning inside output", () => {
		const file = path("spend");
		const store = new TraceStore(file);
		store.upsertRun(run());
		store.recordSpend({
			runId: "run-1",
			phaseId: "run-1",
			inputTokens: 10,
			outputTokens: 7,
			cacheReadTokens: 5,
			cacheWriteTokens: 2,
			reasoningTokens: 3,
			totalTokens: 24,
			inputCostUsd: 0.01,
			outputCostUsd: 0.02,
			cacheReadCostUsd: 0.003,
			cacheWriteCostUsd: 0.007,
			totalCostUsd: 0.04,
		});
		store.close();
		const reader = new TraceReader(file);
		try {
			const phase = reader.phases("run-1")[0];
			equal(
				(phase?.input_tokens ?? 0) +
					(phase?.output_tokens ?? 0) +
					(phase?.cache_read_tokens ?? 0) +
					(phase?.cache_write_tokens ?? 0),
				phase?.total_tokens,
			);
			equal(
				(phase?.input_cost_usd ?? 0) +
					(phase?.output_cost_usd ?? 0) +
					(phase?.cache_read_cost_usd ?? 0) +
					(phase?.cache_write_cost_usd ?? 0),
				phase?.total_cost_usd,
			);
			equal(phase?.reasoning_tokens, 3);
			equal(phase?.output_tokens, 7);
		} finally {
			reader.close();
		}
	});

	it("finalizes running rows whose local owner is dead on open, leaving live and foreign owners alone", () => {
		const file = path("reconcile");
		const deadPid = spawnSync(process.execPath, ["-e", ""]).pid ?? 4194303;
		let store = new TraceStore(file);
		for (const [runId, pid, host] of [
			["dead", deadPid, hostname()],
			["live", process.pid, hostname()],
			["foreign", deadPid, "other-host"],
			["legacy", deadPid, null],
		] as const) {
			store.startRun(
				{ ...run(runId), pid, processCommand: "[]", assignmentId: runId, attempt: 0 },
				"2026-01-01T00:00:00Z",
			);
			store.insertEvent({
				eventId: `${runId}:e`,
				runId,
				phaseId: runId,
				type: "log",
				name: "x",
				startedAt: "2026-01-01T00:00:05Z",
			});
			store.db.prepare("UPDATE processes SET host=?, birth_token=NULL WHERE run_id=?").run(host, runId);
		}
		store.close();
		store = new TraceStore(file);
		store.close();
		const reader = new TraceReader(file);
		try {
			equal(reader.run("dead")?.status, "fail");
			equal(reader.run("dead")?.ended_at, "2026-01-01T00:00:05Z");
			equal(reader.phases("dead")[0]?.status, "fail");
			equal(reader.processes("dead")[0]?.ended_at, "2026-01-01T00:00:05Z");
			for (const untouched of ["live", "foreign", "legacy"]) {
				equal(reader.run(untouched)?.status, "running", untouched);
				equal(reader.run(untouched)?.ended_at, null, untouched);
			}
		} finally {
			reader.close();
		}
	});

	it("adds owner-identity columns to a pre-amendment database in place", () => {
		const file = path("migrate");
		let store = new TraceStore(file);
		store.db.exec("ALTER TABLE processes DROP COLUMN host; ALTER TABLE processes DROP COLUMN birth_token;");
		store.close();
		store = new TraceStore(file);
		store.startRun(
			{ ...run(), pid: process.pid, processCommand: "[]", assignmentId: "run-1", attempt: 0 },
			"2026-01-01T00:00:00Z",
		);
		store.close();
		const reader = new TraceReader(file);
		try {
			equal(reader.processes("run-1")[0]?.host, hostname());
			equal(reader.run("run-1")?.status, "running");
		} finally {
			reader.close();
		}
	});

	it("tracks process lifecycle and derives gate violations from failed checks", () => {
		const file = path("process-gate");
		const store = new TraceStore(file);
		store.upsertRun(run());
		store.startProcess({
			runId: "run-1",
			kind: "worker",
			name: "coder",
			pid: 1234,
			command: "node clio-coder worker",
			startedAt: "2026-01-01T00:00:00Z",
		});
		store.recordGate({
			runId: "run-1",
			phaseId: "run-1",
			attempt: 2,
			gate: "review",
			passed: false,
			checks: [
				{ item: "tests", ok: true, note: "passed" },
				{ item: "lint", ok: false, note: "two errors" },
			],
			createdAt: "2026-01-01T00:00:01Z",
		});
		store.endProcesses("run-1", "2026-01-01T00:00:02Z");
		store.close();
		const reader = new TraceReader(file);
		try {
			equal(reader.processes("run-1")[0]?.ended_at, "2026-01-01T00:00:02Z");
			const gate = reader.gateResults("run-1")[0];
			equal(gate?.attempt, 2);
			equal(gate?.violations_json, '["lint: two errors"]');
			match(String(gate?.checks_json), /"item":"tests"/);
		} finally {
			reader.close();
		}
	});

	it("isolates tracer open/write failures from dispatch callers", async () => {
		const warnings: string[] = [];
		const mirror = createDispatchTraceMirror(scratch, { warn: (message) => warnings.push(message) });
		mirror.enqueue("dispatch.enqueued", run("will-not-open"));
		await mirror.flush();
		await mirror.close();
		strictEqual(warnings.length > 0, true);
	});

	it("allows read-only SELECT and rejects mutation or compound SQL", () => {
		const file = path("sql");
		const store = new TraceStore(file);
		store.upsertRun(run());
		store.close();
		const reader = new TraceReader(file);
		try {
			equal(reader.select("SELECT count(*) AS count FROM runs")[0]?.count, 1);
			throws(() => reader.select("DELETE FROM runs"), /SELECT/);
			throws(() => reader.select("SELECT 1; DELETE FROM runs"), /one statement/);
			throws(() => reader.select("PRAGMA table_info(runs)"), /SELECT/);
		} finally {
			reader.close();
		}
	});

	it("prunes terminal history while a run is in flight without removing any row the live run uses", () => {
		const file = path("prune-live");
		const store = new TraceStore(file);
		try {
			store.upsertRun(run("old-terminal"), "2026-01-01T00:00:00.000Z");
			store.insertEvent({
				eventId: "old-event",
				runId: "old-terminal",
				phaseId: "old-terminal",
				type: "log",
				name: "old",
				startedAt: "2026-01-01T00:00:01.000Z",
			});
			store.db
				.prepare("UPDATE runs SET status='success', ended_at='2026-01-01T00:00:02.000Z' WHERE run_id='old-terminal'")
				.run();

			store.upsertRun(run("live-run"), "2026-01-01T00:00:00.000Z");
			store.db.prepare("UPDATE runs SET status='running' WHERE run_id='live-run'").run();
			store.db.prepare("UPDATE phases SET status='running' WHERE run_id='live-run'").run();
			store.insertEvent({
				eventId: "live-event",
				runId: "live-run",
				phaseId: "live-run",
				type: "log",
				name: "still writing",
				startedAt: "2026-01-01T00:00:01.000Z",
			});

			const result = store.prune({ maxAgeDays: 30, maxBytes: 128 * 1024 * 1024 }, "2026-03-01T00:00:00.000Z");
			strictEqual(result.runsRemoved, 1);
			strictEqual(result.rowsRemoved, 3, "the terminal run, phase, and event are removed together");
			strictEqual(result.protectedRuns, 1);
			strictEqual(store.db.prepare("SELECT 1 FROM runs WHERE run_id='old-terminal'").get(), undefined);
			strictEqual(
				(store.db.prepare("SELECT status FROM runs WHERE run_id='live-run'").get() as { status: string }).status,
				"running",
			);
			strictEqual(
				(store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE run_id='live-run'").get() as { count: number }).count,
				1,
			);
		} finally {
			store.close();
		}
	});

	it("automatically applies the age policy when a later run finishes", () => {
		const file = path("automatic-retention");
		const store = new TraceStore(file, { retention: { maxAgeDays: 30, maxBytes: 128 * 1024 * 1024 } });
		try {
			store.upsertRun(run("old-terminal"), "2026-01-01T00:00:00.000Z");
			store.db
				.prepare("UPDATE runs SET status='success', ended_at='2026-01-01T00:00:02.000Z' WHERE run_id='old-terminal'")
				.run();
			store.recordSessionTurn({
				kind: "start",
				runId: "new-turn",
				agent: "orchestrator",
				target: "mini",
				model: "model",
				runtime: "llamacpp",
				prompt: "hello",
				at: "2026-03-01T00:00:00.000Z",
			});
			store.recordSessionTurn({
				kind: "finish",
				runId: "new-turn",
				status: "success",
				error: null,
				usage: null,
				at: "2026-03-01T00:00:01.000Z",
			});
			strictEqual(store.db.prepare("SELECT 1 FROM runs WHERE run_id='old-terminal'").get(), undefined);
			strictEqual(
				(store.db.prepare("SELECT status FROM runs WHERE run_id='new-turn'").get() as { status: string }).status,
				"success",
			);
		} finally {
			store.close();
		}
	});

	it("vacuums after size pruning when deleted pages make reclamation worthwhile", () => {
		const file = path("prune-size");
		const store = new TraceStore(file);
		try {
			store.upsertRun(run("large-terminal"), "2026-01-01T00:00:00.000Z");
			const payload = { output: "x".repeat(12 * 1024) };
			for (let index = 0; index < 160; index += 1) {
				store.insertEvent({
					eventId: `large-${index}`,
					runId: "large-terminal",
					phaseId: "large-terminal",
					type: "log",
					name: `large ${index}`,
					payload,
					startedAt: "2026-01-01T00:00:01.000Z",
				});
			}
			store.db
				.prepare("UPDATE runs SET status='success', ended_at='2026-01-01T00:00:02.000Z' WHERE run_id='large-terminal'")
				.run();
			store.upsertRun(run("live-run"), "2026-02-01T00:00:00.000Z");
			store.db.prepare("UPDATE runs SET status='running' WHERE run_id='live-run'").run();

			const result = store.prune({ maxAgeDays: 36_500, maxBytes: 1024 * 1024 }, "2026-03-01T00:00:00.000Z");
			strictEqual(result.runsRemoved, 1);
			strictEqual(result.protectedRuns, 1);
			strictEqual(result.vacuumed, true);
			strictEqual(result.rowsRemoved >= 162, true);
			strictEqual(result.bytesRemoved > 0, true);
			strictEqual(result.bytesAfter < result.bytesBefore, true);
			strictEqual(
				(store.db.prepare("SELECT status FROM runs WHERE run_id='live-run'").get() as { status: string }).status,
				"running",
			);
		} finally {
			store.close();
		}
	});

	it("redacts every display column while retaining a command identity digest", () => {
		const file = path("redaction");
		const store = new TraceStore(file);
		store.upsertRun({ ...run(), task: "use api_key=123456789-secret-value" });
		store.startProcess({
			runId: "run-1",
			kind: "worker",
			name: "coder",
			pid: 42,
			command: '["worker","--token=123456789-secret-value"]',
			startedAt: "2026-01-01T00:00:00Z",
		});
		store.close();
		const reader = new TraceReader(file);
		try {
			const request = reader.run("run-1")?.request ?? "";
			const process = reader.processes("run-1")[0];
			strictEqual(request.includes("123456789-secret-value"), false);
			strictEqual(process?.command.includes("123456789-secret-value"), false);
			match(process?.command_digest ?? "", /^[0-9a-f]{64}$/);
		} finally {
			reader.close();
		}
	});

	it("does not re-finalize a completed attempt when retry admission is denied", async () => {
		const file = path("retry-denied");
		let tick = 0;
		const mirror = createDispatchTraceMirror(file, { now: () => `2026-01-01T00:00:0${tick++}Z` });
		mirror.enqueue("dispatch.enqueued", run());
		mirror.enqueue("dispatch.completed", {
			...run(),
			outcome: "succeeded",
			outcomeDetail: null,
			tokenCount: 10,
			costUsd: 0.01,
		});
		await mirror.flush();
		const before = new TraceReader(file);
		const endedAt = before.run("run-1")?.ended_at;
		before.close();
		mirror.enqueue("dispatch.failed", {
			...run(),
			reason: "retry_denied",
			outcome: "spawn_failed",
			outcomeDetail: "capacity unavailable",
		});
		await mirror.close();
		const reader = new TraceReader(file);
		try {
			equal(reader.run("run-1")?.status, "success");
			equal(reader.run("run-1")?.ended_at, endedAt);
			strictEqual(
				reader.events("run-1").some((event) => event.name === "retry denied"),
				true,
			);
		} finally {
			reader.close();
		}
	});

	it("projects typed gate checks from a real gate dispatch event", async () => {
		const file = path("gate-progress");
		const mirror = createDispatchTraceMirror(file);
		mirror.enqueue("dispatch.enqueued", { ...run(), gate: { role: "reviewer", cycle: 2 } });
		mirror.enqueue("dispatch.progress", {
			runId: "run-1",
			agentId: "coder",
			event: {
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "stop",
					usage: { totalTokens: 12 },
					content: JSON.stringify({
						verdict: "fail",
						checks: [{ name: "tests", passed: false, evidence: "one failure" }],
					}),
				},
			},
		});
		await mirror.close();
		const reader = new TraceReader(file);
		try {
			const gate = reader.gateResults("run-1")[0];
			equal(gate?.attempt, 2);
			equal(gate?.passed, 0);
			match(String(gate?.checks_json), /one failure/);
			const log = reader.events("run-1").find((event) => event.type === "log");
			strictEqual(log?.payload_json?.includes("content"), false);
		} finally {
			reader.close();
		}
	});
});
