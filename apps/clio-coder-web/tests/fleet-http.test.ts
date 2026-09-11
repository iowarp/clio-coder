import assert from "node:assert/strict";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Councils, DispatchRuns, FleetGates, FleetReceipt, FleetRootDetail, FleetRoots } from "../contracts/fleet.js";
import { harness, json } from "./harness/app.js";
import { seedFleet } from "./harness/fleet-fixture.js";

test("fleet REST: every durable root paginates once beyond 64 entries, corrupt rows and escaping links stay isolated", async () => {
	const h = await harness();
	try {
		const seeded = await seedFleet(h.home.path, h.home.env);
		const ledger = await readFile(join(h.home.path, "state/runs.json"), "utf8");
		await writeFile(join(h.home.path, "outside.json"), '{"secret":"outside-state"}');
		await symlink(join(h.home.path, "outside.json"), join(h.home.path, "state/receipts/escape.json"));
		const visited: string[] = [];
		let cursor: string | null = null;
		do {
			const response = await h.request(`/api/fleet/runs?limit=17${cursor ? `&cursor=${cursor}` : ""}`);
			assert.equal(response.status, 200);
			const page = await json(response, FleetRoots);
			visited.push(...page.items.map((row) => row.id));
			cursor = page.nextCursor;
		} while (cursor);
		assert.equal(visited.length, seeded.count);
		assert.equal(new Set(visited).size, seeded.count);
		assert.equal(visited[0], "fleet-149");
		assert.equal(visited.at(-1), "fleet-000");
		const run = await json(await h.request("/api/fleet/runs/fleet-149"), FleetRootDetail);
		assert.equal(run.steps[0]?.output, "Fixture step passed.");
		assert.equal(run.receipt?.outcome, "succeeded");
		assert.deepEqual(
			run.councils.councils[0]?.members[0]?.turns.map((turn) => turn.round),
			[1, 2],
		);
		assert.equal(run.councils.councils[0]?.roundsPlanned, 2);
		assert.equal(run.gates.decisions[0]?.outcome, "pass");
		assert.equal(run.gates.decisions[0]?.id, seeded.gateId);
		assert.equal((await json(await h.request("/api/fleet/dispatches"), DispatchRuns)).items.length, 3);
		assert.equal((await json(await h.request("/api/fleet/councils"), Councils)).councils.length, 1);
		assert.equal((await json(await h.request("/api/fleet/gates"), FleetGates)).decisions.length, 1);
		assert.equal(
			(await json(await h.request("/api/fleet/receipts/member-two"), FleetReceipt)).receipt?.runId,
			"member-two",
		);
		assert.equal((await json(await h.request("/api/fleet/receipts/escape"), FleetReceipt)).receipt, null);
		assert.equal((await h.request("/api/fleet/runs/missing")).status, 404);
		for (const query of ["limit=0", "limit=1.5", "limit=101", "cursor=broken"])
			assert.equal((await h.request(`/api/fleet/runs?${query}`)).status, 422);
		assert.equal((await h.post("/api/fleet/runs")).status, 405);
		assert.equal(await readFile(join(h.home.path, "state/runs.json"), "utf8"), ledger);
		await writeFile(join(h.home.path, "state/runs.json"), " ".repeat(8 * 1024 * 1024 + 1));
		const oversized = await h.request("/api/fleet/dispatches");
		assert.equal(oversized.status, 503, "An unreadable ledger must not masquerade as empty history");
		assert.equal((await oversized.json()).code, "unavailable");
		assert.equal((await h.request("/api/meta")).status, 200);
	} finally {
		await h.close();
	}
});
