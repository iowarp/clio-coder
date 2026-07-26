import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { clioStateDir } from "../../core/xdg.js";
import { atomicWrite } from "../../engine/session.js";

const MAX_LEASES = 1_000;
export const DEFAULT_CAPACITY_LEASE_TTL_MS = 30_000;

export interface CapacityLease {
	leaseId: string;
	assignmentId: string;
	nodeId: string;
	ownerPid: number;
	processBirthToken: string;
	acquiredAt: string;
	expiresAt: string;
	heartbeatAt: string;
	reservationOwnerId: string | null;
	reservationMemberId: string | null;
}
export interface CapacityLimits {
	global: number;
	nodes: Readonly<Record<string, number>>;
}
export interface CapacityStateFile {
	version: 1;
	draining: boolean;
	leases: CapacityLease[];
	/** Strictly validated and interpreted only by reservation-store.ts. */
	reservations: unknown[];
}
export interface LeaseOwnerProbe {
	birthToken(pid: number): string | null;
}

export function capacityStatePath(): string {
	return join(clioStateDir(), "dispatch-admission.json");
}
/** The admission state file itself keys the one cross-process transaction lock. */
export function capacityStateLockPath(): string {
	return capacityStatePath();
}
function clone(lease: CapacityLease): CapacityLease {
	return { ...lease };
}
function valid(value: unknown): value is CapacityLease {
	if (typeof value !== "object" || value === null) return false;
	const lease = value as Partial<CapacityLease>;
	return (
		typeof lease.leaseId === "string" &&
		typeof lease.assignmentId === "string" &&
		typeof lease.nodeId === "string" &&
		Number.isInteger(lease.ownerPid) &&
		typeof lease.processBirthToken === "string" &&
		typeof lease.acquiredAt === "string" &&
		typeof lease.expiresAt === "string" &&
		typeof lease.heartbeatAt === "string" &&
		(lease.reservationOwnerId === null || typeof lease.reservationOwnerId === "string") &&
		(lease.reservationMemberId === null || typeof lease.reservationMemberId === "string")
	);
}
export function readCapacityStateUnsafe(): CapacityStateFile {
	if (!existsSync(capacityStatePath())) return { version: 1, draining: false, leases: [], reservations: [] };
	let parsed: CapacityStateFile;
	try {
		parsed = JSON.parse(readFileSync(capacityStatePath(), "utf8")) as CapacityStateFile;
	} catch (error) {
		throw new Error(`dispatch capacity store is unreadable: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (
		parsed?.version !== 1 ||
		typeof parsed.draining !== "boolean" ||
		!Array.isArray(parsed.leases) ||
		!parsed.leases.every(valid) ||
		!Array.isArray(parsed.reservations)
	)
		throw new Error("dispatch capacity store has an invalid schema");
	return { ...parsed, leases: parsed.leases.map(clone), reservations: structuredClone(parsed.reservations) };
}
export function writeCapacityStateUnsafe(file: CapacityStateFile): void {
	atomicWrite(
		capacityStatePath(),
		JSON.stringify({ ...file, leases: file.leases.slice(0, MAX_LEASES), reservations: file.reservations }, null, 2),
	);
}

export function processBirthToken(pid = process.pid): string | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(")");
		const fields = stat.slice(close + 2).split(" ");
		return fields[19] ?? null; // field 22; slice begins at field 3
	} catch {
		return pid === process.pid ? `pid-${pid}` : null;
	}
}
const defaultProbe: LeaseOwnerProbe = { birthToken: processBirthToken };
function reclaim(file: CapacityStateFile, nowMs: number, probe: LeaseOwnerProbe): void {
	file.leases = file.leases.filter((lease) => {
		const current = probe.birthToken(lease.ownerPid);
		if (current === lease.processBirthToken && Date.parse(lease.expiresAt) > nowMs) return true;
		return false;
	});
}
function heldReservationUsage(values: ReadonlyArray<unknown>): { global: number; nodes: Record<string, number> } {
	let global = 0;
	const nodes: Record<string, number> = {};
	for (const value of values) {
		if (typeof value !== "object" || value === null) continue;
		const record = value as { status?: unknown; members?: unknown };
		if (record.status !== "active" || !Array.isArray(record.members)) continue;
		const byWave = new Map<number, number>();
		const byNodeWave = new Map<string, Map<number, number>>();
		for (const raw of record.members) {
			if (typeof raw !== "object" || raw === null) continue;
			const member = raw as { status?: unknown; wave?: unknown; nodeId?: unknown };
			if (member.status !== "held" || !Number.isInteger(member.wave) || typeof member.nodeId !== "string") continue;
			const wave = member.wave as number;
			byWave.set(wave, (byWave.get(wave) ?? 0) + 1);
			const nodeWaves = byNodeWave.get(member.nodeId) ?? new Map<number, number>();
			nodeWaves.set(wave, (nodeWaves.get(wave) ?? 0) + 1);
			byNodeWave.set(member.nodeId, nodeWaves);
		}
		global += Math.max(0, ...byWave.values());
		for (const [id, waves] of byNodeWave) nodes[id] = (nodes[id] ?? 0) + Math.max(0, ...waves.values());
	}
	return { global, nodes };
}
function assertCapacity(file: CapacityStateFile, nodeId: string, limits: CapacityLimits): void {
	const held = heldReservationUsage(file.reservations);
	const globalUsed = file.leases.length + held.global;
	if (globalUsed >= limits.global)
		throw new Error(`dispatch: admission denied: global capacity reached (${globalUsed}/${limits.global})`);
	const nodeLimit = limits.nodes[nodeId];
	if (nodeLimit !== undefined) {
		if (nodeLimit < 1) throw new Error(`dispatch: admission denied: node '${nodeId}' capacity unavailable`);
		const used = file.leases.filter((lease) => lease.nodeId === nodeId).length + (held.nodes[nodeId] ?? 0);
		if (used >= nodeLimit)
			throw new Error(`dispatch: admission denied: node '${nodeId}' capacity reached (${used}/${nodeLimit})`);
	}
}
export function acquireCapacityLease(input: {
	assignmentId: string;
	nodeId: string;
	limits: CapacityLimits;
	nowMs?: number;
	ttlMs?: number;
	ownerPid?: number;
	processBirthToken?: string;
	reservation?: { ownerId: string; memberId: string };
	probe?: LeaseOwnerProbe;
	onAcquiredUnderLock?: (state: CapacityStateFile) => void;
}): CapacityLease {
	return withStateFileLockSync(capacityStateLockPath(), () => {
		const nowMs = input.nowMs ?? Date.now();
		const file = readCapacityStateUnsafe();
		reclaim(file, nowMs, input.probe ?? defaultProbe);
		if (file.draining) throw new Error("dispatch: admission denied: capacity is draining");
		const existing = file.leases.find((lease) => lease.assignmentId === input.assignmentId);
		if (existing) {
			if (existing.nodeId !== input.nodeId) {
				const without = { ...file, leases: file.leases.filter((lease) => lease !== existing) };
				assertCapacity(without, input.nodeId, input.limits);
				existing.nodeId = input.nodeId;
			}
			existing.heartbeatAt = new Date(nowMs).toISOString();
			existing.expiresAt = new Date(nowMs + (input.ttlMs ?? DEFAULT_CAPACITY_LEASE_TTL_MS)).toISOString();
			writeCapacityStateUnsafe(file);
			return clone(existing);
		}
		input.onAcquiredUnderLock?.(file);
		assertCapacity(file, input.nodeId, input.limits);
		const token = input.processBirthToken ?? processBirthToken(input.ownerPid ?? process.pid);
		if (!token) throw new Error("dispatch: cannot establish process birth token");
		const at = new Date(nowMs).toISOString();
		const lease: CapacityLease = {
			leaseId: `lease-${nowMs.toString(36)}-${randomBytes(6).toString("hex")}`,
			assignmentId: input.assignmentId,
			nodeId: input.nodeId,
			ownerPid: input.ownerPid ?? process.pid,
			processBirthToken: token,
			acquiredAt: at,
			heartbeatAt: at,
			expiresAt: new Date(nowMs + (input.ttlMs ?? DEFAULT_CAPACITY_LEASE_TTL_MS)).toISOString(),
			reservationOwnerId: input.reservation?.ownerId ?? null,
			reservationMemberId: input.reservation?.memberId ?? null,
		};
		file.leases.push(lease);
		writeCapacityStateUnsafe(file);
		return clone(lease);
	});
}
export function rebindCapacityLease(
	assignmentId: string,
	nodeId: string,
	limits: CapacityLimits,
	nowMs = Date.now(),
): CapacityLease {
	return withStateFileLockSync(capacityStateLockPath(), () => {
		const file = readCapacityStateUnsafe();
		reclaim(file, nowMs, defaultProbe);
		const lease = file.leases.find((entry) => entry.assignmentId === assignmentId);
		if (!lease) throw new Error(`dispatch: no capacity lease for assignment '${assignmentId}'`);
		if (lease.nodeId !== nodeId) {
			const without = { ...file, leases: file.leases.filter((entry) => entry !== lease) };
			assertCapacity(without, nodeId, limits);
			lease.nodeId = nodeId;
		}
		lease.heartbeatAt = new Date(nowMs).toISOString();
		writeCapacityStateUnsafe(file);
		return clone(lease);
	});
}
export function renameCapacityLeaseAssignment(leaseId: string, assignmentId: string): CapacityLease {
	return withStateFileLockSync(capacityStateLockPath(), () => {
		const file = readCapacityStateUnsafe();
		if (file.leases.some((lease) => lease.assignmentId === assignmentId && lease.leaseId !== leaseId))
			throw new Error(`dispatch: assignment '${assignmentId}' already owns a capacity lease`);
		const lease = file.leases.find((entry) => entry.leaseId === leaseId);
		if (!lease) throw new Error(`dispatch: capacity lease '${leaseId}' is not active`);
		lease.assignmentId = assignmentId;
		writeCapacityStateUnsafe(file);
		return clone(lease);
	});
}

export function heartbeatCapacityLease(
	leaseId: string,
	nowMs = Date.now(),
	ttlMs = DEFAULT_CAPACITY_LEASE_TTL_MS,
): CapacityLease | null {
	return withStateFileLockSync(capacityStateLockPath(), () => {
		const file = readCapacityStateUnsafe();
		const lease = file.leases.find((entry) => entry.leaseId === leaseId);
		if (!lease) return null;
		lease.heartbeatAt = new Date(nowMs).toISOString();
		lease.expiresAt = new Date(nowMs + ttlMs).toISOString();
		writeCapacityStateUnsafe(file);
		return clone(lease);
	});
}
export function releaseCapacityLease(leaseId: string): boolean {
	return withStateFileLockSync(capacityStateLockPath(), () => {
		const file = readCapacityStateUnsafe();
		const before = file.leases.length;
		file.leases = file.leases.filter((lease) => lease.leaseId !== leaseId);
		if (before !== file.leases.length) writeCapacityStateUnsafe(file);
		return before !== file.leases.length;
	});
}
export function setCapacityDraining(draining: boolean): void {
	withStateFileLockSync(capacityStateLockPath(), () => {
		const file = readCapacityStateUnsafe();
		file.draining = draining;
		writeCapacityStateUnsafe(file);
	});
}
export function capacityLeaseUsage(options?: { nowMs?: number; probe?: LeaseOwnerProbe }): {
	global: number;
	nodes: Readonly<Record<string, number>>;
} {
	const leases = listCapacityLeases(options);
	const nodes: Record<string, number> = {};
	for (const lease of leases) nodes[lease.nodeId] = (nodes[lease.nodeId] ?? 0) + 1;
	return { global: leases.length, nodes };
}

export function listCapacityLeases(options?: {
	nowMs?: number;
	probe?: LeaseOwnerProbe;
}): ReadonlyArray<CapacityLease> {
	return withStateFileLockSync(capacityStateLockPath(), () => {
		const file = readCapacityStateUnsafe();
		const before = file.leases.length;
		reclaim(file, options?.nowMs ?? Date.now(), options?.probe ?? defaultProbe);
		if (before !== file.leases.length) writeCapacityStateUnsafe(file);
		return file.leases.map(clone);
	});
}
