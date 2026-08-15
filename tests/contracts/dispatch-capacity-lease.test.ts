import { match, ok, strictEqual, throws } from "node:assert";
import { fork } from "node:child_process";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { FILE_LOCK_ACQUIRE_TIMEOUT_MS } from "../../src/core/state-file-lock.js";
import {
	acquireCapacityLease,
	capacityDrain,
	DEFAULT_CAPACITY_LEASE_TTL_MS,
	heartbeatCapacityLease,
	listCapacityLeases,
	MAX_CAPACITY_LEASES,
	processBirthToken,
	setCapacityDraining,
	writeCapacityStateUnsafe,
} from "../../src/domains/dispatch/capacity-lease.js";
import {
	createDispatchReservation,
	getDispatchReservation,
	listDispatchReservations,
	transferDispatchReservationToLease,
} from "../../src/domains/dispatch/reservation-store.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

// The state dir is memoized, so a bare env edit would silently leave every test
// in this file sharing one store. Reset the cache with the env.
let isolated: IsolatedClioEnv | null = null;
function home(): string {
	isolated = isolateClioEnv("clio-lease-");
	return isolated.dir;
}
afterEach(() => {
	isolated?.restore();
	isolated = null;
});
const limits = { global: 1, nodes: { local: 1, mini: 1 } };

