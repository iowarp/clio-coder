import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type ReconcileAttemptView,
	reconcileOrphanAssignments,
} from "../../src/domains/dispatch/assignment-reconcile.js";
import type { DurableAssignmentRecord } from "../../src/domains/dispatch/assignment-store.js";

function record(id: string, attempts: string[]): DurableAssignmentRecord {
	return { assignmentId: id, attempts, terminalRunId: null, status: "running" };
}

describe("assignment reconciliation", () => {
	it("recovers a succeeded terminal attempt over any failed attempt", async () => {
		const settled: Array<[string, string, string]> = [];
		const ledger = new Map<string, ReconcileAttemptView>([
			["a1", { runId: "a1", terminal: true, succeeded: false }],
			["a2", { runId: "a2", terminal: true, succeeded: true }],
		]);
		const summary = await reconcileOrphanAssignments({
			listRunning: () => [record("a1", ["a1", "a2"])],
			lookupAttempt: (runId) => ledger.get(runId) ?? null,
			settle: async (assignmentId, terminalRunId, status) => {
				settled.push([assignmentId, terminalRunId, status]);
			},
		});
		deepStrictEqual(settled, [["a1", "a2", "succeeded"]]);
		deepStrictEqual(summary, { recovered: 1, abandoned: 0 });
	});

	it("fails against the last terminal attempt when none succeeded", async () => {
		const settled: Array<[string, string, string]> = [];
		const ledger = new Map<string, ReconcileAttemptView>([
			["b1", { runId: "b1", terminal: true, succeeded: false }],
			["b2", { runId: "b2", terminal: true, succeeded: false }],
		]);
		const summary = await reconcileOrphanAssignments({
			listRunning: () => [record("b1", ["b1", "b2"])],
			lookupAttempt: (runId) => ledger.get(runId) ?? null,
			settle: async (assignmentId, terminalRunId, status) => {
				settled.push([assignmentId, terminalRunId, status]);
			},
		});
		deepStrictEqual(settled, [["b1", "b2", "failed"]]);
		deepStrictEqual(summary, { recovered: 1, abandoned: 0 });
	});

	it("abandons an assignment with no recoverable attempt evidence", async () => {
		const settled: Array<[string, string, string]> = [];
		const summary = await reconcileOrphanAssignments({
			listRunning: () => [record("c1", ["c1"])],
			lookupAttempt: () => null,
			settle: async (assignmentId, terminalRunId, status) => {
				settled.push([assignmentId, terminalRunId, status]);
			},
		});
		deepStrictEqual(settled, [["c1", "c1", "failed"]]);
		deepStrictEqual(summary, { recovered: 0, abandoned: 1 });
	});

	it("abandons a claimed record rather than inheriting a green attempt's success", async () => {
		const settled: Array<[string, string, string, string | undefined]> = [];
		const summary = await reconcileOrphanAssignments({
			listRunning: () => [{ ...record("fleet-e1", ["e1", "e2"]), verdictOwner: "fleet" }],
			// Both attempts succeeded on their own. The fleet that owned the verdict
			// died before reaching one, and two green steps of a seven-step run are
			// not the run's answer.
			lookupAttempt: (runId) => ({ runId, terminal: true, succeeded: true }),
			settle: async (assignmentId, terminalRunId, status, owner) => {
				settled.push([assignmentId, terminalRunId, status, owner]);
			},
		});
		deepStrictEqual(settled, [["fleet-e1", "e2", "failed", "fleet"]]);
		deepStrictEqual(summary, { recovered: 0, abandoned: 1 });
	});

	it("leaves already-terminal durable records untouched", async () => {
		let settles = 0;
		const summary = await reconcileOrphanAssignments({
			listRunning: () => [{ assignmentId: "d1", attempts: ["d1"], terminalRunId: "d1", status: "succeeded" }],
			lookupAttempt: () => ({ runId: "d1", terminal: true, succeeded: true }),
			settle: async () => {
				settles += 1;
			},
		});
		strictEqual(settles, 0);
		deepStrictEqual(summary, { recovered: 0, abandoned: 0 });
	});
});
