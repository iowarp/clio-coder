import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { AssignmentRegistry } from "../../src/domains/dispatch/assignment.js";
import { reconcileOrphanAssignments } from "../../src/domains/dispatch/assignment-reconcile.js";
import {
	cancelStoredAssignment,
	failQueuedAssignment,
	getStoredAssignment,
	recordAssignmentAttempt,
	registerAssignment,
	settleStoredAssignment,
} from "../../src/domains/dispatch/assignment-store.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

describe("dispatch assignment lifecycle", () => {
	let scratch: string | null = null;
	afterEach(() => {
		if (scratch !== null) clearScratchClioHome(scratch);
		scratch = null;
	});

	it("deduplicates opens and attempts, then finalizes the attached terminal", async () => {
		const registry = new AssignmentRegistry();
		const policy = { maxRetries: 1, failover: "approved" as const, allowedCandidates: [] };
		const opened = registry.open("run-root", policy);
		strictEqual(registry.open("run-root", policy).terminal, opened.terminal);
		registry.recordAttempt(opened.id, {
			runId: "run-root",
			attempt: 0,
			outcome: "failed",
			node: { id: "local", kind: "local" },
			receiptDigest: "digest-0",
			retryReason: "worker-runtime",
		});
		registry.recordAttempt(opened.id, {
			runId: "run-root",
			attempt: 0,
			outcome: "failed",
			node: null,
			receiptDigest: "duplicate",
			retryReason: null,
		});
		registry.recordAttempt(opened.id, {
			runId: "run-retry",
			attempt: 1,
			outcome: "succeeded",
			node: { id: "mini", kind: "ssh", host: "mini.lan" },
			receiptDigest: "digest-1",
			retryReason: null,
		});
		const envelope = fixtureEnvelope("run-retry");
		const receipt = withReceiptIntegrity(fixtureReceiptDraft(envelope), envelope);
		registry.settle(opened.id, receipt, "succeeded");
		strictEqual((await opened.terminal).runId, "run-retry");
		const final = registry.get(opened.id);
		strictEqual(final?.status, "succeeded");
		deepStrictEqual(final?.attempts.map(({ runId }) => runId), ["run-root", "run-retry"]);
	});

	it("keeps detached lifecycle state durable and transition-idempotent", async () => {
		scratch = await newScratchClioHome("clio-dispatch-lifecycle-");
		const started = await registerAssignment("assignment-1");
		strictEqual(started.status, "running");
		strictEqual(started.processOwner?.pid, process.pid);
		await recordAssignmentAttempt("assignment-1", "attempt-1");
		await recordAssignmentAttempt("assignment-1", "attempt-1");
		await recordAssignmentAttempt("assignment-1", "attempt-2");
		const settled = await settleStoredAssignment("assignment-1", "attempt-2", "succeeded");
		deepStrictEqual(settled.attempts, ["attempt-1", "attempt-2"]);
		strictEqual(settled.terminalRunId, "attempt-2");
		strictEqual(settled.status, "succeeded");
		strictEqual(settled.processOwner, undefined);
		await cancelStoredAssignment("assignment-1");
		strictEqual(getStoredAssignment("assignment-1")?.status, "succeeded", "terminal state cannot regress");

		await registerAssignment("assignment-cancel");
		strictEqual((await cancelStoredAssignment("assignment-cancel")).status, "canceled");
		await registerAssignment("assignment-fail");
		strictEqual((await failQueuedAssignment("assignment-fail")).status, "failed");
		strictEqual((await cancelStoredAssignment("assignment-fail")).status, "failed");
	});

	it("recovers an orphan from durable attempts and fails one without evidence", async () => {
		const settled: Array<[string, string, string]> = [];
		const summary = await reconcileOrphanAssignments({
			listRunning: () => [
				{ assignmentId: "recover", attempts: ["failed", "green"], terminalRunId: null, status: "running" },
				{ assignmentId: "abandoned", attempts: [], terminalRunId: null, status: "running" },
			],
			ownerAlive: () => false,
			lookupAttempt: (runId) => ({ runId, terminal: true, succeeded: runId === "green" }),
			settle: async (assignmentId, runId, status) => {
				settled.push([assignmentId, runId, status]);
			},
		});
		deepStrictEqual(settled, [
			["recover", "green", "succeeded"],
			["abandoned", "abandoned", "failed"],
		]);
		deepStrictEqual(summary, { recovered: 1, abandoned: 1 });
	});
});
