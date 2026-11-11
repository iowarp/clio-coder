import assert from "node:assert/strict";
import { test } from "node:test";
import type { DetachedBatchRecord } from "../../src/domains/dispatch/batch-store.js";
import { dispatchOwnership } from "../../src/domains/dispatch/ownership.js";
import { renderCollectedBlock } from "../../src/domains/turn-control/index.js";
import type { MonitorToolDeps } from "../../src/tools/monitor.js";
import { collectDetachedBatch } from "../../src/tools/monitor-collect.js";
import { fixtureEnvelope } from "../harness/receipt.js";

test("collect names every run of a batch before the per-run detail a bounded block may cut", async () => {
	const ids = ["1jphsp9dq9tp", "2ijsusq71urw", "1pb4m5323cg0"];
	const record: DetachedBatchRecord = {
		id: "batch-three",
		runs: ids.map((id) => ({ runId: id, assignmentId: id, agentId: "coder" })),
		sessionId: "owner",
		createdAt: "fixture",
		collectedAt: null,
	};
	// Long per-run detail, as a capped worker's run carries, fills the bounded collected block.
	const runs = ids.map((id) => ({
		...fixtureEnvelope(id),
		sessionId: "owner",
		outcome: "failed" as const,
		exitCode: 1,
		outcomeDetail: `tool cap reached ${"x".repeat(1800)}`,
	}));
	const dispatch = {
		owner: () => ({ sessionId: "owner", cwd: "/workspace" }),
		getRun: (id: string) => runs.find((run) => run.id === id) ?? null,
		listRuns: () => runs,
		detached: {
			get: (id: string) => (id === record.id ? record : null),
			async markCollected() {
				record.collectedAt = "collected";
				return record;
			},
		},
	} as unknown as MonitorToolDeps["dispatch"];
	const outcome = await collectDetachedBatch(
		{ dispatch },
		record.id,
		dispatchOwnership({ sessionId: "owner", cwd: "/workspace" }),
	);
	assert.equal(outcome.kind, "ok");
	if (outcome.kind !== "ok") return;
	const block = renderCollectedBlock(outcome.output);
	for (const id of ids) assert.match(block, new RegExp(id, "u"), `collected block omits run ${id}`);
});
