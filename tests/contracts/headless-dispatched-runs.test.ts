import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { settleDispatchedRuns } from "../../src/cli/modes/headless-dispatched-runs.js";
import type { RunEnvelope, RunOutcome } from "../../src/domains/dispatch/types.js";

const ROOT = "root-run";

function run(id: string, outcome: RunOutcome | null, attempt = 0, parentRunId: string | null = ROOT): RunEnvelope {
	return {
		id,
		agentId: "coder",
		status: outcome === null ? "running" : outcome === "succeeded" ? "completed" : "failed",
		outcome,
		endedAt: outcome === null ? null : "2026-09-30T00:00:00.000Z",
		lineage: { parentRunId, rootRunId: ROOT, attempt, depth: 1 },
	} as unknown as RunEnvelope;
}

describe("headless dispatched runs", () => {
	it("reports unretried failures as undelivered and names runs still live at shutdown", async () => {
		const runs = [
			run("retried-failure", "failed"),
			run("retry", "succeeded", 1, "retried-failure"),
			run("unretried-failure", "failed"),
			run("live", null),
		];
		let polls = 0;
		const settlement = await settleDispatchedRuns({ listRuns: () => runs }, ROOT, () => {
			polls += 1;
			return polls > 1;
		});
		deepStrictEqual(
			settlement.undelivered.map((entry) => entry.id),
			["unretried-failure"],
		);
		deepStrictEqual(
			settlement.live.map((entry) => entry.id),
			["live"],
		);
	});
});
