import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { routes } from "../contracts/routes.js";
import { harness, json } from "./harness/app.js";
import { quantitiesOf, seedGoldenSession, seedRunJournal, telemetryLies } from "./harness/telemetry-fixture.js";

test("telemetry routes serve the read-model DTOs; every quantity passes the lie detectors and explains to itself", async (t) => {
	const h = await harness();
	t.after(() => h.close());
	const state = join(h.home.path, "state");
	const id = seedGoldenSession(state);
	const base = `/api/telemetry/sessions/${id}`;
	const session = await json(await h.request(base), routes.telemetrySession.response);
	assert.equal(session.sessionId, id);
	assert.equal(session.kind, "session");
	const calls = await json(await h.request(`${base}/calls`), routes.telemetryCalls.response);
	const neverSent = await json(await h.request(`${base}/calls?dispositions=never_sent`), routes.telemetryCalls.response);
	assert.equal(neverSent.calls.length, 1);
	assert.equal(neverSent.calls[0]?.usage, null);
	const cost = await json(await h.request(`${base}/cost?by=model`), routes.telemetryCost.response);
	assert.equal(cost.groupBy, "model");
	const cache = await json(await h.request(`${base}/cache`), routes.telemetryCache.response);
	const timeline = await json(await h.request(`${base}/timeline`), routes.telemetryTimeline.response);
	const whyStopped = await json(await h.request(`${base}/why-stopped`), routes.telemetryWhyStopped.response);
	const served = [session, calls, cost, cache, timeline, whyStopped];
	const quantities = served.flatMap((dto) => quantitiesOf(dto));
	assert.ok(quantities.length > 100);
	assert.deepEqual(telemetryLies(quantities), []);
	// L5 over HTTP: the explain route answers each reference with the quantity that carried it. The calls report
	// repeats the per-attempt references the other DTOs already cover, so a slice of it is enough.
	const refs = new Map(
		[session, cost, cache, timeline, whyStopped].flatMap((dto) => quantitiesOf(dto)).map((q) => [q.ref, q]),
	);
	for (const quantity of quantitiesOf(calls).slice(0, 40)) refs.set(quantity.ref, quantity);
	for (const [ref, quantity] of refs) {
		const explained = await json(
			await h.request(`/api/telemetry/explain?ref=${encodeURIComponent(ref)}`),
			routes.telemetryExplain.response,
		);
		assert.deepEqual(explained.value, quantity, ref);
		assert.equal(explained.ref, ref);
	}
	assert.ok(!JSON.stringify(served).includes(state), "no state path leaks into a DTO");
});

test("telemetry routes refuse what the journals cannot answer with problems, never with zeros", async (t) => {
	const h = await harness();
	t.after(() => h.close());
	const state = join(h.home.path, "state");
	assert.equal((await h.request("/api/telemetry/sessions/absent-session")).status, 404);
	const id = seedGoldenSession(state);
	const base = `/api/telemetry/sessions/${id}`;
	assert.equal((await h.request("/api/telemetry/sessions/absent-session")).status, 404);
	assert.equal((await h.request(`${base}/calls?dispositions=bogus`)).status, 422);
	assert.equal((await h.request(`${base}/calls?labels=main,worker&limit=1`)).status, 200);
	assert.equal((await h.request(`${base}/timeline?from=2026-10-19T00:00:00.000Z`)).status, 422);
	assert.equal((await h.request(`${base}/cost?by=weekday`)).status, 422);
	assert.equal((await h.request("/api/telemetry/explain?ref=own:golden-p0%23nothing")).status, 422);
	assert.equal((await h.request("/api/telemetry/explain?ref=own:absent-session%23usd")).status, 404);
	// A run reference names a journal the fold may not have: that is unknown coverage, counted and shown, not silence (R9).
	const gone = await json(
		await h.request("/api/telemetry/explain?ref=run:absent-run%23usd"),
		routes.telemetryExplain.response,
	);
	assert.match(gone.value.display, /unknown|not measured/);
	assert.match(gone.rule, /unreadable/);
});

test("run routes list run journals newest first as read-model rows and serve one run's telemetry", async (t) => {
	const h = await harness();
	t.after(() => h.close());
	const state = join(h.home.path, "state");
	assert.deepEqual(await json(await h.request("/api/telemetry/runs"), routes.telemetryRuns.response), {
		runs: [],
		nextCursor: null,
	});
	await seedRunJournal(state, "run-alpha");
	await seedRunJournal(state, "run-beta");
	const page = await json(await h.request("/api/telemetry/runs?limit=1"), routes.telemetryRuns.response);
	assert.equal(page.runs.length, 1);
	assert.ok(page.nextCursor);
	const rest = await json(
		await h.request(`/api/telemetry/runs?limit=1&cursor=${page.nextCursor}`),
		routes.telemetryRuns.response,
	);
	assert.deepEqual(new Set([...page.runs, ...rest.runs].map((row) => row.runId)), new Set(["run-alpha", "run-beta"]));
	assert.equal(rest.nextCursor, null);
	const run = await json(await h.request("/api/telemetry/runs/run-alpha"), routes.telemetryRun.response);
	assert.equal(run.kind, "run");
	assert.equal(run.row.runId, "run-alpha");
	const quantities = [page, rest, run].flatMap((dto) => quantitiesOf(dto));
	assert.deepEqual(telemetryLies(quantities), []);
	const explained = await json(
		await h.request(`/api/telemetry/explain?ref=${encodeURIComponent(run.row.usd.ref)}`),
		routes.telemetryExplain.response,
	);
	assert.deepEqual(explained.value, run.row.usd);
	assert.equal((await h.request("/api/telemetry/runs/run-absent")).status, 404);
	assert.equal((await h.request("/api/telemetry/runs?cursor=not-a-cursor")).status, 422);
	assert.equal((await h.request("/api/telemetry/runs?limit=0")).status, 422);
});
