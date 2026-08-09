import { randomBytes } from "node:crypto";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import {
	acquireCapacityLease,
	type CapacityLease,
	type CapacityLimits,
	capacityStateLockPath,
	readCapacityStateUnsafe,
	writeCapacityStateUnsafe,
} from "./capacity-lease.js";

const MAX_RESERVATION_RECORDS = 500;
export const DEFAULT_RESERVATION_TTL_MS = 15 * 60_000;

export type ReservationTopology = "parallel" | "detached" | "sequential" | "pipeline" | "review" | "compete";
export type ReservationMemberStatus = "held" | "consumed" | "released";
export type ReservationStatus = "active" | "released" | "rolled_back" | "expired";

/**
 * A reservation holds three scarce things and nothing else: a global
 * concurrency slot, a per-node slot, and a budget upper bound. Node identity
 * matters only because slots are per-node. Agent, target, model, and runtime
 * identity are route identity, which the failover envelope owns
 * (`assertRouteWithinApprovedEnvelope`); pinning them here made a
 * plan-approved dispatch unable to fail over at all.
 */
export interface ReservationPlanTask {
	memberId: string;
	wave: number;
	nodeId: string;
	costUpperBoundUsd: number;
}

export interface ReservationMember extends ReservationPlanTask {
	status: ReservationMemberStatus;
	consumedAt: string | null;
	releasedAt: string | null;
}

export interface DispatchReservationRecord {
	ownerId: string;
	/** Process that owns execution; startup cleanup preserves live sibling processes. */
	ownerPid: number;
	topology: ReservationTopology;
	status: ReservationStatus;
	createdAt: string;
	expiresAt: string;
	settledAt: string | null;
	members: ReservationMember[];
}

export interface ReservationCapacitySnapshot {
	global: { active: number; limit: number };
	nodes: Readonly<Record<string, { active: number; limit: number }>>;
	budget: { currentUsd: number; ceilingUsd: number };
}

export interface ReservationAllocation {
	globalSlots: number;
	nodeSlots: Readonly<Record<string, number>>;
	budgetUsd: number;
}

export type ReservationPlanResult = { ok: true; allocation: ReservationAllocation } | { ok: false; reason: string };

function copyRecord(record: DispatchReservationRecord): DispatchReservationRecord {
	return { ...record, members: record.members.map((member) => ({ ...member })) };
}

function validRecord(value: unknown): value is DispatchReservationRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<DispatchReservationRecord>;
	return (
		typeof record.ownerId === "string" &&
		typeof record.ownerPid === "number" &&
		Number.isInteger(record.ownerPid) &&
		record.ownerPid > 0 &&
		(record.topology === "parallel" ||
			record.topology === "detached" ||
			record.topology === "sequential" ||
			record.topology === "pipeline" ||
			record.topology === "review" ||
			record.topology === "compete") &&
		(record.status === "active" ||
			record.status === "released" ||
			record.status === "rolled_back" ||
			record.status === "expired") &&
		typeof record.createdAt === "string" &&
		typeof record.expiresAt === "string" &&
		(record.settledAt === null || typeof record.settledAt === "string") &&
		Array.isArray(record.members) &&
		record.members.every(
			(member) =>
				typeof member.memberId === "string" &&
				Number.isInteger(member.wave) &&
				typeof member.nodeId === "string" &&
				typeof member.costUpperBoundUsd === "number" &&
				Number.isFinite(member.costUpperBoundUsd) &&
				member.costUpperBoundUsd >= 0 &&
				(member.status === "held" || member.status === "consumed" || member.status === "released") &&
				(member.consumedAt === null || typeof member.consumedAt === "string") &&
				(member.releasedAt === null || typeof member.releasedAt === "string"),
		)
	);
}

function parseReservations(values: ReadonlyArray<unknown>): DispatchReservationRecord[] {
	if (!values.every(validRecord)) throw new Error("dispatch admission store has invalid reservation records");
	return values.map((record) => copyRecord(record));
}

