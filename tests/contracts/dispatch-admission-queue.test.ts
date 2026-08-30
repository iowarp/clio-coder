import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { createCapacityAdmissionController } from "../../src/domains/dispatch/admission.js";
import {
	type AdmissionQueueRequest,
	createAdmissionQueue,
	orderAdmissionRequests,
} from "../../src/domains/dispatch/admission-queue.js";
import { capacityDrain, listCapacityLeases } from "../../src/domains/dispatch/capacity-lease.js";
import { deriveRunPhaseDurations } from "../../src/domains/dispatch/phase-timing.js";
import { registerForegroundStream } from "../../src/domains/providers/endpoint-capacity.js";
import { createTestClock } from "../harness/clock.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function request(id: string, overrides: Partial<AdmissionQueueRequest<string>> = {}): AdmissionQueueRequest<string> {
	return {
		requestId: id,
		assignmentId: id,
		priority: 0,
		queuedAt: 10,
		deadlineAt: 1000,
		planId: null,
		planOrder: null,
		value: id,
		...overrides,
	};
}

describe("bounded dispatch admission queue", () => {
	it("FIFO fairness is deterministic within priority", () => {
		deepStrictEqual(
			orderAdmissionRequests([request("b"), request("a"), request("high", { priority: 1 })]).map(
				(entry) => entry.requestId,
			),
			["high", "a", "b"],
		);
	});
	it("queue bound fails closed before allocation", async () => {
		const queue = createAdmissionQueue<string>({ maxSize: 1, finiteCeilingMs: 1000, now: () => 10 });
		void queue.enqueue(request("a"));
		await rejects(queue.enqueue(request("b")), /queue full/);
		queue.cancel("a");
	});
	it("queued cancellation releases resources and spawns nothing", async () => {
		let released = 0;
		let spawned = 0;
		const queue = createAdmissionQueue<string>({
			maxSize: 2,
			finiteCeilingMs: 1000,
			now: () => 10,
			onRelease: () => released++,
		});
		const outcome = queue.enqueue(request("a")).then((value) => {
			if (value.state === "admitted") spawned++;
			return value;
		});
		strictEqual(queue.cancel("a"), true);
		strictEqual((await outcome).state, "canceled");
		strictEqual(released, 1);
		strictEqual(spawned, 0);
	});
	it("queued deadline expires as timed out and starts no retry", async () => {
		let released = 0;
		const queue = createAdmissionQueue<string>({
			maxSize: 2,
			finiteCeilingMs: 1000,
			now: () => 20,
			onRelease: () => released++,
		});
		const outcome = queue.enqueue(request("a", { queuedAt: 10, deadlineAt: 15 }));
		strictEqual(queue.admitNext(20), null);
		strictEqual((await outcome).state, "timed_out");
		strictEqual(released, 1);
	});
	it("queue wait is sealed into phase timing", () => {
		const timing = deriveRunPhaseDurations(
			{
				requestedAt: "2026-01-01T00:00:00.000Z",
				decisionStartedAt: "2026-01-01T00:00:00.010Z",
				decisionCompletedAt: "2026-01-01T00:00:00.020Z",
				queuedAt: "2026-01-01T00:00:00.025Z",
				admittedAt: "2026-01-01T00:00:00.125Z",
			},
			"2026-01-01T00:00:00.130Z",
			"2026-01-01T00:00:00.200Z",
		);
		strictEqual(timing.queueWaitMs, 100);
	});
	it("the controller holds one plan to its reserved peak", async () => {
		const isolated = await isolateClioEnv("clio-admit-");
		const controller = createCapacityAdmissionController({
			limits: () => ({ global: 4, nodes: { local: 4 }, endpoints: {} }),
			reservedPlanPeak: (planId) => (planId === "plan-1" ? 1 : undefined),
		});
		try {
			const deadlineAt = Date.now() + 10_000;
			const first = await controller.admit({ assignmentId: "one", nodeId: "local", deadlineAt, planId: "plan-1" });
			strictEqual(controller.activePlanCount("plan-1"), 1);
			let secondSettled = false;
			const second = controller
				.admit({ assignmentId: "two", nodeId: "local", deadlineAt, planId: "plan-1" })
				.then((value) => {
					secondSettled = true;
					return value;
				});
			await new Promise((resolve) => setTimeout(resolve, 80));
			strictEqual(secondSettled, false, "the plan's second member waits for its own reserved slot");
			strictEqual(listCapacityLeases().length, 1, "global capacity was free but the plan peak was not");
			controller.release(first.lease.leaseId);
			const admitted = await second;
			strictEqual(admitted.lease.assignmentId, "two");
			strictEqual(controller.activePlanCount("plan-1"), 1);
			controller.release(admitted.lease.leaseId);
		} finally {
			controller.stop();
			isolated.restore();
		}
	});
	it("endpoint saturation is refused immediately with the model-facing remedy", async () => {
		const isolated = await isolateClioEnv("clio-admit-");
		const endpointKey = "http://127.0.0.1:8080";
		const releaseForeground = registerForegroundStream(endpointKey);
		const controller = createCapacityAdmissionController({
			limits: () => ({ global: 4, nodes: { local: 4 }, endpoints: { [endpointKey]: 1 } }),
		});
		try {
			await rejects(
				controller.admit({
					assignmentId: "blocked-by-chat",
					nodeId: "local",
					endpointKey,
					deadlineAt: Date.now() + 60_000,
				}),
				/capacity reached \(1\/1 slots\).*orchestrator's own turn holds one/u,
			);
			strictEqual(listCapacityLeases().length, 0);
		} finally {
			controller.stop();
			releaseForeground();
			isolated.restore();
		}
	});
	/**
	 * The defect this pins: a live dispatch waited nearly two minutes and came
	 * back with "dispatch: admission timed_out", 39 bytes that named neither the
	 * wall it hit nor a way past it, so the model had nothing to act on.
	 */
	it("an admission timeout names the capacity it waited on and what would clear it", async () => {
		const isolated = await isolateClioEnv("clio-admit-");
		// Which of the two branches below fires is decided by arithmetic on this
		// clock, not by a 120ms real deadline racing the pump's 10ms→500ms
		// backoff: on a loaded runner that race produced the sibling test's
		// message here and neither test could tell you which it had run.
		const clock = createTestClock();
		const controller = createCapacityAdmissionController({
			limits: () => ({ global: 1, nodes: { local: 1 }, endpoints: {} }),
			usage: () => ({ global: 1, nodes: { local: 1 }, endpoints: {} }),
			now: clock.now,
		});
		try {
			const held = await controller.admit({ assignmentId: "held", nodeId: "local", deadlineAt: clock.now() + 10_000 });
			const queued = controller.admit({ assignmentId: "queued", nodeId: "local", deadlineAt: clock.now() + 120 });
			// enqueue ran synchronously above, so the request is queued behind the
			// held lease with a live deadline. Spend it: the next pump reads the
			// injected clock and times the request out on arithmetic.
			clock.advance(200);
			await rejects(queued, (error: Error) => {
				strictEqual(error.message.startsWith("dispatch: dispatch:"), false, error.message);
				for (const fragment of ["admission timed out after 200ms", "1/1 worker slots in use on 'local'", "concurrency"]) {
					strictEqual(error.message.includes(fragment), true, `${fragment} missing from: ${error.message}`);
				}
				return true;
			});
			controller.release(held.lease.leaseId);
		} finally {
			controller.stop();
			isolated.restore();
		}
	});
	/**
	 * The second half of the same defect. A dispatch whose deadline was already
	 * spent before it reached the queue reported "admission timed out after 1ms
	 * waiting for a worker slot (0/4 worker slots in use on 'local', 0/4
	 * globally)" for a tool call that had run for 76 seconds. The fleet was
	 * idle, so waiting for work to settle, dispatching fewer runs, and raising
	 * concurrency were all wrong, and the real cost sat before admission.
	 */
	it("an already-expired deadline says so instead of blaming capacity", async () => {
		const isolated = await isolateClioEnv("clio-admit-");
		// The other branch of the same fork, and the same reason for a clock: the
		// deadline is 16s behind the injected now at the instant admit() reads it,
		// so nothing about how long the runner takes can move this off the
		// already-passed branch.
		const clock = createTestClock();
		const controller = createCapacityAdmissionController({
			limits: () => ({ global: 4, nodes: { local: 4 }, endpoints: {} }),
			usage: () => ({ global: 0, nodes: { local: 0 }, endpoints: {} }),
			now: clock.now,
		});
		try {
			await rejects(
				controller.admit({ assignmentId: "late", nodeId: "local", deadlineAt: clock.now() - 16_000 }),
				(error: Error) => {
					ok(error.message.includes("admission deadline had already passed"), error.message);
					ok(error.message.includes("never waited on capacity"), error.message);
					ok(error.message.includes("0/4 worker slots in use on 'local'"), error.message);
					ok(!error.message.includes("Wait for running work to settle"), error.message);
					ok(!error.message.includes("raise budget.concurrency"), error.message);
					return true;
				},
			);
		} finally {
			controller.stop();
			isolated.restore();
		}
	});
	it("a rejected admission leaves nothing pending behind it", async () => {
		const isolated = await isolateClioEnv("clio-admit-");
		const controller = createCapacityAdmissionController({
			limits: () => ({ global: 1, nodes: { local: 1 }, endpoints: {} }),
			maxQueueSize: 1,
		});
		try {
			const deadlineAt = Date.now() + 10_000;
			const held = await controller.admit({ assignmentId: "held", nodeId: "local", deadlineAt });
			const queued = controller.admit({ assignmentId: "queued", nodeId: "local", deadlineAt });
			await rejects(controller.admit({ assignmentId: "overflow", nodeId: "local", deadlineAt }), /queue full/);
			// A cancel for the rejected assignment must not match a live request id.
			strictEqual(controller.cancel("overflow"), false);
			strictEqual(controller.cancel("queued"), true);
			await rejects(queued, /admission canceled/);
			controller.release(held.lease.leaseId);
		} finally {
			controller.stop();
			isolated.restore();
		}
	});
	it("shutdown drain is process-local and cancels queued work", async () => {
		const isolated = await isolateClioEnv("clio-admit-");
		const controller = createCapacityAdmissionController({
			limits: () => ({ global: 1, nodes: { local: 1 }, endpoints: {} }),
		});
		try {
			const deadlineAt = Date.now() + 10_000;
			const held = await controller.admit({ assignmentId: "held", nodeId: "local", deadlineAt });
			const queued = controller.admit({ assignmentId: "queued", nodeId: "local", deadlineAt });
			controller.drain();
			await rejects(queued, /admission canceled/);
			await rejects(controller.admit({ assignmentId: "late", nodeId: "local", deadlineAt }), /shutting down/);
			// A shutting-down process never writes the machine-wide operator drain.
			strictEqual(capacityDrain(), null);
			strictEqual(
				listCapacityLeases().some((lease) => lease.leaseId === held.lease.leaseId),
				true,
			);
		} finally {
			controller.stop();
			isolated.restore();
		}
	});
	it("plan waves cannot exceed their reserved peak", async () => {
		const queue = createAdmissionQueue<string>({
			maxSize: 4,
			finiteCeilingMs: 1000,
			reservedPlanPeak: (planId) => (planId === "p" ? 1 : undefined),
			now: () => 10,
		});
		const outcomes = [
			queue.enqueue(request("p2", { planId: "p", planOrder: 2 })),
			queue.enqueue(request("p1", { planId: "p", planOrder: 1 })),
		];
		strictEqual(queue.admitNext(20)?.requestId, "p1");
		strictEqual(queue.admitNext(20), null);
		queue.complete("p1");
		strictEqual(queue.admitNext(20)?.requestId, "p2");
		await Promise.all(outcomes);
	});
});
