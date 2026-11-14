import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { SessionOverviewItem } from "../contracts/session-overview.js";
import type { SessionSnapshot } from "../contracts/sessions.js";
import { projectSessionOverview, SessionWorkers } from "../server/acp/session-overview.js";

function snapshot(state: SessionSnapshot["state"]): SessionSnapshot {
	return {
		id: "session-1",
		workspaceId: "workspace-1",
		state,
		revision: 3,
		timeline: [],
		timelineTruncated: false,
		turns: [],
		recoveredOrphan: false,
		label: null,
		permissions: [],
		fleet: [],
		health: [],
	};
}

test("the live worker set names each run the engine still holds, with its agent, and drops it when it settles", () => {
	const workers = new SessionWorkers();
	workers.observe({ type: "fleet.enqueued", payload: { runId: "r1", agentId: "scout", node: null } });
	assert.deepEqual(workers.summary().runs, [{ runId: "r1", agentId: "scout", state: "queued", node: null }]);
	workers.observe({ type: "fleet.started", payload: { runId: "r1", agentId: "scout" } });
	assert.deepEqual(workers.summary().runs, [{ runId: "r1", agentId: "scout", state: "active", node: null }]);
	workers.observe({ type: "fleet.completed", payload: { runId: "r1", agentId: "scout", outcome: "succeeded" } });
	assert.deepEqual(workers.summary().runs, []);
});

test("an active run is listed before a queued one, and a run that never named its agent says so", () => {
	const workers = new SessionWorkers();
	workers.observe({ type: "fleet.enqueued", payload: { runId: "waiting", node: "blade" } });
	workers.observe({ type: "fleet.started", payload: { runId: "working", agentId: "builder" } });
	assert.deepEqual(workers.summary().runs, [
		{ runId: "working", agentId: "builder", state: "active", node: null },
		{ runId: "waiting", agentId: null, state: "queued", node: "blade" },
	]);
});

test("the overview carries the held session's live runs and none for a session no agent holds", () => {
	const workers = new SessionWorkers();
	workers.observe({ type: "fleet.started", payload: { runId: "r1", agentId: "scout" } });
	const open = projectSessionOverview(snapshot("open"), 0, undefined, workers.summary());
	assert.ok(Value.Check(SessionOverviewItem, open));
	assert.deepEqual(open.runs, [{ runId: "r1", agentId: "scout", state: "active", node: null }]);
	assert.equal(open.activeWorkers, 1);
	const parked = projectSessionOverview(snapshot("parked"), 0, undefined, workers.summary());
	assert.ok(Value.Check(SessionOverviewItem, parked));
	assert.deepEqual(parked.runs, []);
	assert.deepEqual(projectSessionOverview(snapshot("open")).runs, []);
});