function readStore(): DispatchReservationRecord[] {
	return parseReservations(readCapacityStateUnsafe().reservations);
}

function writeStore(records: ReadonlyArray<DispatchReservationRecord>): void {
	const state = readCapacityStateUnsafe();
	state.reservations = records.slice(0, MAX_RESERVATION_RECORDS).map(copyRecord);
	writeCapacityStateUnsafe(state);
}

function peakBy(tasks: ReadonlyArray<Pick<ReservationPlanTask, "wave"> & { key: string }>): Record<string, number> {
	const byKeyWave = new Map<string, Map<number, number>>();
	for (const task of tasks) {
		const waves = byKeyWave.get(task.key) ?? new Map<number, number>();
		waves.set(task.wave, (waves.get(task.wave) ?? 0) + 1);
		byKeyWave.set(task.key, waves);
	}
	const result: Record<string, number> = {};
	for (const [key, waves] of byKeyWave) result[key] = Math.max(0, ...waves.values());
	return result;
}

function reservationAllocation(tasks: ReadonlyArray<ReservationPlanTask>): ReservationAllocation {
	const globalSlots = Math.max(
		0,
		...Array.from(new Set(tasks.map((task) => task.wave))).map(
			(wave) => tasks.filter((task) => task.wave === wave).length,
		),
	);
	const nodeSlots = peakBy(tasks.map((task) => ({ wave: task.wave, key: task.nodeId })));
	return {
		globalSlots,
		nodeSlots,
		budgetUsd: tasks.reduce((sum, task) => sum + task.costUpperBoundUsd, 0),
	};
}

function outstandingTasks(record: DispatchReservationRecord): ReservationPlanTask[] {
	return record.members
		.filter((member) => member.status === "held")
		.map(({ status: _status, consumedAt: _consumedAt, releasedAt: _releasedAt, ...task }) => task);
}

function outstandingBudget(record: DispatchReservationRecord): number {
	return record.members
		.filter((member) => member.status === "held" || member.status === "consumed")
		.reduce((sum, member) => sum + member.costUpperBoundUsd, 0);
}

function allocateReservation(
	tasks: ReadonlyArray<ReservationPlanTask>,
	existing: ReadonlyArray<DispatchReservationRecord>,
	capacity: ReservationCapacitySnapshot,
): ReservationPlanResult {
	if (tasks.length === 0) return { ok: false, reason: "reservation requires at least one task" };
	const duplicate = tasks.find((task, index) => tasks.slice(0, index).some((entry) => entry.memberId === task.memberId));
	if (duplicate) return { ok: false, reason: `duplicate reservation member '${duplicate.memberId}'` };
	const requested = reservationAllocation(tasks);
	const activeRecords = existing.filter((record) => record.status === "active");
	const held = activeRecords.map((record) => reservationAllocation(outstandingTasks(record)));
	const globalUsed = capacity.global.active + held.reduce((sum, allocation) => sum + allocation.globalSlots, 0);
	if (globalUsed + requested.globalSlots > capacity.global.limit) {
		return {
			ok: false,
			reason: `global concurrency capacity exceeded (${globalUsed + requested.globalSlots}/${capacity.global.limit})`,
		};
	}
	for (const [nodeId, slots] of Object.entries(requested.nodeSlots)) {
		const node = capacity.nodes[nodeId];
		if (!node || !Number.isFinite(node.limit)) continue;
		const heldSlots = held.reduce((sum, allocation) => sum + (allocation.nodeSlots[nodeId] ?? 0), 0);
		const used = node.active + heldSlots;
		if (used + slots > node.limit) {
			return { ok: false, reason: `node '${nodeId}' capacity exceeded (${used + slots}/${node.limit})` };
		}
	}
	const existingBudget = activeRecords.reduce((sum, record) => sum + outstandingBudget(record), 0);
	const projected = capacity.budget.currentUsd + existingBudget + requested.budgetUsd;
	if (projected >= capacity.budget.ceilingUsd) {
		return {
			ok: false,
			reason: `aggregate budget exceeded ($${projected.toFixed(4)} / $${capacity.budget.ceilingUsd.toFixed(4)}; batch upper bound $${requested.budgetUsd.toFixed(4)})`,
		};
	}
	return { ok: true, allocation: requested };
}

