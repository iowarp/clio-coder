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
	TRACE_SCHEMA_VERSION,
	TraceReader,
	TraceSchemaVersionError,
	TraceStore,
} from "../../src/domains/observability/trace-store.js";

const scratch = mkdtempSync(join(tmpdir(), "clio-trace-store-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

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
