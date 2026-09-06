import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, it } from "node:test";
import { createCapacityAdmissionController } from "../../src/domains/dispatch/admission.js";
import {
	acquireCapacityLease,
	type CapacityLimits,
	capacityStateLockPath,
	readCapacityStateUnsafe,
	releaseCapacityLease,
} from "../../src/domains/dispatch/capacity-lease.js";
import {
	createDispatchReservation,
	getDispatchReservation,
	releaseDispatchReservation,
	releaseDispatchReservationMember,
	rollbackDispatchReservation,
	transferDispatchReservationToLease,
} from "../../src/domains/dispatch/reservation-store.js";
import { registerForegroundStream } from "../../src/domains/providers/endpoint-capacity.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

let env: Awaited<ReturnType<typeof isolateClioEnv>>;
beforeEach(async () => {
	env = await isolateClioEnv("clio-reservation-waves-");
});
afterEach(() => env.restore());

const endpointKey = "http://127.0.0.1:8080";
const limits: CapacityLimits = { global: 1, nodes: { local: 1 }, endpoints: { [endpointKey]: 1 } };

function reserve(waves = [0, 1], cap = limits) {
	return createDispatchReservation({
		topology: "pipeline",
		tasks: waves.map((wave, index) => ({
			memberId: `task-${index + 1}`,
			wave,
			nodeId: "local",
			endpointKey,
			costUpperBoundUsd: 1,
		})),
		capacity: {
			global: { active: 0, limit: cap.global },
			nodes: { local: { active: 0, limit: cap.nodes.local ?? 1 } },
			endpoints: { [endpointKey]: { active: 0, limit: cap.endpoints[endpointKey] ?? 1 } },
			budget: { currentUsd: 0, ceilingUsd: 100 },
		},
	});
}

function transfer(ownerId: string, memberId: string, cap = limits) {
	return transferDispatchReservationToLease({
		ownerId,
		memberId,
		assignmentId: memberId,
		nodeId: "local",
		endpointKey,
		limits: cap,
	});
}

function durableBytes() {
	return readFileSync(capacityStateLockPath());
}

it("admits both pipeline waves at concurrency one without releasing the future reservation", () => {
	const reservation = reserve();
	const first = transfer(reservation.ownerId, "task-1");
	strictEqual(first.reservationOwnerId, reservation.ownerId);
	strictEqual(first.reservationMemberId, "task-1");
	strictEqual(readCapacityStateUnsafe().leases.length, 1);
	strictEqual(getDispatchReservation(reservation.ownerId)?.members[1]?.status, "held");
	releaseCapacityLease(first.leaseId);
	releaseDispatchReservationMember(reservation.ownerId, "task-1");
	const second = transfer(reservation.ownerId, "task-2");
	strictEqual(second.reservationMemberId, "task-2");
	releaseCapacityLease(second.leaseId);
	releaseDispatchReservation(reservation.ownerId);
	strictEqual(readCapacityStateUnsafe().leases.length, 0);
	strictEqual(getDispatchReservation(reservation.ownerId)?.status, "released");
});

for (const dimension of ["global", "node", "endpoint"] as const) {
	it(`does not charge its own future wave against the ${dimension} limit`, () => {
		const cap = { global: 4, nodes: { local: 4 }, endpoints: { [endpointKey]: 4 } };
		if (dimension === "global") cap.global = 1;
		else if (dimension === "node") cap.nodes.local = 1;
		else cap.endpoints[endpointKey] = 1;
		const reservation = reserve([0, 1], cap);
		const lease = transfer(reservation.ownerId, "task-1", cap);
		releaseCapacityLease(lease.leaseId);
		rollbackDispatchReservation(reservation.ownerId);
	});
}

it("keeps unreserved work blocked and failed transfer atomic", () => {
	const reservation = reserve();
	const before = durableBytes();
	throws(
		() => acquireCapacityLease({ assignmentId: "outsider", nodeId: "local", endpointKey, limits }),
		/capacity reached/,
	);
	throws(() => transfer(reservation.ownerId, "missing"), /is not held/);
	deepStrictEqual(durableBytes(), before);
});