export function createDispatchReservation(input: {
	topology: ReservationTopology;
	tasks: ReadonlyArray<ReservationPlanTask>;
	capacity: ReservationCapacitySnapshot;
	nowMs?: number;
	ttlMs?: number;
}): DispatchReservationRecord {
	return withStateFileLockSync(capacityStateLockPath(), () => {
		const nowMs = input.nowMs ?? Date.now();
		const records = expireRecords(readStore(), nowMs, false);
		const planned = allocateReservation(input.tasks, records, input.capacity);
		if (!planned.ok) {
			writeStore(records);
			throw new Error(`dispatch: reservation denied: ${planned.reason}`);
		}
		const createdAt = new Date(nowMs).toISOString();
		const record: DispatchReservationRecord = {
			ownerId: `plan-${nowMs.toString(36)}-${randomBytes(6).toString("hex")}`,
			ownerPid: process.pid,
			topology: input.topology,
			status: "active",
			createdAt,
			expiresAt: new Date(nowMs + (input.ttlMs ?? DEFAULT_RESERVATION_TTL_MS)).toISOString(),
			settledAt: null,
			members: input.tasks.map((task) => ({ ...task, status: "held", consumedAt: null, releasedAt: null })),
		};
		writeStore([record, ...records]);
		return copyRecord(record);
	});
}

/** Atomically convert one held plan member into the assignment's durable lease. */
export function transferDispatchReservationToLease(input: {
	ownerId: string;
	memberId: string;
	assignmentId: string;
	nodeId: string;
	limits: CapacityLimits;
	nowMs?: number;
	ttlMs?: number;
}): CapacityLease {
	const nowMs = input.nowMs ?? Date.now();
	return acquireCapacityLease({
		assignmentId: input.assignmentId,
		nodeId: input.nodeId,
		limits: input.limits,
		nowMs,
		...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
		reservation: { ownerId: input.ownerId, memberId: input.memberId },
		onAcquiredUnderLock: (state) => {
			const records = expireRecords(parseReservations(state.reservations), nowMs, false);
			const record = records.find((entry) => entry.ownerId === input.ownerId);
			if (record?.status !== "active") throw new Error(`dispatch: reservation '${input.ownerId}' is not active`);
			const member = record.members.find((entry) => entry.memberId === input.memberId);
			if (member?.status !== "held") throw new Error(`dispatch: reservation member '${input.memberId}' is not held`);
			member.status = "consumed";
			member.consumedAt = new Date(nowMs).toISOString();
			state.reservations = records.map(copyRecord);
		},
	});
}

/**
 * Move a member's held capacity to the node a retry actually resolved, and
 * re-check the aggregate budget against the retry's own estimate. The durable
 * lease moves the capacity slot on a retry, but nothing else re-checks money, so
 * a retry that resolves a costlier route would otherwise run outside what the
 * plan reserved. Atomic under
 * the state-file lock: the old node's slot is released and the new one acquired
 * in a single write, so a concurrent plan can never observe both held. Fails
 * closed with a named reason, which the caller surfaces as an admission denial
 * rather than letting the attempt escape its reservation.
 */
