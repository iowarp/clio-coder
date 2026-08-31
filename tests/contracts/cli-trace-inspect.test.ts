/**
 * `clio-coder trace inspect --json`, the fixed read a GUI host may run.
 *
 * `trace runs --json` emits `SELECT *`, which carries the request text the
 * operator typed, and it accepts a database path and a limit. This command
 * accepts neither, and its payload is accounting facts only. These assert both
 * halves: that the argv is not a surface, and that nothing free-form escapes.
 */

import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	TRACE_INSPECT_MAX_EVENT_KINDS,
	TRACE_INSPECT_MAX_PHASES,
	TRACE_INSPECT_MAX_RUNS,
	traceInspectSnapshot,
} from "../../src/cli/trace-inspect.js";
import { TraceStore } from "../../src/domains/observability/trace-store.js";
import { makeScratchHome, runCli } from "../harness/spawn.js";

const AT = "2026-08-31T10:05:00.000Z";
const now = () => Date.parse(AT);

/**
 * One finished run plus `extraPhases` seeded phases.
 *
 * `upsertRun` writes a root phase of its own, named for the agent and carrying
 * the task text in `description`, so every run here has `extraPhases + 1`.
 */
function seedRun(store: TraceStore, runId: string, startedAt: string, extraPhases: number): void {
	store.upsertRun({
		runId,
		agentId: "coder",
		// The request text is the one field this command must never echo.
		task: "rewrite the private credential loader at /private/secrets.yaml",
		requestOrigin: "agent",
		targetId: "blade-gateway",
		wireModelId: "code",
		runtimeId: "litellm",
		runtimeKind: "http",
	});
	store.db
		.prepare(
			"UPDATE runs SET status='success', started_at=?, ended_at=?, total_tokens=?, total_cost_usd=? WHERE run_id=?",
		)
		.run(startedAt, "2026-08-31T10:00:30.000Z", 1200, 0.25, runId);
	for (let index = 0; index < extraPhases; index += 1) {
		store.db
			.prepare(
				`INSERT INTO phases (phase_id, run_id, seq, name, kind, owner, description, status, attempt, retries,
					error, started_at, ended_at, total_tokens, total_cost_usd)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			)
			.run(
				`${runId}-phase-${index}`,
				runId,
				index + 1,
				`phase-${index}`,
				"agent",
				"coder",
				"describes the private path /private/secrets.yaml",
				index === 0 ? "fail" : "success",
				1,
				index === 0 ? 2 : 0,
				index === 0 ? "the model replied with /private/secrets.yaml verbatim" : null,
				"2026-08-31T10:00:00.000Z",
				"2026-08-31T10:00:10.000Z",
				400,
				0.1,
			);
	}
}

describe("contracts/cli-trace-inspect", () => {
	const scratch = makeScratchHome("clio-trace-inspect-");
	after(() => scratch.cleanup());

	it("reports an installation with no trace database as unavailable rather than empty", () => {
		const snapshot = traceInspectSnapshot(now, join(scratch.dir, "state", "never-written.sqlite"));
		strictEqual(snapshot.version, 1);
		strictEqual(snapshot.generatedAt, AT);
		strictEqual(snapshot.available, false);
		strictEqual(snapshot.runs.length, 0);
		strictEqual(snapshot.truncated, false);
	});

	it("projects accounting facts and drops request text, descriptions, and error prose", () => {
		const db = join(scratch.dir, "one-run.sqlite");
		const store = new TraceStore(db);
		seedRun(store, "run-alpha", "2026-08-31T10:00:00.000Z", 2);
		store.close();

		const snapshot = traceInspectSnapshot(now, db);
		strictEqual(snapshot.available, true);
		strictEqual(snapshot.runs.length, 1);
		strictEqual(snapshot.truncated, false);
		const run = snapshot.runs[0];
		ok(run !== undefined);
		strictEqual(run.runId, "run-alpha");
		strictEqual(run.agent, "coder");
		strictEqual(run.target, "blade-gateway");
		strictEqual(run.status, "success");
		strictEqual(run.elapsedMs, 30_000);
		strictEqual(run.totalTokens, 1200);
		strictEqual(run.totalCostUsd, 0.25);
		strictEqual(run.phasesTruncated, false);
		// The store's own root phase, then the two seeded ones, in plan order.
		strictEqual(run.phases.length, 3);
		strictEqual(run.phases[0]?.name, "coder");

		const failing = run.phases[1];
		ok(failing !== undefined);
		strictEqual(failing.name, "phase-0");
		strictEqual(failing.kind, "agent");
		strictEqual(failing.retries, 2);
		// The fact that a phase errored crosses; the error text never does.
		strictEqual(failing.failed, true);
		strictEqual(run.phases[2]?.failed, false);
		strictEqual(failing.elapsedMs, 10_000);
		strictEqual(failing.totalTokens, 400);

		const framed = JSON.stringify(snapshot);
		for (const forbidden of [
			"/private/",
			"credential loader",
			"describes the private path",
			"verbatim",
			"phase_id",
			"assignment",
			".sqlite",
		])
			ok(!framed.includes(forbidden), `trace inspect leaked ${forbidden}`);
	});

	it("bounds the run window and the per-run phase index, and reports both truncations", () => {
		const db = join(scratch.dir, "many.sqlite");
		const store = new TraceStore(db);
		for (let index = 0; index < TRACE_INSPECT_MAX_RUNS + 2; index += 1) {
			// Ascending start stamps, so newest-first ordering cannot be write order.
			// The newest run gets one phase past the bound; the rest stay well under.
			seedRun(store, `run-${index}`, `2026-08-31T10:0${index}:00.000Z`, index === 9 ? TRACE_INSPECT_MAX_PHASES : 1);
		}
		store.close();

		const snapshot = traceInspectSnapshot(now, db);
		strictEqual(snapshot.runs.length, TRACE_INSPECT_MAX_RUNS);
		strictEqual(snapshot.truncated, true);
		strictEqual(snapshot.runs[0]?.runId, "run-9");
		strictEqual(snapshot.runs[0]?.phases.length, TRACE_INSPECT_MAX_PHASES);
		strictEqual(snapshot.runs[0]?.phasesTruncated, true);
		strictEqual(snapshot.runs.at(-1)?.runId, "run-2");
		strictEqual(snapshot.runs[1]?.phasesTruncated, false);
	});

	it("refuses every argv but the fixed one, and answers the fixed one on a fresh install", async () => {
		for (const args of [
			["trace", "inspect"],
			["trace", "inspect", "--json", "--limit", "3"],
			["trace", "inspect", "--json", "--db", join(scratch.dir, "one-run.sqlite")],
			["trace", "inspect", "--json", "extra"],
		]) {
			const result = await runCli(args, { env: scratch.env });
			strictEqual(result.code, 2, `stdout=${result.stdout} stderr=${result.stderr}`);
			match(result.stderr, /usage: clio-coder trace inspect --json/);
			strictEqual(result.stdout, "", `unexpected stdout: ${result.stdout}`);
		}

		const fixed = await runCli(["trace", "inspect", "--json"], { env: scratch.env });
		strictEqual(fixed.code, 0, `stderr=${fixed.stderr}`);
		// A state tree nothing has written to answers with a snapshot, not with the
		// human "no trace database yet" sentence the other read subcommands print.
		doesNotMatch(fixed.stdout, /no trace database yet/);
		const payload = JSON.parse(fixed.stdout) as { available: boolean; runs: unknown[] };
		strictEqual(payload.available, false);
		strictEqual(payload.runs.length, 0);
	});

	it("counts events and processes by kind without reading a payload or a command line", () => {
		const db = join(scratch.dir, "aggregates.sqlite");
		const store = new TraceStore(db);
		seedRun(store, "run-agg", "2026-08-31T10:00:00.000Z", 1);
		// Events whose payload and name are exactly what must not cross.
		const kinds = ["message_update", "message_update", "message_update", "tool_call", "log"];
		kinds.forEach((type, index) => {
			store.db
				.prepare(
					`INSERT INTO events (event_id, run_id, phase_id, parent_id, type, name, payload_json, tokens,
						started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
				)
				.run(
					`run-agg-event-${index}`,
					"run-agg",
					"run-agg",
					null,
					type,
					"read /private/researcher/secrets.yaml",
					JSON.stringify({ secret: "/private/researcher/secrets.yaml" }),
					null,
					`2026-08-31T10:00:0${index}.000Z`,
					`2026-08-31T10:00:1${index}.000Z`,
				);
		});
		// One exited worker and one still alive, both carrying a command line.
		for (const [index, endedAt] of [
			["0", "2026-08-31T10:00:20.000Z"],
			["1", null],
		] as const) {
			store.db
				.prepare(
					`INSERT INTO processes (run_id, kind, name, pid, command, command_digest, started_at, ended_at, host,
						birth_token) VALUES (?,?,?,?,?,?,?,?,?,?)`,
				)
				.run(
					"run-agg",
					"worker",
					`worker-${index}`,
					4242 + Number(index),
					"/usr/bin/node /private/researcher/agent.js --token hunter2",
					"digest",
					"2026-08-31T10:00:00.000Z",
					endedAt,
					"private-host",
					"birth-token",
				);
		}
		store.close();

		const run = traceInspectSnapshot(now, db).runs[0];
		ok(run !== undefined);
		strictEqual(run.events.total, 5);
		strictEqual(run.events.firstAt, "2026-08-31T10:00:00.000Z");
		strictEqual(run.events.lastAt, "2026-08-31T10:00:14.000Z");
		// Ordered by count, so the shape of the run reads at a glance.
		deepStrictEqual(run.events.kinds, [
			{ kind: "message_update", count: 3 },
			{ kind: "log", count: 1 },
			{ kind: "tool_call", count: 1 },
		]);
		strictEqual(run.events.kindsTruncated, false);
		strictEqual(run.events.kinds.length <= TRACE_INSPECT_MAX_EVENT_KINDS, true);

		strictEqual(run.processes.total, 2);
		strictEqual(run.processes.running, 1);
		deepStrictEqual(run.processes.kinds, [{ kind: "worker", total: 2, running: 1 }]);

		// The whole point of aggregating in SQL: none of this was ever read.
		const framed = JSON.stringify(run);
		for (const forbidden of [
			"/private/",
			"secrets.yaml",
			"hunter2",
			"4242",
			"private-host",
			"birth-token",
			"digest",
			"worker-0",
		])
			ok(!framed.includes(forbidden), `trace aggregates leaked ${forbidden}`);
	});

	it("reports no events and no processes as zero rather than as absent", () => {
		const db = join(scratch.dir, "quiet.sqlite");
		const store = new TraceStore(db);
		seedRun(store, "run-quiet", "2026-08-31T10:00:00.000Z", 0);
		store.close();

		const run = traceInspectSnapshot(now, db).runs[0];
		ok(run !== undefined);
		// A run that recorded nothing is a fact about the run, not a gap in the
		// read, so the span is null and the counts are zero rather than missing.
		strictEqual(run.events.total, 0);
		strictEqual(run.events.firstAt, null);
		strictEqual(run.events.lastAt, null);
		deepStrictEqual(run.events.kinds, []);
		strictEqual(run.processes.total, 0);
		strictEqual(run.processes.running, 0);
		deepStrictEqual(run.processes.kinds, []);
	});
});