for (const dimension of ["global", "node", "endpoint"] as const) {
	for (const holder of ["other owner", "same-wave peer"] as const) {
		it(`preserves ${holder} capacity at the ${dimension} limit`, () => {
			const cap = { global: 2, nodes: { local: 2 }, endpoints: { [endpointKey]: 2 } };
			const reservation = reserve(holder === "same-wave peer" ? [0, 0, 1, 1] : [0, 1], cap);
			if (holder === "other owner") reserve([0], cap);
			const constrained = structuredClone(cap);
			if (dimension === "global") constrained.global = 1;
			else if (dimension === "node") constrained.nodes.local = 1;
			else constrained.endpoints[endpointKey] = 1;
			const before = durableBytes();
			throws(() => transfer(reservation.ownerId, "task-1", constrained), /capacity reached/);
			deepStrictEqual(durableBytes(), before);
			const first = transfer(reservation.ownerId, "task-1", cap);
			if (holder === "same-wave peer") {
				const second = transfer(reservation.ownerId, "task-2", cap);
				strictEqual(readCapacityStateUnsafe().leases.length, 2);
				throws(() => transfer(reservation.ownerId, "task-3", cap), /capacity reached/);
				releaseCapacityLease(second.leaseId);
			}
			releaseCapacityLease(first.leaseId);
		});
	}
}

it("preserves foreground capacity and the reservation on failed transfer", () => {
	const reservation = reserve();
	const before = durableBytes();
	const release = registerForegroundStream(endpointKey);
	try {
		throws(() => transfer(reservation.ownerId, "task-1"), /capacity reached.*foreground stream/);
		deepStrictEqual(durableBytes(), before);
	} finally {
		release();
	}
	const lease = transfer(reservation.ownerId, "task-1");
	releaseCapacityLease(lease.leaseId);
});

it("keeps assignment retries on the same owned lease and holds the next wave until settlement", () => {
	const reservation = reserve();
	const first = transfer(reservation.ownerId, "task-1");
	// Production retries retain the assignment lease and omit the first-attempt transfer reference.
	const retry = acquireCapacityLease({ assignmentId: "task-1", nodeId: "local", endpointKey, limits });
	strictEqual(retry.leaseId, first.leaseId);
	strictEqual(retry.reservationOwnerId, reservation.ownerId);
	strictEqual(retry.reservationMemberId, "task-1");
	throws(() => transfer(reservation.ownerId, "task-2"), /capacity reached/);
	releaseCapacityLease(retry.leaseId);
	throws(
		() => acquireCapacityLease({ assignmentId: "outsider", nodeId: "local", endpointKey, limits }),
		/capacity reached/,
	);
	rollbackDispatchReservation(reservation.ownerId);
	const next = acquireCapacityLease({ assignmentId: "outsider", nodeId: "local", endpointKey, limits });
	releaseCapacityLease(next.leaseId);
	throws(() => transfer(reservation.ownerId, "task-2"), /is not active/);
});

it("admits two waves through the real bounded admission controller", { timeout: 5_000 }, async () => {
	const reservation = reserve();
	const controller = createCapacityAdmissionController({ limits: () => limits, queueCeilingMs: 100 });
	// The production queue timers are unref'd; keep this bounded source-only test alive.
	const keepAlive = setInterval(() => {}, 1_000);
	try {
		for (const memberId of ["task-1", "task-2"]) {
			const admitted = await controller.admit({
				assignmentId: memberId,
				nodeId: "local",
				endpointKey,
				deadlineAt: Date.now() + 1_000,
				reservation: { ownerId: reservation.ownerId, memberId },
			});
			strictEqual(admitted.lease.reservationMemberId, memberId);
			controller.release(admitted.lease.leaseId);
			releaseDispatchReservationMember(reservation.ownerId, memberId);
		}
		strictEqual(readCapacityStateUnsafe().leases.length, 0);
		strictEqual(getDispatchReservation(reservation.ownerId)?.status, "released");
	} finally {
		clearInterval(keepAlive);
		controller.stop();
	}
});

