import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { routes } from "../contracts/routes.js";
import { harness, json } from "./harness/app.js";
import { quantitiesOf, telemetryLies } from "./harness/telemetry-fixture.js";
import { traceFixture } from "./harness/trace-fixture.js";

test("trace history lists run journals joined to the ledger, with read-model rows and the full receipt policy", async (t) => {
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
	assert.equal(page.runs.find((run) => run.runId === "run-0003")?.status, "running");
	assert.deepEqual(telemetryLies(page.runs.flatMap((run) => quantitiesOf(run.telemetry))), []);
	assert.ok(!JSON.stringify(page).includes("trace.sqlite"));
	const run = await json(await h.request("/api/traces/runs/run-0000"), routes.traceRun.response);
	assert.equal(run.telemetry.apiCalls.display, "1");
	assert.ok(Number.isFinite(Date.parse(run.writtenAt ?? "")));
	// A standalone run journal the ledger never held lists with its own row and an unknown status until it settles.
	mkdirSync(join(state, "runs", "standalone-1"));
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
	const brief = await json(await h.request("/api/traces/runs/run-0000/receipt"), routes.traceReceipt.response);
	const full = await json(
		await h.request("/api/traces/runs/run-0000/receipt?include=full"),
		routes.traceReceipt.response,
	);
	// The receipt is its evidence through the seal check; the saved document leaves only when asked for (#434 §11.3).
	assert.equal(brief.receipt, null);
	assert.equal(brief.evidence.integrity.state, "verified");
	assert.equal(brief.evidence.sealed?.validationGrounding?.claimed, 2);
	assert.equal(full.receipt?.runId, "run-0000");
	assert.equal(brief.evidence.evidence?.evidenceId, "evidence-1");
	// A pruned receipt reads back from its verified evidence copy, never as the tombstone it left (#434).
	const sealed = readFileSync(join(state, "receipts/run-0000.json"), "utf8");
	mkdirSync(join(h.home.path, "data/evidence/evidence-1"), { recursive: true });
	writeFileSync(
		join(h.home.path, "data/evidence/evidence-1/receipt.json"),
		JSON.stringify({ version: 1, receipts: [JSON.parse(sealed)] }),
	);
	writeFileSync(
		join(state, "receipts/run-0000.json"),
		JSON.stringify({
			format: "clio-receipt-tombstone/1",
			runId: "run-0000",
			evidenceId: "evidence-1",
			digest: (JSON.parse(sealed) as { integrity: { digest: string } }).integrity.digest,
			prunedAt: "2026-10-30T00:00:00.000Z",
		}),
	);
	const pruned = await json(
		await h.request("/api/traces/runs/run-0000/receipt?include=full"),
		routes.traceReceipt.response,
	);
	assert.deepEqual(pruned.receipt, full.receipt);
	assert.equal(pruned.evidence.integrity.state, "verified");
	writeFileSync(join(state, "receipts/run-0000.json"), sealed);
	assert.equal((await h.request("/api/traces/runs/missing")).status, 404);
	assert.equal((await h.post("/api/traces/runs")).status, 405);
	const head = await h.request("/api/traces/runs/run-0000", { method: "HEAD" });
	assert.equal(head.status, 200);
	assert.equal(await head.text(), "");
	for (const id of ["a%2Fb", "%2E%2E", "a%5Cb", "..%2Frun-0000", "session%3Aturn"]) {
		const response = await h.request(`/api/traces/runs/${id}/receipt`);
		assert.ok([404, 422].includes(response.status), `${id}: ${response.status}`);
	}
	const empty = await json(await h.request("/api/traces/runs/absent/receipt"), routes.traceReceipt.response);
	assert.equal(empty.receipt, null);
	assert.equal(empty.evidence.receipt, "missing");
	for (const malformed of ["{bad", "[]", "null"]) {
		writeFileSync(join(state, "receipts/run-0000.json"), malformed);
		writeFileSync(join(state, "evidence-index.json"), malformed);
		const unreadable = await json(
			await h.request("/api/traces/runs/run-0000/receipt?include=full"),
			routes.traceReceipt.response,
		);
		assert.equal(unreadable.receipt, null);
		assert.equal(unreadable.evidence.receipt, "unreadable");
		assert.equal(unreadable.evidence.sealed, null);
	}
	rmSync(join(state, "receipts/run-0000.json"));
	const outside = join(h.home.path, "outside.json");
	writeFileSync(outside, '{"secret":"must-not-leak"}');
	symlinkSync(outside, join(state, "receipts/run-0000.json"));
	assert.equal((await h.request("/api/traces/runs/run-0000/receipt?include=full")).status, 422);
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