export function rebindDispatchReservationMember(input: {
	ownerId: string;
	memberId: string;
	nodeId: string;
	costUpperBoundUsd: number;
	capacity: ReservationCapacitySnapshot;
	nowMs?: number;
}): DispatchReservationRecord {
	return withStateFileLockSync(capacityStateLockPath(), () => {
		const nowMs = input.nowMs ?? Date.now();
		const records = expireRecords(readStore(), nowMs, false);
		const record = records.find((entry) => entry.ownerId === input.ownerId);
		if (record?.status !== "active") throw new Error(`dispatch: reservation '${input.ownerId}' is not active`);
		const member = record.members.find((entry) => entry.memberId === input.memberId);
		if (!member) throw new Error(`dispatch: reservation '${input.ownerId}' has no member '${input.memberId}'`);
		if (member.status === "released") {
			throw new Error(`dispatch: reservation member '${input.memberId}' was already released`);
		}
		if (member.nodeId === input.nodeId && member.costUpperBoundUsd === input.costUpperBoundUsd) {
			return copyRecord(record);
		}

		const others = records.filter((entry) => entry.status === "active" && entry.ownerId !== input.ownerId);
		if (member.nodeId !== input.nodeId) {
			const node = input.capacity.nodes[input.nodeId];
			if (node !== undefined && Number.isFinite(node.limit)) {
				// Siblings inside this same reservation still hold their own slots.
				const siblingSlots = record.members.filter(
					(entry) => entry !== member && entry.status !== "released" && entry.nodeId === input.nodeId,
				).length;
				const otherHeld = others.reduce(
					(sum, entry) => sum + (reservationAllocation(outstandingTasks(entry)).nodeSlots[input.nodeId] ?? 0),
					0,
				);
				const used = node.active + otherHeld + siblingSlots;
				if (used + 1 > node.limit) {
					throw new Error(
						`dispatch: reservation rebind denied: node '${input.nodeId}' capacity exceeded (${used + 1}/${node.limit})`,
					);
				}
			}
		}

		const otherBudget = others.reduce((sum, entry) => sum + outstandingBudget(entry), 0);
		const siblingBudget = record.members
			.filter((entry) => entry !== member && (entry.status === "held" || entry.status === "consumed"))
			.reduce((sum, entry) => sum + entry.costUpperBoundUsd, 0);
		const projected =
			input.capacity.budget.currentUsd + otherBudget + siblingBudget + Math.max(0, input.costUpperBoundUsd);
		if (projected >= input.capacity.budget.ceilingUsd) {
			throw new Error(
				`dispatch: reservation rebind denied: aggregate budget exceeded ($${projected.toFixed(4)} / $${input.capacity.budget.ceilingUsd.toFixed(4)})`,
			);
		}

		member.nodeId = input.nodeId;
		member.costUpperBoundUsd = Math.max(0, input.costUpperBoundUsd);
		writeStore(records);
		return copyRecord(record);
	});
}

export function releaseDispatchReservationMember(
	ownerId: string,
	memberId: string,
	nowMs = Date.now(),
): DispatchReservationRecord | null {
	return withStateFileLockSync(capacityStateLockPath(), () => {
		const records = readStore();
		const record = records.find((entry) => entry.ownerId === ownerId);
		if (!record) return null;
		const member = record.members.find((entry) => entry.memberId === memberId);
		if (record.status !== "active" || !member || member.status === "released") return copyRecord(record);
		member.status = "released";
		member.releasedAt = new Date(nowMs).toISOString();
		if (record.members.every((entry) => entry.status === "released")) {
			record.status = "released";
			record.settledAt = new Date(nowMs).toISOString();
		}
		writeStore(records);
		return copyRecord(record);
	});
}

export function rollbackDispatchReservation(ownerId: string, nowMs = Date.now()): DispatchReservationRecord | null {
	return withStateFileLockSync(capacityStateLockPath(), () => {
		const records = readStore();
		const record = records.find((entry) => entry.ownerId === ownerId);
		if (!record) return null;
		if (record.status !== "active") return copyRecord(record);
		const settledAt = new Date(nowMs).toISOString();
		for (const member of record.members) {
			if (member.status === "released") continue;
			member.status = "released";
			member.releasedAt = settledAt;
		}
		record.status = "rolled_back";
		record.settledAt = settledAt;
		writeStore(records);
		return copyRecord(record);
	});
}

