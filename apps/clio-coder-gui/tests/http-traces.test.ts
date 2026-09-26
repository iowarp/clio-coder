import assert from "node:assert/strict";
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { routes } from "../contracts/routes.js";
import { harness, json } from "./harness/app.js";
import { TraceReader, traceFixture } from "./harness/trace-fixture.js";

test("trace read-only seams, public projections, Date, rowid bounds, and full receipt policy", async (t) => {
	const h = await harness(),
		state = join(h.home.path, "state"),
		fixture = traceFixture(state);
	t.after(async () => {
		fixture.close();
		await h.close();
	});
	const reader = new TraceReader(fixture.path);
	assert.throws(() => reader.db.exec("DELETE FROM runs"), /readonly/);
	reader.close();
	const status = await json(await h.request("/api/traces/status"), routes.traceStatus.response);
	assert.equal(status.available, true);
	assert.equal(status.schemaVersion, 1);
	assert.ok(!JSON.stringify(status).includes(state));
	for (const [suffix, route] of [
		["", routes.traceRun],
		["/phases", routes.tracePhases],
		["/gates", routes.traceGates],
		["/processes", routes.traceProcesses],
	] as const) {
		const response = await h.request(`/api/traces/runs/run-0000${suffix}`);
		assert.equal(response.status, 200);
		assert.ok(Number.isFinite(Date.parse(response.headers.get("date") ?? "")));
		await json(response, route.response);
	}
	const first = await json(
		await h.request("/api/traces/runs/run-0000/events?after=0&limit=1"),
		routes.traceEvents.response,
	);
	assert.equal(first.events[0]?.event_id, "event-1");
	assert.equal(first.hasMore, true);
	const second = await json(
		await h.request(`/api/traces/runs/run-0000/events?after=${first.cursor}&limit=2`),
		routes.traceEvents.response,
	);
	assert.equal(second.events[0]?.event_id, "event-2");
	assert.equal(second.hasMore, false);
	for (const query of ["after=-1", "after=NaN", "after=1.5", "after=9007199254740992", "limit=501", "limit=0"])
		assert.equal((await h.request(`/api/traces/runs/run-0000/events?${query}`)).status, 422, query);
	const brief = await json(await h.request("/api/traces/runs/run-0000/receipt"), routes.traceReceipt.response);
	const full = await json(
		await h.request("/api/traces/runs/run-0000/receipt?include=full"),
		routes.traceReceipt.response,
	);
	for (const key of ["output", "upstreamResponses", "routeDecision", "briefing", "steering"]) {
		assert.ok(!(key in (brief.receipt ?? {})));
		assert.ok(key in (full.receipt ?? {}));
	}
	assert.equal(brief.evidence?.evidenceId, "evidence-1");
	assert.equal((await h.request("/api/traces/runs/missing")).status, 404);
	assert.equal((await h.post("/api/traces/runs")).status, 405);
	const head = await h.request("/api/traces/runs/run-0000", { method: "HEAD" });
	assert.equal(head.status, 200);
	assert.equal(await head.text(), "");
	for (const id of ["a%2Fb", "%2E%2E", "a%5Cb", "..%2Frun-0000", "a..b"]) {
		const response = await h.request(`/api/traces/runs/${id}/receipt`);
		assert.ok([404, 422].includes(response.status), `${id}: ${response.status}`);
	}
	const empty = await json(await h.request("/api/traces/runs/absent/receipt"), routes.traceReceipt.response);
	assert.deepEqual(empty, { receipt: null, evidence: null });
	for (const malformed of ["{bad", "[]", "null"]) {
		writeFileSync(join(state, "receipts/run-0000.json"), malformed);
		writeFileSync(join(state, "evidence-index.json"), malformed);
		assert.deepEqual(await json(await h.request("/api/traces/runs/run-0000/receipt"), routes.traceReceipt.response), {
			receipt: null,
			evidence: null,
		});
	}
	rmSync(join(state, "receipts/run-0000.json"));
	const outside = join(h.home.path, "outside.json");
	writeFileSync(outside, '{"secret":"must-not-leak"}');
	symlinkSync(outside, join(state, "receipts/run-0000.json"));
	assert.equal((await h.request("/api/traces/runs/run-0000/receipt?include=full")).status, 422);
});

