import { match, ok, strictEqual } from "node:assert";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	acquireCapacityLease,
	heartbeatCapacityLease,
	listCapacityLeases,
	rebindCapacityLease,
	setCapacityDraining,
} from "../../src/domains/dispatch/capacity-lease.js";
import {
	createDispatchReservation,
	getDispatchReservation,
	transferDispatchReservationToLease,
} from "../../src/domains/dispatch/reservation-store.js";

const homes: string[] = [];
function home(): string {
	const value = mkdtempSync(join(tmpdir(), "clio-lease-"));
	homes.push(value);
	process.env.HOME = value;
	process.env.XDG_STATE_HOME = join(value, "state");
	return value;
}
afterEach(() => {
	for (const value of homes.splice(0)) rmSync(value, { recursive: true, force: true });
	delete process.env.XDG_STATE_HOME;
});
const limits = { global: 1, nodes: { local: 1, mini: 1 } };

describe("durable dispatch capacity leases", () => {
	it("two processes cannot acquire one capacity slot", async () => {
		const scratch = home();
		const spawn = (id: string) =>
			fork(join(process.cwd(), "tests/fixtures/capacity-lease-child.ts"), [id], {
				execArgv: ["--import", "tsx"],
				env: { ...process.env, HOME: scratch, XDG_STATE_HOME: join(scratch, "state") },
				stdio: ["ignore", "ignore", "ignore", "ipc"],
			});
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
		acquireCapacityLease({ assignmentId: "a", nodeId: "local", limits });
		rebindCapacityLease("a", "mini", limits);
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
});