/** Release a denied/unexecuted plan without disturbing a plan that has begun execution. */
export function rollbackUnconsumedDispatchReservation(
	ownerId: string,
	nowMs = Date.now(),
): DispatchReservationRecord | null {
	const record = getDispatchReservation(ownerId);
	if (record?.status !== "active") return record;
	if (record.members.some((member) => member.status === "consumed")) return record;
	return rollbackDispatchReservation(ownerId, nowMs);
}

function reservationOwnerAlive(ownerPid: number | undefined): boolean {
	if (ownerPid === undefined || ownerPid === process.pid) return false;
	try {
		process.kill(ownerPid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function expireRecords(
	records: DispatchReservationRecord[],
	nowMs: number,
	startup: boolean,
): DispatchReservationRecord[] {
	const settledAt = new Date(nowMs).toISOString();
	for (const record of records) {
		if (record.status !== "active") continue;
		if (startup ? reservationOwnerAlive(record.ownerPid) : Date.parse(record.expiresAt) > nowMs) continue;
		for (const member of record.members) {
			if (member.status === "released") continue;
			member.status = "released";
			member.releasedAt = settledAt;
		}
		record.status = "expired";
		record.settledAt = settledAt;
	}
	return records;
}

export function cleanupDispatchReservations(options?: { startup?: boolean; nowMs?: number }): number {
	return withStateFileLockSync(capacityStateLockPath(), () => {
		const records = readStore();
		const before = records.filter((record) => record.status === "active").length;
		expireRecords(records, options?.nowMs ?? Date.now(), options?.startup === true);
		const after = records.filter((record) => record.status === "active").length;
		if (before !== after) writeStore(records);
		return before - after;
	});
}

/**
 * The concurrent peak a plan reserved, which is the widest wave it was admitted
 * against. Members settle as the plan runs, but the bound does not move.
 */
export function reservedPlanPeakSlots(ownerId: string, onError?: (error: unknown) => void): number | undefined {
	try {
		const record = getDispatchReservation(ownerId);
		if (record === null || record.status !== "active") return undefined;
		return reservationAllocation(record.members).globalSlots;
	} catch (error) {
		// An unreadable store cannot bound a plan; capacity still bounds admission.
		onError?.(error);
		return undefined;
	}
}

/** Queue identity for a reserved member: its plan, ordered by reserved wave. */
export function planQueueSlot(
	ownerId: string,
	memberId: string,
	onError?: (error: unknown) => void,
): { planId: string; planOrder?: number } {
	try {
		const wave = getDispatchReservation(ownerId)?.members.find((member) => member.memberId === memberId)?.wave;
		return { planId: ownerId, ...(wave !== undefined ? { planOrder: wave } : {}) };
	} catch (error) {
		// Plan identity still holds without wave order; ordering falls back to FIFO.
		onError?.(error);
		return { planId: ownerId };
	}
}

export function getDispatchReservation(ownerId: string): DispatchReservationRecord | null {
	const record = readStore().find((entry) => entry.ownerId === ownerId);
	return record ? copyRecord(record) : null;
}

export function listDispatchReservations(): ReadonlyArray<DispatchReservationRecord> {
	return readStore();
}

export function reservedBudgetUsd(): number {
	return readStore()
		.filter((record) => record.status === "active")
		.reduce((sum, record) => sum + outstandingBudget(record), 0);
}

export function reservedCapacity(): { globalSlots: number; nodeSlots: Readonly<Record<string, number>> } {
	let globalSlots = 0;
	const nodeSlots: Record<string, number> = {};
	for (const record of readStore().filter((entry) => entry.status === "active")) {
		const allocation = reservationAllocation(outstandingTasks(record));
		globalSlots += allocation.globalSlots;
		for (const [nodeId, count] of Object.entries(allocation.nodeSlots))
			nodeSlots[nodeId] = (nodeSlots[nodeId] ?? 0) + count;
	}
	return { globalSlots, nodeSlots };
}