test("trace status tolerates absence, refuses schema and non-WAL, and cached readers recover after replacement", async (t) => {
	const h = await harness(),
		state = join(h.home.path, "state");
	t.after(h.close);
	assert.equal((await json(await h.request("/api/traces/status"), routes.traceStatus.response)).available, false);
	assert.equal((await h.request("/api/traces/runs?cursor=e30")).status, 422);
	let fixture = traceFixture(state);
	assert.equal((await h.request("/api/traces/runs")).status, 200);
	fixture.store.db.exec("UPDATE meta SET value='99' WHERE key='schema_version'");
	assert.equal((await json(await h.request("/api/traces/status"), routes.traceStatus.response)).available, false);
	assert.equal((await h.request("/api/traces/runs")).status, 503);
	fixture.store.db.exec("UPDATE meta SET value='1' WHERE key='schema_version'");
	assert.equal((await h.request("/api/traces/runs")).status, 200);
	fixture.close();
	const replacement = join(h.home.path, "replacement");
	mkdirSync(replacement);
	fixture = traceFixture(replacement, 1);
	fixture.close();
	// Replace a complete SQLite file set, not a main file with the old WAL attached.
	for (const suffix of ["-wal", "-shm"]) {
		const path = join(state, `trace.sqlite${suffix}`);
		if (existsSync(path)) renameSync(path, `${path}.previous`);
	}
	renameSync(join(replacement, "trace.sqlite"), join(state, "trace.sqlite"));
	const page = await json(await h.request("/api/traces/runs"), routes.traceRuns.response);
	assert.equal(page.runs.length, 1);
	// Separate worker/home for journal mode refusal so an open read-only connection cannot hold the WAL lock.
	const other = await harness(),
		nonWal = traceFixture(join(other.home.path, "state"));
	nonWal.store.db.exec("PRAGMA journal_mode=DELETE");
	nonWal.close();
	try {
		assert.equal((await other.request("/api/traces/runs")).status, 503);
	} finally {
		await other.close();
	}
});

test("keyset scan retains TraceReader's source derivation for its additive source column", async (t) => {
	const h = await harness(),
		fixture = traceFixture(join(h.home.path, "state"));
	t.after(async () => {
		fixture.close();
		await h.close();
	});
	fixture.store.db.exec("ALTER TABLE runs DROP COLUMN source");
	const page = await json(await h.request("/api/traces/runs?source=session"), routes.traceRuns.response);
	assert.ok(page.runs.length);
	assert.ok(page.runs.every((row) => row.assignment_id === "session" && row.source === "session"));
});

test("canonical session turn trace namespaces read and paginate without authorizing receipt files", async (t) => {
	const h = await harness();
	const state = join(h.home.path, "state");
	const fixture = traceFixture(state, 1);
	t.after(async () => {
		fixture.close();
		await h.close();
	});
	const runId = "session:01a0dee8-0371-746d-a6f7-e9cb21b9634f";
	fixture.store.recordSessionTurn({
		kind: "start",
		runId,
		agent: "clio-coder",
		target: "local",
		model: "fixture",
		runtime: "native",
		prompt: "Inspect canonical session trace",
		at: "2026-09-26T10:00:00Z",
	});
	fixture.store.recordSessionTurn({
		kind: "event",
		runId,
		eventId: "call-1",
		type: "tool_call",
		name: "read",
		payload: { ok: true },
		startedAt: "2026-09-26T10:00:01Z",
		endedAt: "2026-09-26T10:00:02Z",
	});
	fixture.store.recordSessionTurn({
		kind: "finish",
		runId,
		status: "success",
		error: null,
		usage: null,
		at: "2026-09-26T10:00:03Z",
	});
	// A colon-named file must never become a dispatch receipt through the database ID seam.
	writeFileSync(join(state, "receipts", `${runId}.json`), '{"private":"must-not-read"}');
	for (const [suffix, route] of [
		["", routes.traceRun],
		["/phases", routes.tracePhases],
		["/gates", routes.traceGates],
		["/processes", routes.traceProcesses],
		["/events", routes.traceEvents],
	] as const) {
		const response = await h.request(`/api/traces/runs/${encodeURIComponent(runId)}${suffix}`);
		assert.equal(response.status, 200, suffix);
		await json(response, route.response);
	}
	const run = await json(await h.request(`/api/traces/runs/${encodeURIComponent(runId)}`), routes.traceRun.response);
	assert.equal(run.source, "session");
	assert.equal(run.run_id, runId);
	assert.equal(run.total_cost_usd, null);
	const phases = await json(
		await h.request(`/api/traces/runs/${encodeURIComponent(runId)}/phases`),
		routes.tracePhases.response,
	);
	assert.equal(phases[0]?.phase_id, runId);
	for (const full of ["", "?include=full"]) {
		assert.deepEqual(
			await json(
				await h.request(`/api/traces/runs/${encodeURIComponent(runId)}/receipt${full}`),
				routes.traceReceipt.response,
			),
			{ receipt: null, evidence: null },
		);
	}
	const first = await json(await h.request("/api/traces/runs?limit=1"), routes.traceRuns.response);
	assert.equal(first.runs[0]?.run_id, runId);
	assert.ok(first.nextCursor);
	const next = await h.request(`/api/traces/runs?limit=1&cursor=${first.nextCursor}`);
	assert.equal(next.status, 200, "Namespaced trace IDs remain valid inside an opaque keyset cursor");
	for (const unsafe of ["session:a/b", "session:a\\b", "session:..escape", "s".repeat(257)]) {
		assert.equal((await h.request(`/api/traces/runs/${encodeURIComponent(unsafe)}/events`)).status, 422);
	}
	assert.equal(
		(await h.request(`/api/fleet/receipts/${encodeURIComponent(runId)}`)).status,
		422,
		"Generic filesystem artifact identifiers stay restricted",
	);
});
