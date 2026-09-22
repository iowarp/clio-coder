import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { UsageReport } from "../contracts/reports.js";
import { harness, json } from "./harness/app.js";
import { seedReports } from "./harness/reports-fixture.js";

test("usage JSON Lines bridge reports exact canonical workspace usage and distinguishes a missing store", async () => {
	const h = await harness();
	try {
		const workspace = await h.workspaces.open(h.home.path);
		const path = `/api/workspaces/${workspace.id}/usage`;
		const empty = await json(await h.request(path), UsageReport);
		assert.ok(empty.facts.some((row) => row.name === "session-store-missing"));
		assert.ok(!empty.facts.some((row) => row.name === "tokens"));
		await seedReports(h.home.path, h.home.env);
		const report = await json(await h.request(path), UsageReport);
		assert.equal(report.facts.find((row) => row.name === "sessions")?.values.value, 1);
		const usage = report.facts.find((row) => row.name === "tokens")?.values;
		assert.equal(usage?.apiCalls, 2);
		assert.equal(usage?.totalTokens, 44);
		assert.equal(usage?.costUsd, 0.02);
		const foreign = join(h.home.path, "another-workspace");
		await mkdir(foreign);
		const other = await h.workspaces.open(foreign);
		const isolated = await json(await h.request(`/api/workspaces/${other.id}/usage`), UsageReport);
		assert.equal(isolated.facts.find((row) => row.name === "sessions")?.values.value, 0);
		assert.equal((await h.request(`${path}?repo=/arbitrary`)).status, 422);
		assert.equal((await h.request(`${path}?days=1`)).status, 422);
		assert.equal(h.cli.activeCount, 0);
	} finally {
		await h.close();
	}
});