describe("durable dispatch capacity leases", () => {
	it("two processes cannot acquire one capacity slot", async () => {
		home();
		const spawn = (id: string, startAtMs?: number) =>
			fork(
				join(process.cwd(), "tests/fixtures/capacity-lease-child.ts"),
				startAtMs === undefined ? [id] : [id, String(startAtMs)],
				{
					execArgv: ["--import", "tsx"],
					// The scratch CLIO_* dirs are already in this process's env.
					env: { ...process.env },
					stdio: ["ignore", "ignore", "ignore", "ipc"],
				},
			);
		const first = spawn("one");
		const firstMessage = await new Promise<{ ok: boolean }>((resolve) => first.once("message", resolve));
		strictEqual(firstMessage.ok, true);
		const second = spawn("two");
		const secondMessage = await new Promise<{ ok: boolean; message?: string }>((resolve) =>
			second.once("message", resolve),
		);
		strictEqual(secondMessage.ok, false);
		match(secondMessage.message ?? "", /capacity reached/);
		first.kill();
		second.kill();
	});
	it("concurrent processes racing one slot produce exactly one lease", async () => {
		home();
		const startAtMs = Date.now() + 1_500;
		const children = ["a", "b", "c", "d"].map((id) =>
			fork(join(process.cwd(), "tests/fixtures/capacity-lease-child.ts"), [id, String(startAtMs)], {
				execArgv: ["--import", "tsx"],
				env: { ...process.env },
				stdio: ["ignore", "ignore", "ignore", "ipc"],
			}),
		);
		try {
			const results = await Promise.all(
				children.map(
					(child) => new Promise<{ ok: boolean; message?: string }>((resolve) => child.once("message", resolve)),
				),
			);
			strictEqual(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
			for (const denied of results.filter((result) => !result.ok)) match(denied.message ?? "", /capacity reached/);
			strictEqual(listCapacityLeases().length, 1);
		} finally {
			for (const child of children) child.kill();
		}
	});
	it("plan reservation transfers atomically into an assignment lease", () => {
		home();
		const reservation = createDispatchReservation({
			topology: "parallel",
			tasks: [{ memberId: "step", wave: 0, nodeId: "local", costUpperBoundUsd: 1 }],
			capacity: {
				global: { active: 0, limit: 1 },
				nodes: { local: { active: 0, limit: 1 } },
				budget: { currentUsd: 0, ceilingUsd: 10 },
			},
		});
		const lease = transferDispatchReservationToLease({
			ownerId: reservation.ownerId,
			memberId: "step",
			assignmentId: "assignment",
			nodeId: "local",
			limits,
		});
		strictEqual(lease.assignmentId, "assignment");
		strictEqual(getDispatchReservation(reservation.ownerId)?.members[0]?.status, "consumed");
	});
	it("retry rebinds one lease instead of acquiring a second", () => {
		home();
		// The production retry path re-enters acquisition with the assignment id it
		// already holds, on whichever node the retry resolved.
		const first = acquireCapacityLease({ assignmentId: "a", nodeId: "local", limits });
		const second = acquireCapacityLease({ assignmentId: "a", nodeId: "mini", limits });
		strictEqual(second.leaseId, first.leaseId);
		strictEqual(listCapacityLeases().length, 1);
		strictEqual(listCapacityLeases()[0]?.nodeId, "mini");
	});
	it("live birth token prevents stale pid reuse reclamation", () => {
		home();
		const lease = acquireCapacityLease({
			assignmentId: "a",
			nodeId: "local",
			limits,
			nowMs: 10,
			ttlMs: 100,
			ownerPid: 42,
			processBirthToken: "birth",
			probe: { birthToken: () => "birth" },
		});
		heartbeatCapacityLease(lease.leaseId, 50, 100);
		strictEqual(listCapacityLeases({ nowMs: 149, probe: { birthToken: () => "birth" } }).length, 1);
	});
	it("a live owner keeps its lease through a lock stall longer than the ttl", () => {
		home();
		// Every admission mutation blocks the event loop waiting for the state
		// lock, so a holder stuck behind one also stops heartbeating. Forty-five
		// seconds of that used to put a 30s lease past expiry and hand the slot
		// to a second process while the first still believed it held one.
		const lease = acquireCapacityLease({
			assignmentId: "a",
			nodeId: "local",
			limits,
			nowMs: 0,
			ttlMs: 30_000,
			ownerPid: 42,
			processBirthToken: "birth",
			probe: { birthToken: () => "birth" },
		});
		const after = listCapacityLeases({ nowMs: 45_000, probe: { birthToken: () => "birth" } });
		strictEqual(after.length, 1);
		strictEqual(after[0]?.leaseId, lease.leaseId);
	});
	it("a dead owner is reclaimed even while its lease is unexpired", () => {
		home();
		acquireCapacityLease({
			assignmentId: "a",
			nodeId: "local",
			limits,
			nowMs: 0,
			ttlMs: 30_000,
			ownerPid: 42,
			processBirthToken: "birth",
			probe: { birthToken: () => "birth" },
		});
		strictEqual(listCapacityLeases({ nowMs: 1_000, probe: { birthToken: () => null } }).length, 0);
	});
	it("a lease from another host is never adjudicated, and a legacy host-less lease still is", () => {
		home();
		const at = new Date(0).toISOString();
		const lease = (leaseId: string, host?: string) => ({
			leaseId,
			assignmentId: leaseId,
			nodeId: "local",
			...(host === undefined ? {} : { host }),
			ownerPid: 42,
			processBirthToken: "birth",
			acquiredAt: at,
			expiresAt: new Date(10).toISOString(),
			heartbeatAt: at,
			reservationOwnerId: null,
			reservationMemberId: null,
		});
		writeCapacityStateUnsafe({
			version: 2,
			draining: null,
			reservations: [],
			leases: [lease("foreign", `${hostname()}-elsewhere`), lease("legacy"), lease("local", hostname())],
		});
		// The owner is dead and the lease expired by every local measure, but only
		// the records this host owns may be reclaimed on that evidence.
		const kept = listCapacityLeases({ nowMs: 1_000, probe: { birthToken: () => null } });
		strictEqual(kept.map((entry) => entry.leaseId).join(","), "foreign");
		strictEqual(
			acquireCapacityLease({ assignmentId: "mine", nodeId: "local", limits: { global: 2, nodes: {} } }).host,
			hostname(),
		);
	});
	it("the lock acquire budget stays under the lease ttl", () => {
		ok(
			FILE_LOCK_ACQUIRE_TIMEOUT_MS < DEFAULT_CAPACITY_LEASE_TTL_MS,
			`a caller may block ${FILE_LOCK_ACQUIRE_TIMEOUT_MS}ms on the admission lock, which must stay under the ${DEFAULT_CAPACITY_LEASE_TTL_MS}ms it holds a lease for`,
		);
	});
	it("dead and expired owners are reclaimed", () => {
		home();
		acquireCapacityLease({
			assignmentId: "a",
			nodeId: "local",
			limits,
			nowMs: 10,
			ttlMs: 10,
			ownerPid: 42,
			processBirthToken: "birth",
			probe: { birthToken: () => "birth" },
		});
		strictEqual(listCapacityLeases({ nowMs: 21, probe: { birthToken: () => null } }).length, 0);
	});
	it("draining rejects new leases and preserves running work", () => {
		home();
		acquireCapacityLease({ assignmentId: "a", nodeId: "local", limits });
		setCapacityDraining(true);
		strictEqual(listCapacityLeases().length, 1);
		let error: unknown;
		try {
			acquireCapacityLease({ assignmentId: "b", nodeId: "local", limits: { global: 2, nodes: { local: 2 } } });
		} catch (caught) {
			error = caught;
		}
		ok(error instanceof Error);
		match(error.message, /draining/);
	});
	it("draining rejects plan reservations before they hold capacity", () => {
		home();
		setCapacityDraining(true, { nowMs: 1_000, ttlMs: 10_000 });
		throws(
			() =>
				createDispatchReservation({
					topology: "parallel",
					tasks: [{ memberId: "step", wave: 0, nodeId: "local", costUpperBoundUsd: 1 }],
					capacity: {
						global: { active: 0, limit: 1 },
						nodes: { local: { active: 0, limit: 1 } },
						budget: { currentUsd: 0, ceilingUsd: 10 },
					},
					nowMs: 1_001,
				}),
			/capacity is draining/,
		);
		strictEqual(listDispatchReservations().length, 0);
		setCapacityDraining(false, { nowMs: 1_002 });
		strictEqual(
			createDispatchReservation({
				topology: "parallel",
				tasks: [{ memberId: "step", wave: 0, nodeId: "local", costUpperBoundUsd: 1 }],
				capacity: {
					global: { active: 0, limit: 1 },
					nodes: { local: { active: 0, limit: 1 } },
					budget: { currentUsd: 0, ceilingUsd: 10 },
				},
				nowMs: 1_003,
			}).status,
			"active",
		);
	});
	it("draining blocks a previously reserved member before lease transfer", () => {
		home();
		const reservation = createDispatchReservation({
			topology: "parallel",
			tasks: [{ memberId: "step", wave: 0, nodeId: "local", costUpperBoundUsd: 1 }],
			capacity: {
				global: { active: 0, limit: 1 },
				nodes: { local: { active: 0, limit: 1 } },
				budget: { currentUsd: 0, ceilingUsd: 10 },
			},
			nowMs: 1_000,
		});
		setCapacityDraining(true, { nowMs: 1_001, ttlMs: 10_000 });
		throws(
			() =>
				transferDispatchReservationToLease({
					ownerId: reservation.ownerId,
					memberId: "step",
					assignmentId: "assignment",
					nodeId: "local",
					limits,
					nowMs: 1_002,
				}),
			/capacity is draining/,
		);
		strictEqual(getDispatchReservation(reservation.ownerId)?.members[0]?.status, "held");
		strictEqual(listCapacityLeases({ nowMs: 1_002 }).length, 0);
	});
	it("an abandoned operator drain expires instead of wedging the machine", () => {
		home();
		const drain = setCapacityDraining(true, { nowMs: 1_000, ttlMs: 10 });
		strictEqual(drain?.requestedByPid, process.pid);
		strictEqual(capacityDrain(1_005)?.requestedByPid, process.pid);
		strictEqual(capacityDrain(1_011), null);
		const lease = acquireCapacityLease({ assignmentId: "a", nodeId: "local", limits, nowMs: 1_011 });
		strictEqual(lease.assignmentId, "a");
	});
	it("rejects a malformed durable drain instead of treating it as permanent", () => {
		home();
		writeCapacityStateUnsafe({
			version: 2,
			draining: {
				requestedByPid: process.pid,
				requestedAt: new Date(1_000).toISOString(),
				expiresAt: "not-a-timestamp",
			},
			leases: [],
			reservations: [],
		});
		throws(() => capacityDrain(), /invalid schema/);
	});
	it("an unsupported birth-token source falls back to owner liveness", () => {
		home();
		acquireCapacityLease({
			assignmentId: "a",
			nodeId: "local",
			limits,
			nowMs: 10,
			ttlMs: 100,
			ownerPid: 42,
			processBirthToken: "pid-42",
		});
		const synthetic = { birthToken: (pid: number) => `pid-${pid}`, tokenProvesDeath: false };
		strictEqual(listCapacityLeases({ nowMs: 20, probe: { ...synthetic, alive: () => true } }).length, 1);
		strictEqual(listCapacityLeases({ nowMs: 20, probe: { ...synthetic, alive: () => false } }).length, 0);
	});
	it("the lease bound fails admission closed instead of dropping a lease", () => {
		home();
		const at = new Date(1_000).toISOString();
		writeCapacityStateUnsafe({
			version: 2,
			draining: null,
			reservations: [],
			leases: Array.from({ length: MAX_CAPACITY_LEASES }, (_, index) => ({
				leaseId: `lease-${index}`,
				assignmentId: `assignment-${index}`,
				nodeId: "local",
				ownerPid: process.pid,
				processBirthToken: processBirthToken() ?? "unknown",
				acquiredAt: at,
				expiresAt: new Date(9_000_000).toISOString(),
				heartbeatAt: at,
				reservationOwnerId: null,
				reservationMemberId: null,
			})),
		});
		throws(
			() =>
				acquireCapacityLease({
					assignmentId: "overflow",
					nodeId: "local",
					limits: { global: MAX_CAPACITY_LEASES + 10, nodes: {} },
					nowMs: 2_000,
				}),
			/lease store is full/,
		);
		strictEqual(listCapacityLeases({ nowMs: 2_000 }).length, MAX_CAPACITY_LEASES);
	});
});
