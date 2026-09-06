import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { withStateFileLock } from "../../src/core/state-file-lock.js";
import {
	acquireCapacityLease,
	capacityLeaseUsage,
	capacityLeaseUsageAsync,
	capacityStateLockPath,
	readCapacityStateUnsafe,
	releaseCapacityLease,
	writeCapacityStateUnsafe,
} from "../../src/domains/dispatch/capacity-lease.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { transferDispatchReservationToLease } from "../../src/domains/dispatch/reservation-store.js";
import { registerForegroundStream } from "../../src/domains/providers/endpoint-capacity.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

beforeEach(() => isolateDispatchState());
afterEach(() => restoreDispatchState());

function holdCapacityLock() {
	let release!: () => void;
	const finished = withStateFileLock(
		capacityStateLockPath(),
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	ok(release, "the isolated fixture must acquire its own uncontended lock");
	return { release, finished };
}

async function retryFixture(
	options: { native?: boolean; previousNode?: string; maxWorkers?: number; beforeRebind?: () => void } = {},
) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.safety.autonomy = "full-auto";
	settings.integrations.externalAgents.entries = [
		{ id: "retry-fixture", command: "unused-fixture", args: [], toolGovernance: "clio-coder-policy" },
	];
	const budget = { currentUsd: 0, ceilingUsd: 5 };
	let starts = 0;
	const captureLaunch = (): never => {
		starts += 1;
		throw new Error("fixture reached worker launch");
	};
	const bundle = makeDispatchBundle(
		dispatchStubContext({
			settings,
			scheduling: {
				preflight: () => ({ verdict: "under", ...budget }),
				maxWorkers: () => options.maxWorkers ?? 4,
				checkCeiling: (usd) => (usd < budget.ceilingUsd ? "under" : usd === budget.ceilingUsd ? "at" : "over"),
			},
		}),
		{
			spawnWorker: captureLaunch,
			startAcpDelegationRun: captureLaunch,
			resolveNode: (req) => {
				if (req.lineage !== undefined) options.beforeRebind?.();
				return null;
			},
		},
	);
	await bundle.extension.start();
	const reservations = bundle.contract.reservations;
	ok(reservations);
	const request: DispatchRequest = {
		agentId: options.native ? "scout" : "retry-fixture",
		task: "Inspect the fixture input.",
		executionRole: "researcher",
	};
	const resolution = bundle.contract.preview?.(request);
	ok(resolution);
	const previousResolution = { ...resolution, node: { id: options.previousNode ?? "local", kind: "local" as const } };
	// Preparation is intentionally synchronous. Give the prior attempt a
	// cheaper bound so the retry must rebind even on the same node.
	const prepared = reservations.prepare({
		topology: "sequential",
		tasks: [
			{ memberId: "retry", wave: 0, resolution: { ...previousResolution, costUpperBoundUsd: 0.25 } },
			{ memberId: "later", wave: 1, resolution: previousResolution },
		],
	});
	const previous = transferDispatchReservationToLease({
		ownerId: prepared.ownerId,
		memberId: "retry",
		assignmentId: "retry-root",
		nodeId: previousResolution.node.id,
		limits: { global: 4, nodes: { local: 4 }, endpoints: {} },
	});
	strictEqual(previous.reservationOwnerId, prepared.ownerId);
	strictEqual(previous.reservationMemberId, "retry");
	releaseCapacityLease(previous.leaseId);
	const before = reservations.get(prepared.ownerId);
	ok(before);
	strictEqual(before.members[0]?.status, "consumed");
	return {
		bundle,
		reservations,
		before,
		budget,
		starts: () => starts,
		request: {
			...request,
			reservation: { ownerId: prepared.ownerId, memberId: "retry" },
			lineage: { rootRunId: "retry-root", parentRunId: "retry-root", attempt: 1, depth: 0 },
		} satisfies DispatchRequest,
	};
}

it("retry admission yields to an independent callback while the capacity lock is held", {
	timeout: 30_000,
}, async (t) => {
	const fixture = await retryFixture();
	const lock = holdCapacityLock();
	let callbackRan = false;
	const callback = new Promise<"callback">((resolve) => {
		setImmediate(() => {
			callbackRan = true;
			resolve("callback");
		});
	});
	const startedAt = performance.now();
	const pending = fixture.bundle.contract.dispatch(fixture.request).then(
		() => new Error("fixture unexpectedly launched a worker"),
		(error: unknown) => error,
	);
	try {
		const first = await Promise.race([callback, pending.then(() => "admission")]);
		t.diagnostic(`first=${first}; callbackRan=${callbackRan}; elapsedMs=${Math.round(performance.now() - startedAt)}`);
		if (first === "admission") t.diagnostic(String(await pending));
		strictEqual(first, "callback", "retry lock contention must not prevent an independent callback from executing");
		strictEqual(fixture.starts(), 0, "the worker cannot launch while retry admission waits");
		ok(existsSync(`${capacityStateLockPath()}.lock`), "the fixture still owns the capacity lock");
		lock.release();
		await lock.finished;
		const outcome = await pending;
		ok(outcome instanceof Error);
		strictEqual(outcome.message, "fixture reached worker launch");
		strictEqual(fixture.starts(), 1);
		const after = fixture.reservations.get(fixture.before.ownerId);
		deepStrictEqual(
			after,
			{
				...fixture.before,
				members: fixture.before.members.map((member) =>
					member.memberId === "retry" ? { ...member, costUpperBoundUsd: 1 } : member,
				),
			},
			"rebind preserves the owner, member order, consumption timestamps, and the later wave",
		);
	} finally {
		lock.release();
		await lock.finished;
		await pending;
		await callback;
		await fixture.bundle.extension.stop?.();
	}
});

