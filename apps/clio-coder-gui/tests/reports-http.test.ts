import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { UsageReport } from "../contracts/reports.js";
import { reportCostDisplays } from "../server/services/cost-display.js";
import { harness, json } from "./harness/app.js";
import { seedReports } from "./harness/reports-fixture.js";

test("usage JSON Lines bridge reports exact canonical workspace usage and distinguishes a missing store", async () => {
	const h = await harness();
	try {
		const workspace = await h.workspaces.open(h.home.path);
		const path = `/api/workspaces/${workspace.id}/usage`;
		const empty = await json(await h.request(path), UsageReport);
		assert.ok(empty.facts.some((row) => row.name === "session-store-missing"));
		assert.ok(!empty.facts.some((row) => row.name.startsWith("telemetry-")));
		await seedReports(h.home.path, h.home.env);
		const report = await json(await h.request(path), UsageReport);
		assert.equal(report.facts.find((row) => row.name === "sessions")?.values.value, 1);
		// Spend is the read model's, worded by the canonical renderer; the server only checked each row's shape (#434).
		const spend = report.facts.find((row) => row.name === "telemetry-cost" && row.values.groupBy === "role")?.values
			.report as { total: Record<"calls" | "tokens" | "usd", { display: string }> } | undefined;
		assert.deepEqual(
			[spend?.total.calls.display, spend?.total.tokens.display, spend?.total.usd.display],
			["2", "44", "~$0.02 est"],
		);
		const fields = report.facts.find((row) => row.name === "telemetry-tokens")?.values.tokens as
			| Record<string, { display: string }>
			| undefined;
		assert.deepEqual(
			["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"].map((key) => fields?.[key]?.display),
			["14", "10", "20", "0", "4", "44"],
		);
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

test("report limits carry server-rendered displays beside their numbers (#434)", () => {
	const rendered = reportCostDisplays({
		costCap: { maxUsd: 2 },
		route: { totalCostUpperBoundUsd: 0.25, ceilingUsd: null },
	});
	assert.deepEqual(rendered, {
		costCap: { maxUsd: 2, maxUsdDisplay: "$2.00" },
		route: {
			totalCostUpperBoundUsd: 0.25,
			totalCostUpperBoundUsdDisplay: "$0.25",
			ceilingUsd: null,
			ceilingUsdDisplay: "not set",
		},
	});
});
