import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { routes } from "../contracts/routes.js";
import { harness, json } from "./harness/app.js";
import { quantitiesOf, telemetryLies } from "./harness/telemetry-fixture.js";
import { traceFixture } from "./harness/trace-fixture.js";

test("trace history lists run journals joined to the ledger, with read-model rows and the full record policy", async (t) => {
	const h = await harness(),
		state = join(h.home.path, "state");
	t.after(() => h.close());
	assert.deepEqual(await json(await h.request("/api/traces/runs"), routes.traceRuns.response), {
		runs: [],
		nextCursor: null,
	});
	await traceFixture(state);
	const page = await json(await h.request("/api/traces/runs"), routes.traceRuns.response);
	assert.equal(page.runs.length, 12);
	assert.equal(page.runs[0]?.runId, "run-0000");
	const first = page.runs[0];
	assert.equal(first?.identity?.task, "Inspect fixture 0");
	assert.equal(first?.status, "success");
	assert.equal(first?.evidence.integrity.state, "verified");
	assert.equal(first?.evidence.sealed?.validationGrounding?.claimed, 2);
	assert.equal(page.runs.find((run) => run.runId === "run-0003")?.status, "running");
	assert.deepEqual(telemetryLies(page.runs.flatMap((run) => quantitiesOf(run.telemetry))), []);
	assert.ok(!JSON.stringify(page).includes("trace.sqlite"));
	const run = await json(await h.request("/api/traces/runs/run-0000"), routes.traceRun.response);
	assert.equal(run.telemetry.apiCalls.display, "1");
	assert.ok(Number.isFinite(Date.parse(run.writtenAt ?? "")));
	// A standalone run journal the ledger never held lists with its own row and an unknown status until it settles.
	mkdirSync(join(state, "telemetry", "runs", "standalone-1"));
	const standalone = await json(await h.request("/api/traces/runs/standalone-1"), routes.traceRun.response);
	assert.equal(standalone.identity, null);
	assert.equal(standalone.status, "unknown");
	assert.equal(standalone.writtenAt, null);
	assert.equal((await h.request("/api/traces/runs?status=unknown")).status, 200);
	const unknown = await json(await h.request("/api/traces/runs?status=unknown"), routes.traceRuns.response);
	assert.deepEqual(
		unknown.runs.map((row) => row.runId),
		["standalone-1"],
	);
	const brief = await json(await h.request("/api/traces/runs/run-0000/record"), routes.traceRunRecord.response);
	const full = await json(
		await h.request("/api/traces/runs/run-0000/record?include=full"),
		routes.traceRunRecord.response,
	);
	// A run's evidence comes through its seal check; the settled record leaves only when asked for (#434 §11.3).
	assert.equal(brief.record, null);
	assert.equal(brief.evidence.integrity.state, "verified");
	assert.equal(brief.evidence.sealed?.validationGrounding?.claimed, 2);
	assert.equal(full.record?.settled?.agentId, "coder");
	assert.equal(full.record?.seal?.status, "verified");
	// The assessment the run sealed with, read only under its verified seal (#434).
	assert.ok(brief.evidence.evidence?.assessedAt);
	assert.equal((await h.request("/api/traces/runs/missing")).status, 404);
	assert.equal((await h.post("/api/traces/runs")).status, 405);
	const head = await h.request("/api/traces/runs/run-0000", { method: "HEAD" });
	assert.equal(head.status, 200);
	assert.equal(await head.text(), "");
	for (const id of ["a%2Fb", "%2E%2E", "a%5Cb", "..%2Frun-0000", "session%3Aturn"]) {
		const response = await h.request(`/api/traces/runs/${id}/record`);
		assert.ok([404, 422].includes(response.status), `${id}: ${response.status}`);
	}
	const empty = await json(await h.request("/api/traces/runs/absent/record"), routes.traceRunRecord.response);
	assert.equal(empty.record, null);
	assert.equal(empty.evidence.record, "missing");
});

test("trace history refuses a bad cursor and an unreadable ledger, and re-reads a replaced one", async (t) => {
	const h = await harness(),
		state = join(h.home.path, "state");
	t.after(() => h.close());
	assert.equal((await h.request("/api/traces/runs?cursor=e30")).status, 422);
	await traceFixture(state, 2);
	writeFileSync(join(state, "runs.json"), " ".repeat(8 * 1024 * 1024 + 1));
	assert.equal((await h.request("/api/traces/runs")).status, 503);
	writeFileSync(join(state, "runs.json"), "[]");
	const page = await json(await h.request("/api/traces/runs"), routes.traceRuns.response);
	assert.deepEqual(
		page.runs.map((run) => [run.runId, run.identity]),
		[
			["run-0000", null],
			["run-0001", null],
		],
	);
	assert.equal(page.runs[0]?.status, "success", "a ledger-less run reads its journal's settlement");
});
