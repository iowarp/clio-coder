import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
		assert.equal(run.evidence.runId, "fleet-149");
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
		// A run's evidence comes through its seal check; the settled record leaves only when asked for (#434 §11.3).
		const brief = await json(await h.request("/api/fleet/receipts/member-two"), FleetReceipt);
		assert.equal(brief.record, null);
		assert.equal(brief.evidence.runId, "member-two");
		assert.equal(brief.evidence.integrity.state, "verified");
		const full = (path: string) => h.request(`${path}?include=full`);
		const record = (await json(await full("/api/fleet/receipts/member-two"), FleetReceipt)).record;
		assert.equal((record?.settled as { agentId?: string } | undefined)?.agentId, "researcher");
		// "escape" is in no listing, so the served-id window refuses it before the
		// adapter runs; the symlink containment is asserted where it now lives.
		assert.equal((await h.request("/api/fleet/receipts/escape")).status, 403);
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

test("fleet inventory distinguishes an absent store from a present empty store", async () => {
	const h = await harness();
	try {
		const absentRoots = await json(await h.request("/api/fleet/runs"), FleetRoots);
		const absentDispatches = await json(await h.request("/api/fleet/dispatches"), DispatchRuns);
		assert.equal(absentRoots.present, false);
		assert.equal(absentDispatches.present, false);
		assert.deepEqual(absentRoots.items, []);
		assert.deepEqual(absentDispatches.items, []);
		await mkdir(join(h.home.path, "state/fleet-runs"), { recursive: true });
		await writeFile(join(h.home.path, "state/runs.json"), "[]");
		const emptyRoots = await json(await h.request("/api/fleet/runs"), FleetRoots);
		const emptyDispatches = await json(await h.request("/api/fleet/dispatches"), DispatchRuns);
		assert.equal(emptyRoots.present, true);
		assert.equal(emptyDispatches.present, true);
		assert.deepEqual(emptyRoots.items, []);
		assert.deepEqual(emptyDispatches.items, []);
	} finally {
		await h.close();
	}
});
