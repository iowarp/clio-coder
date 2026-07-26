import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
	type AdmissionQueueRequest,
	createAdmissionQueue,
	orderAdmissionRequests,
} from "../../src/domains/dispatch/admission-queue.js";
import { deriveRunPhaseDurations } from "../../src/domains/dispatch/phase-timing.js";

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
	it("plan waves cannot exceed their reserved peak", async () => {
		const queue = createAdmissionQueue<string>({
			maxSize: 4,
			finiteCeilingMs: 1000,
			reservedPlanPeaks: { p: 1 },
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