for (const dimension of ["global", "node", "endpoint"] as const) {
	it(`does not overlap pipeline waves above the ${dimension} limit`, () => {
		const cap = { global: 4, nodes: { local: 4 }, endpoints: { [endpointKey]: 4 } };
		if (dimension === "global") cap.global = 1;
		else if (dimension === "node") cap.nodes.local = 1;
		else cap.endpoints[endpointKey] = 1;
		const reservation = reserve([0, 1], cap);
		const first = transfer(reservation.ownerId, "task-1", cap);
		const before = durableBytes();
		throws(() => transfer(reservation.ownerId, "task-2", cap), new RegExp(`${dimension}.*capacity reached`));
		deepStrictEqual(durableBytes(), before);
		releaseCapacityLease(first.leaseId);
		const second = transfer(reservation.ownerId, "task-2", cap);
		releaseCapacityLease(second.leaseId);
	});
}

it("another owner still sees the future reserved peak after the current wave releases its lease", () => {
	const reservation = reserve();
	const first = transfer(reservation.ownerId, "task-1");
	releaseCapacityLease(first.leaseId);
	releaseDispatchReservationMember(reservation.ownerId, "task-1");
	const before = durableBytes();
	throws(() => reserve(), /global concurrency capacity exceeded/);
	throws(
		() => acquireCapacityLease({ assignmentId: "outsider", nodeId: "local", endpointKey, limits }),
		/capacity reached/,
	);
	deepStrictEqual(durableBytes(), before);
	strictEqual(getDispatchReservation(reservation.ownerId)?.members[1]?.status, "held");
});

for (const identity of ["missing owner", "missing member", "held member", "released member", "no reference"] as const) {
	it(`${identity} cannot obtain the reservation wave discount`, () => {
		const reservation = reserve();
		if (identity === "released member") releaseDispatchReservationMember(reservation.ownerId, "task-1");
		const before = durableBytes();
		throws(
			() =>
				acquireCapacityLease({
					assignmentId: "unvalidated",
					nodeId: "local",
					endpointKey,
					limits,
					...(identity === "no reference"
						? {}
						: {
								reservation: {
									ownerId: identity === "missing owner" ? "missing" : reservation.ownerId,
									memberId: identity === "missing member" ? "missing" : "task-1",
								},
							}),
				}),
			/capacity reached|requires a consumed reservation member/,
		);
		deepStrictEqual(durableBytes(), before);
	});
}

it("route-change retries use the stored lease reservation and still enforce destination capacity", () => {
	const cap = { global: 4, nodes: { local: 1, remote: 1 }, endpoints: { [endpointKey]: 1 } };
	const reservation = reserve([0, 1], cap);
	const first = transfer(reservation.ownerId, "task-1", cap);
	const blocker = acquireCapacityLease({ assignmentId: "remote-worker", nodeId: "remote", limits: cap });
	const retryInput = {
		assignmentId: "task-1",
		nodeId: "remote",
		endpointKey,
		limits: cap,
		reservation: { ownerId: "untrusted-request-owner", memberId: "untrusted-request-member" },
	};
	const before = durableBytes();
	throws(() => acquireCapacityLease(retryInput), /node 'remote' capacity reached/);
	deepStrictEqual(durableBytes(), before);
	releaseCapacityLease(blocker.leaseId);
	const retry = acquireCapacityLease(retryInput);
	strictEqual(retry.leaseId, first.leaseId);
	strictEqual(retry.nodeId, "remote");
	strictEqual(retry.reservationOwnerId, reservation.ownerId);
	strictEqual(retry.reservationMemberId, "task-1");
	strictEqual(getDispatchReservation(reservation.ownerId)?.members[1]?.status, "held");
	releaseCapacityLease(retry.leaseId);
});

it("an unreserved lease cannot borrow another owner's consumed member when changing route", () => {
	const cap = { global: 3, nodes: { local: 3, remote: 1 }, endpoints: { [endpointKey]: 3 } };
	const reservation = reserve([0, 1], cap);
	const first = transfer(reservation.ownerId, "task-1", cap);
	const outsider = acquireCapacityLease({ assignmentId: "outsider", nodeId: "local", limits: cap });
	releaseCapacityLease(first.leaseId);
	const before = durableBytes();
	throws(
		() =>
			acquireCapacityLease({
				assignmentId: "outsider",
				nodeId: "remote",
				limits: { ...cap, global: 1 },
				reservation: { ownerId: reservation.ownerId, memberId: "task-1" },
			}),
		/global capacity reached/,
	);
	deepStrictEqual(durableBytes(), before);
	releaseCapacityLease(outsider.leaseId);
});