it("native retry admission reads occupancy changed under the held lock and preserves the denied reservation", {
	timeout: 30_000,
}, async (t) => {
	let lock: ReturnType<typeof holdCapacityLock> | undefined;
	let callbackRan = false;
	let scheduleCallback!: () => void;
	const callback = new Promise<"callback">((resolve) => {
		scheduleCallback = () =>
			setImmediate(() => {
				callbackRan = true;
				resolve("callback");
			});
	});
	const fixture = await retryFixture({
		native: true,
		previousNode: "previous",
		maxWorkers: 1,
		// Native dispatch has earlier synchronous admission checks. Take the
		// lock at its existing placement seam, immediately before retry rebind.
		beforeRebind: () => {
			lock = holdCapacityLock();
			scheduleCallback();
		},
	});
	const blocker = acquireCapacityLease({
		assignmentId: "independent-worker",
		nodeId: "previous",
		limits: { global: 4, nodes: {}, endpoints: {} },
	});
	strictEqual(capacityLeaseUsage().nodes.local ?? 0, 0);
	const pending = fixture.bundle.contract.dispatch(fixture.request).catch((error: unknown) => error);
	try {
		const first = await Promise.race([callback, pending.then(() => "admission")]);
		t.diagnostic(`native first=${first}; callbackRan=${callbackRan}`);
		if (first === "admission") t.diagnostic(String(await pending));
		strictEqual(first, "callback");
		ok(lock);
		strictEqual(fixture.starts(), 0);
		// A competing holder moves its lease while the retry is waiting. Only
		// the fixture that owns the lock may use these unsafe transaction APIs.
		const state = readCapacityStateUnsafe();
		const lease = state.leases.find((entry) => entry.leaseId === blocker.leaseId);
		ok(lease);
		lease.nodeId = "local";
		writeCapacityStateUnsafe(state);
		lock.release();
		await lock.finished;
		const outcome = await pending;
		ok(outcome instanceof Error);
		match(outcome.message, /reservation rebind denied: node 'local' capacity exceeded \(2\/1\)/u);
		strictEqual(fixture.starts(), 0);
		deepStrictEqual(fixture.reservations.get(fixture.before.ownerId), fixture.before);
		strictEqual(capacityLeaseUsage().nodes.local, 1);
	} finally {
		lock?.release();
		await lock?.finished;
		await pending;
		releaseCapacityLease(blocker.leaseId);
		await fixture.bundle.extension.stop?.();
	}
});

it("retry rebind records its new estimate despite advisory session spend", {
	timeout: 30_000,
}, async () => {
	const fixture = await retryFixture();
	const lock = holdCapacityLock();
	const pending = fixture.bundle.contract.dispatch(fixture.request).catch((error: unknown) => error);
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		fixture.budget.currentUsd = 3.2;
		lock.release();
		await lock.finished;
		const outcome = await pending;
		ok(outcome instanceof Error);
		match(outcome.message, /fixture reached worker launch/u);
		strictEqual(fixture.starts(), 1);
		strictEqual(
			fixture.reservations.get(fixture.before.ownerId)?.members.find((member) => member.memberId === "retry")
				?.costUpperBoundUsd,
			1,
		);
	} finally {
		lock.release();
		await lock.finished;
		await pending;
		await fixture.bundle.extension.stop?.();
	}
});

for (const released of ["owner", "member"] as const) {
	it(`retry rebind does not revive a ${released} released during the capacity wait`, { timeout: 30_000 }, async () => {
		const fixture = await retryFixture();
		const lock = holdCapacityLock();
		const pending = fixture.bundle.contract.dispatch(fixture.request).catch((error: unknown) => error);
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			const state = readCapacityStateUnsafe();
			const record = structuredClone(fixture.before);
			if (released === "owner") record.status = "rolled_back";
			else {
				const member = record.members[0];
				ok(member);
				member.status = "released";
				member.releasedAt = new Date().toISOString();
			}
			state.reservations = [record];
			writeCapacityStateUnsafe(state);
			lock.release();
			await lock.finished;
			const outcome = await pending;
			ok(outcome instanceof Error);
			match(outcome.message, released === "owner" ? /is not active/u : /member 'retry' was already released/u);
			strictEqual(fixture.starts(), 0);
			deepStrictEqual(fixture.reservations.get(fixture.before.ownerId), record);
		} finally {
			lock.release();
			await lock.finished;
			await pending;
			await fixture.bundle.extension.stop?.();
		}
	});
}

it("sync and async lease usage share reclamation and foreground endpoint accounting", async () => {
	const endpoint = "http://127.0.0.1:1234/v1";
	const foreground = registerForegroundStream(endpoint);
	const lease = acquireCapacityLease({
		assignmentId: "live-worker",
		nodeId: "local",
		endpointKey: endpoint,
		limits: { global: 4, nodes: { local: 4 }, endpoints: { [endpoint]: 4 } },
	});
	try {
		const expected = {
			global: 1,
			nodes: { local: 1 },
			endpoints: { [endpoint]: 2 },
			endpointHolders: { [endpoint]: { leases: 1, reservations: 0, foregroundStreams: 1 } },
		};
		deepStrictEqual(capacityLeaseUsage(), expected);
		deepStrictEqual(await capacityLeaseUsageAsync(), expected);
		const reclaimed = await capacityLeaseUsageAsync({ probe: { birthToken: () => null } });
		deepStrictEqual(reclaimed, {
			global: 0,
			nodes: {},
			endpoints: { [endpoint]: 1 },
			endpointHolders: { [endpoint]: { leases: 0, reservations: 0, foregroundStreams: 1 } },
		});
		deepStrictEqual(capacityLeaseUsage(), reclaimed, "the async reclamation was persisted");
	} finally {
		foreground();
		releaseCapacityLease(lease.leaseId);
	}
});
