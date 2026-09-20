import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { routes } from "../contracts/routes.js";
import { harness, json } from "./harness/app.js";
import { traceFixture } from "./harness/trace-fixture.js";

test("1,200 trace runs paginate exactly once with stable ties, filters, and strict cursors", async (t) => {
	const h = await harness(),
		fixture = traceFixture(join(h.home.path, "state"), 1200);
	t.after(async () => {
		fixture.close();
		await h.close();
	});
	const seen: string[] = [];
	let cursor: string | null = null,
		pages = 0;
	do {
		const response = await h.request(`/api/traces/runs?limit=200${cursor ? `&cursor=${cursor}` : ""}`);
		assert.equal(response.status, 200);
		const page = await json(response, routes.traceRuns.response);
		assert.equal(page.runs.length, 200);
		seen.push(...page.runs.map((run) => run.run_id));
		cursor = page.nextCursor;
		pages++;
	} while (cursor && pages < 10);
	assert.equal(pages, 6);
	assert.equal(cursor, null);
	assert.equal(seen.length, 1200);
	assert.equal(new Set(seen).size, 1200);
	assert.deepEqual(seen, [...seen].sort().reverse());
	const filtered = await json(
		await h.request("/api/traces/runs?source=session&status=success&limit=200"),
		routes.traceRuns.response,
	);
	assert.ok(filtered.runs.length);
	assert.ok(filtered.runs.every((run) => run.source === "session" && run.status === "success"));
	for (const q of ["run-0999", "fixture-model", "coder", "Inspect fixture 999", "running"]) {
		const page = await json(await h.request(`/api/traces/runs?q=${encodeURIComponent(q)}`), routes.traceRuns.response);
		assert.ok(page.runs.length, q);
	}
	for (const query of [
		"cursor=bad",
		"cursor=e30",
		"limit=201",
		"limit=0",
		"limit=2.5",
		"source=other",
		"status=bad",
		"q=x&q=y",
	])
		assert.equal((await h.request(`/api/traces/runs?${query}`)).status, 422, query);
});
