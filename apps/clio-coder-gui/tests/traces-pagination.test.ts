import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { routes } from "../contracts/routes.js";
import { harness, json } from "./harness/app.js";
import { traceFixture } from "./harness/trace-fixture.js";

test("240 run journals paginate exactly once with stable write-time ties, filters, and strict cursors", async (t) => {
	const h = await harness();
	t.after(() => h.close());
	// Ten journals share each write time, so ties break by run id across page boundaries.
	await traceFixture(
		join(h.home.path, "state"),
		240,
		(index) => Date.UTC(2026, 8, 11, 12) - Math.floor(index / 10) * 1000,
	);
	const seen: string[] = [];
	let cursor: string | null = null,
		pages = 0;
	do {
		const response = await h.request(`/api/traces/runs?limit=50${cursor ? `&cursor=${cursor}` : ""}`);
		assert.equal(response.status, 200);
		const page = await json(response, routes.traceRuns.response);
		seen.push(...page.runs.map((run) => run.runId));
		cursor = page.nextCursor;
		pages++;
	} while (cursor && pages < 10);
	assert.equal(pages, 5);
	assert.equal(cursor, null);
	assert.equal(seen.length, 240);
	assert.equal(new Set(seen).size, 240);
	const index = (id: string) => Number(id.slice(4));
	const group = (id: string) => Math.floor(index(id) / 10);
	assert.deepEqual(
		seen,
		[...seen].sort((a, b) => group(a) - group(b) || index(b) - index(a)),
	);
	const running = await json(await h.request("/api/traces/runs?status=running&limit=200"), routes.traceRuns.response);
	assert.equal(running.runs.length, 79);
	assert.ok(running.runs.every((run) => run.status === "running" && run.identity?.status === "running"));
	for (const q of ["run-0199", "fixture-model", "coder", "Inspect fixture 199", "native"]) {
		const page = await json(await h.request(`/api/traces/runs?q=${encodeURIComponent(q)}`), routes.traceRuns.response);
		assert.ok(page.runs.length, q);
	}
	for (const query of [
		"cursor=bad",
		"cursor=e30",
		"limit=201",
		"limit=0",
		"limit=2.5",
		"source=dispatch",
		"status=bad",
		"q=x&q=y",
	])
		assert.equal((await h.request(`/api/traces/runs?${query}`)).status, 422, query);
});
