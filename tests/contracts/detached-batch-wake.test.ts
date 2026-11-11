import assert from "node:assert/strict";
import { test } from "node:test";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { DetachedBatchNudgeView } from "../../src/domains/middleware/index.js";
import {
	createDetachedBatchWake,
	DETACHED_BATCH_WAKE_ORIGIN,
	type DetachedBatchDecision,
	detachedBatchDecisions,
} from "../../src/interactive/detached-batch-wake.js";
import type { ChatSubmitOptions } from "../../src/session-control/chat-loop.js";

function harness() {
	const world = {
		batches: [] as DetachedBatchNudgeView[],
		decisions: [] as DetachedBatchDecision[],
		streaming: false,
		operatorIdle: true,
	};
	const submits: Array<{ text: string; options: ChatSubmitOptions | undefined }> = [];
	const shown: string[] = [];
	let tick: (() => void) | null = null;
	const wake = createDetachedBatchWake({
		openBatches: () => world.batches,
		pendingDecisions: () => world.decisions,
		chat: {
			submit: async (text, options) => {
				submits.push({ text, options });
				options?.onAdmitted?.();
			},
			isStreaming: () => world.streaming,
			turnPreparation: () =>
				({ phase: "idle" }) as ReturnType<Parameters<typeof createDetachedBatchWake>[0]["chat"]["turnPreparation"]>,
			queuedMessages: () => ({ steer: [], followUp: [] }) as never,
			getSessionId: () => "session",
		},
		operatorIdle: () => world.operatorIdle,
		showTurn: (text) => shown.push(text),
		setInterval: (callback) => {
			tick = callback;
			return 1;
		},
		clearInterval: () => {
			tick = null;
		},
	});
	const settle = () => new Promise((resolve) => setImmediate(resolve));
	return { world, submits, shown, wake, settle, tick: () => tick?.(), polling: () => tick !== null };
}

test("a detached batch that settles after the turn wakes the idle agent once, after the operator's draft and the running turn", async () => {
	const h = harness();
	h.world.batches = [
		{ id: "batch-a", total: 2, terminal: 1 },
		{ id: "stale", total: 1, terminal: 1 },
	];
	h.wake.poke();
	assert.equal(h.submits.length, 0, "a batch that was already finished when first seen never wakes the session");
	assert.equal(h.polling(), true, "a running batch keeps the wake looking");

	h.world.batches = [
		{ id: "batch-a", total: 2, terminal: 2 },
		{ id: "stale", total: 1, terminal: 1 },
	];
	h.world.operatorIdle = false;
	h.wake.poke();
	h.world.operatorIdle = true;
	h.world.streaming = true;
	h.tick();
	assert.equal(h.submits.length, 0, "it waits behind the operator's draft and an in-flight turn");

	h.world.streaming = false;
	h.tick();
	await h.settle();
	assert.equal(h.submits.length, 1);
	const [wakeTurn] = h.submits;
	assert.match(wakeTurn?.text ?? "", /batch batch-a: 2\/2 run\(s\) finished/);
	assert.doesNotMatch(wakeTurn?.text ?? "", /stale/);
	assert.equal(wakeTurn?.options?.origin, DETACHED_BATCH_WAKE_ORIGIN);
	assert.deepEqual(h.shown, [wakeTurn?.text]);
	assert.equal(h.polling(), false, "nothing left to watch");

	h.wake.poke();
	await h.settle();
	assert.equal(h.submits.length, 1, "a settled batch wakes the session once");
});

test("a worker in a running detached batch waiting on the main agent's decision wakes it once per request", async () => {
	const h = harness();
	h.world.batches = [{ id: "batch-b", total: 1, terminal: 0 }];
	h.wake.poke();
	const decision = { id: "permission:req-1", batchId: "batch-b", lines: ["permission request req-1 from run r1"] };
	h.world.decisions = [decision];
	h.tick();
	await h.settle();
	assert.equal(h.submits.length, 1);
	assert.match(h.submits[0]?.text ?? "", /waiting for your decision[\s\S]*permission request req-1/);
	h.tick();
	await h.settle();
	assert.equal(h.submits.length, 1, "the same request does not wake the session again");

	const dispatch = {
		owner: () => ({ sessionId: "owner", cwd: "/workspace" }),
		detached: {
			list: () => [
				{ id: "owned", sessionId: "owner", runs: [{ runId: "r1", assignmentId: "r1", agentId: "scout" }] },
				{ id: "foreign", sessionId: "other", runs: [{ runId: "r2", assignmentId: "r2", agentId: "scout" }] },
			],
		},
		grants: {
			list: () =>
				["r1", "r2"].map((runId) => ({
					requestId: `req-${runId}`,
					runId,
					rootRunId: runId,
					agentId: "scout",
					attempt: 1,
					summary: "write src/a.ts",
					approvalAuthority: "main",
					deadlineAt: new Date(Date.now() + 60_000).toISOString(),
				})),
		},
	} as unknown as DispatchContract;
	assert.deepEqual(
		detachedBatchDecisions(dispatch).map((entry) => [entry.id, entry.batchId]),
		[["permission:req-r1", "owned"]],
	);
});
