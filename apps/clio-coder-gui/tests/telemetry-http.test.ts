import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { routes } from "../contracts/routes.js";
import { harness, json } from "./harness/app.js";
import {
	coldParityDtos,
	dtoLies,
	fixtureEnvelope,
	fixtureReceiptDraft,
	PARITY_SESSION,
	quantitiesOf,
	seedGoldenSession,
	seedParitySession,
	seedRunJournal,
	telemetryLies,
	writeSettledRun,
} from "./harness/telemetry-fixture.js";

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

test("the GUI serves the parity fixture's DTOs as the CLI reads them, and none tells a lie (#434 §13.2)", async (t) => {
	const h = await harness();
	t.after(() => h.close());
	const state = join(h.home.path, "state");
	await seedParitySession(state);
	const cold = coldParityDtos(state);
	const base = `/api/telemetry/sessions/${PARITY_SESSION}`;
	const timeless = (dto: unknown) =>
		JSON.parse(JSON.stringify(dto, (key, value: unknown) => (key === "generatedAt" ? undefined : value))) as unknown;
	const session = await json(await h.request(base), routes.telemetrySession.response);
	const byModel = await json(await h.request(`${base}/cost?by=model`), routes.telemetryCost.response);
	const byRole = await json(await h.request(`${base}/cost?by=role`), routes.telemetryCost.response);
	assert.deepEqual(timeless(session), timeless(cold.session));
	assert.deepEqual(timeless(byModel), timeless(cold.costByModel));
	assert.deepEqual(timeless(byRole), timeless(cold.costByRole));
	const served = [
		session,
		byModel,
		byRole,
		await json(await h.request(`${base}/calls`), routes.telemetryCalls.response),
		await json(await h.request(`${base}/cache`), routes.telemetryCache.response),
		await json(await h.request(`${base}/timeline`), routes.telemetryTimeline.response),
		await json(await h.request(`${base}/why-stopped`), routes.telemetryWhyStopped.response),
	];
	for (const dto of served) assert.deepEqual(dtoLies(dto), []);
});

test("telemetry routes refuse what the journals cannot answer with problems, never with zeros", async (t) => {
	const h = await harness();
	t.after(() => h.close());
	const state = join(h.home.path, "state");
	assert.equal((await h.request("/api/telemetry/sessions/absent-session")).status, 404);
	// A session this host holds with no journal is unknown coverage, never a missing resource (R9): the fixture
	// agent journals nothing, as a session from before journaling or one that never called a model would not.
	const workspace = await json(await h.post("/api/workspaces", { path: h.home.path }), routes.openWorkspace.response);
	const held = await json(
		await h.post(`/api/workspaces/${workspace.id}/sessions`, {}, "new-session"),
		routes.newSession.response,
	);
	const unjournaled = await json(
		await h.request(`/api/telemetry/sessions/${held.id}`),
		routes.telemetrySession.response,
	);
	assert.equal(unjournaled.journal.present, false);
	assert.equal(unjournaled.journal.skipped, 1);
	assert.match(unjournaled.totals.tokens.display, /unknown/);
	assert.match(unjournaled.totals.usd.display, /unknown|not measured/);
	assert.deepEqual(telemetryLies(quantitiesOf(unjournaled)), []);
	assert.equal((await h.request(`/api/telemetry/sessions/${held.id}/cost`)).status, 200);
	assert.equal((await h.request(`/api/telemetry/sessions/${held.id}/why-stopped`)).status, 200);
	const id = seedGoldenSession(state);
	const base = `/api/telemetry/sessions/${id}`;
	assert.equal((await h.request("/api/telemetry/sessions/absent-session")).status, 404);
	assert.equal((await h.request(`${base}/calls?dispositions=bogus`)).status, 422);
	assert.equal((await h.request(`${base}/calls?roles=main,worker&limit=1`)).status, 200);
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
	// A repository reference names the window `usage report` folds, rebuilt ending now, as the CLI's explain does.
	for (const ref of ["repo:all-30d#usd", "own:all-30d#calls"]) {
		const window = await json(
			await h.request(`/api/telemetry/explain?ref=${encodeURIComponent(ref)}`),
			routes.telemetryExplain.response,
		);
		assert.equal(window.ref, ref);
	}
	assert.equal((await h.request("/api/telemetry/explain?ref=repo:not-a-window%23usd")).status, 404);
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
	// The run page's split by model is the read model's run cost report: model groups, each quantity explained.
	const cost = await json(await h.request("/api/telemetry/runs/run-alpha/cost"), routes.telemetryRunCost.response);
	assert.deepEqual([cost.kind, cost.scope, cost.groupBy], ["cost", { runId: "run-alpha" }, "model"]);
	assert.ok(cost.groups.every((group) => group.audience === null && group.usd.ref.startsWith("run:run-alpha")));
	assert.equal((await h.request("/api/telemetry/runs/run-absent/cost")).status, 404);
	const quantities = [page, rest, run, cost].flatMap((dto) => quantitiesOf(dto));
	assert.deepEqual(telemetryLies(quantities), []);
	const explained = await json(
		await h.request(`/api/telemetry/explain?ref=${encodeURIComponent(run.row.usd.ref)}`),
		routes.telemetryExplain.response,
	);
	assert.deepEqual(explained.value, run.row.usd);
	assert.match(explained.coverage, /no contributions|contribution/);
	assert.equal((await h.request("/api/telemetry/runs/run-absent")).status, 404);
	assert.equal((await h.request("/api/telemetry/runs?cursor=not-a-cursor")).status, 422);
	assert.equal((await h.request("/api/telemetry/runs?limit=0")).status, 422);
});

test("a run's timeline orders its process, feed and settlement, with a feed duration the server words", async (t) => {
	const h = await harness();
	t.after(() => h.close());
	const state = join(h.home.path, "state");
	await seedRunJournal(state, "run-gamma", [
		{ kind: "process.started", data: {}, at: "2026-10-30T10:00:00.000Z" },
		{
			kind: "run.feed_appended",
			data: {
				seq: 1,
				body: { kind: "event", type: "clio_coder_tool_finish", tool: "read", outcome: "ok", durationMs: 1250 },
			},
			at: "2026-10-30T10:00:01.000Z",
		},
		{ kind: "process.exited", data: { exitCode: 0 }, at: "2026-10-30T10:00:02.000Z" },
	]);
	await writeSettledRun(
		state,
		fixtureReceiptDraft({
			...fixtureEnvelope("run-gamma"),
			sessionId: null,
			startedAt: "2026-10-30T10:00:00.000Z",
			endedAt: "2026-10-30T10:00:03.000Z",
		}),
	);
	const timeline = await json(
		await h.request("/api/telemetry/runs/run-gamma/timeline"),
		routes.telemetryRunTimeline.response,
	);
	assert.equal(timeline.kind, "run-timeline");
	assert.deepEqual(
		timeline.entries.map((entry) => entry.kind),
		["process", "feed", "process", "run", "run"],
	);
	// The run settles, then its scope seals; both are run lifecycle entries (#434).
	assert.deepEqual(
		timeline.entries.flatMap((entry) => (entry.kind === "run" ? [entry.event] : [])),
		["settled", "sealed"],
	);
	const feed = timeline.entries.find((entry) => entry.kind === "feed");
	assert.equal(feed?.kind === "feed" ? feed.duration?.display : null, "1.25s");
	assert.equal((await h.request("/api/telemetry/runs/run-absent/timeline")).status, 404);
});
