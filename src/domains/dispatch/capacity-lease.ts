import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { clioStateDir } from "../../core/xdg.js";
import { atomicWrite } from "../../engine/session.js";

export const MAX_CAPACITY_LEASES = 1_000;
export const DEFAULT_CAPACITY_LEASE_TTL_MS = 30_000;
/**
 * An operator drain outlives the process that asked for it, so it cannot be
 * owner-scoped, but an unbounded durable flag would wedge every future dispatch
 * on the machine if the draining process never came back to clear it. Bound it
 * instead: a drain expires unless an operator renews it.
 */
export const DEFAULT_CAPACITY_DRAIN_TTL_MS = 60 * 60_000;

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
export interface CapacityDrain {
	requestedByPid: number;
	requestedAt: string;
	expiresAt: string;
}
export interface CapacityStateFile {
	version: 2;
	draining: CapacityDrain | null;
	leases: CapacityLease[];
	/** Fully validated and interpreted only by reservation-store.ts. */
	reservations: unknown[];
}
export interface LeaseOwnerProbe {
	birthToken(pid: number): string | null;
	/** True when a missing token proves the owner is gone. Defaults to true. */
	tokenProvesDeath?: boolean;
	/** Liveness fallback for platforms with no birth-token source. */
	alive?(pid: number): boolean;
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
function validTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
function validDrain(value: unknown): value is CapacityDrain {
	if (typeof value !== "object" || value === null) return false;
	const drain = value as Partial<CapacityDrain>;
	return (
		Number.isInteger(drain.requestedByPid) &&
		(drain.requestedByPid ?? 0) > 0 &&
		validTimestamp(drain.requestedAt) &&
		validTimestamp(drain.expiresAt)
	);
}
export function readCapacityStateUnsafe(): CapacityStateFile {
	if (!existsSync(capacityStatePath())) return { version: 2, draining: null, leases: [], reservations: [] };
	let parsed: CapacityStateFile;
	try {
		parsed = JSON.parse(readFileSync(capacityStatePath(), "utf8")) as CapacityStateFile;
	} catch (error) {
		throw new Error(`dispatch capacity store is unreadable: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (
		parsed?.version !== 2 ||
		!(parsed.draining === null || validDrain(parsed.draining)) ||
		!Array.isArray(parsed.leases) ||
		!parsed.leases.every(valid) ||
		!Array.isArray(parsed.reservations)
	)
		throw new Error(
			`dispatch capacity store has an invalid schema (expected version 2): ${capacityStatePath()}. Remove the file to reset local admission state; leases and reservations are process-lifetime state, not history.`,
		);
	return { ...parsed, leases: parsed.leases.map(clone), reservations: structuredClone(parsed.reservations) };
}
export function writeCapacityStateUnsafe(file: CapacityStateFile): void {
	// Truncating here would hand back a lease that no process can see or release,
	// so the bound is an admission failure instead of a silent drop.
	if (file.leases.length > MAX_CAPACITY_LEASES)
		throw new Error(
			`dispatch: admission denied: capacity lease store is full (${file.leases.length}/${MAX_CAPACITY_LEASES})`,
		);
	atomicWrite(capacityStatePath(), JSON.stringify(file, null, 2));
}

function readProcStartTime(pid: number): string | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(")");
		const fields = stat.slice(close + 2).split(" ");
		return fields[19] ?? null; // field 22; slice begins at field 3
	} catch {
		return null;
	}
}
/**
 * True when this platform can distinguish "pid is gone" from "pid cannot be
 * inspected". Where it can, a missing token proves the owner is dead. Where it
 * cannot, a missing token proves nothing, so reclamation falls back to a
 * liveness signal and the lease expiry rather than assuming the owner died.
 */
const BIRTH_TOKEN_SOURCE_AVAILABLE = readProcStartTime(process.pid) !== null;

export function processBirthToken(pid = process.pid): string | null {
	const started = readProcStartTime(pid);
	if (started !== null) return started;
	return BIRTH_TOKEN_SOURCE_AVAILABLE ? null : `pid-${pid}`;
}
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the pid exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
const defaultProbe: LeaseOwnerProbe = {
	birthToken: processBirthToken,
	tokenProvesDeath: BIRTH_TOKEN_SOURCE_AVAILABLE,
	alive: processAlive,
};
function ownerHoldsLease(lease: CapacityLease, probe: LeaseOwnerProbe): boolean {
	const current = probe.birthToken(lease.ownerPid);
	if (current === null || current !== lease.processBirthToken) return false;
	// A synthetic token matches any process that reuses the pid, so where a
	// missing token proves nothing the token proves nothing either: require a
	// liveness signal before treating the lease as held.
	if (probe.tokenProvesDeath === false) return probe.alive?.(lease.ownerPid) ?? false;
	return true;
}
function reclaim(file: CapacityStateFile, nowMs: number, probe: LeaseOwnerProbe): void {
	file.leases = file.leases.filter((lease) => ownerHoldsLease(lease, probe) && Date.parse(lease.expiresAt) > nowMs);
}
/** Inspect/expire the drain inside an admission-state transaction. The caller persists the mutated state. */
export function activeCapacityDrainUnsafe(file: CapacityStateFile, nowMs: number): CapacityDrain | null {
	if (file.draining === null) return null;
	if (Date.parse(file.draining.expiresAt) <= nowMs) {
		file.draining = null;
		return null;
	}
	return file.draining;
}
const RESERVATION_STATUSES = new Set(["active", "released", "rolled_back", "expired"]);
const MEMBER_STATUSES = new Set(["held", "consumed", "released"]);
/**
 * Held reservation slots are capacity too, so admission must count them. This is
 * a deliberately minimal re-read of the shape `reservation-store.ts` owns (that
 * module cannot be imported here without a cycle). Anything it would reject is
 * rejected here as well: silently skipping an unreadable record would under-count
 * capacity and admit past the cap.
 */
function heldReservationUsage(values: ReadonlyArray<unknown>): { global: number; nodes: Record<string, number> } {
	let global = 0;
	const nodes: Record<string, number> = {};
	for (const value of values) {
		if (typeof value !== "object" || value === null)
			throw new Error("dispatch capacity store has invalid reservation records");
		const record = value as { status?: unknown; members?: unknown };
		if (typeof record.status !== "string" || !RESERVATION_STATUSES.has(record.status) || !Array.isArray(record.members))
			throw new Error("dispatch capacity store has invalid reservation records");
		if (record.status !== "active") continue;
		const byWave = new Map<number, number>();
		const byNodeWave = new Map<string, Map<number, number>>();
		for (const raw of record.members) {
			if (typeof raw !== "object" || raw === null)
				throw new Error("dispatch capacity store has invalid reservation records");
			const member = raw as { status?: unknown; wave?: unknown; nodeId?: unknown };
			if (
				typeof member.status !== "string" ||
				!MEMBER_STATUSES.has(member.status) ||
				!Number.isInteger(member.wave) ||
				typeof member.nodeId !== "string"
			)
				throw new Error("dispatch capacity store has invalid reservation records");
			if (member.status !== "held") continue;
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
	// The denial names the compliant next move, not just the gate. A model told
	// only that it is full re-dispatches with a different agent; the work it is
	// waiting on is already running under its own detached assignments.
	if (globalUsed >= limits.global) {
		throw new Error(
			`dispatch: admission denied: global capacity reached (${globalUsed}/${limits.global}). Collect the runs already in flight before dispatching more; re-dispatching with a different agent or options does not free a slot.`,
		);
	}
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
		const drain = activeCapacityDrainUnsafe(file, nowMs);
		if (drain !== null)
			throw new Error(
				`dispatch: admission denied: capacity is draining (requested by pid ${drain.requestedByPid} at ${drain.requestedAt})`,
			);
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
/**
 * Operator drain for the whole machine. This is durable and not scoped to the
 * requesting process, so a shutting-down orchestrator must never call it: doing
 * so would deny admission in every sibling Clio process and clear an operator's
 * standing drain on exit. Process shutdown uses the bundle's own drain flag.
 */
export function setCapacityDraining(
	draining: boolean,
	options?: { nowMs?: number; ttlMs?: number },
): CapacityDrain | null {
	return withStateFileLockSync(capacityStateLockPath(), () => {
		const nowMs = options?.nowMs ?? Date.now();
		const file = readCapacityStateUnsafe();
		file.draining = draining
			? {
					requestedByPid: process.pid,
					requestedAt: new Date(nowMs).toISOString(),
					expiresAt: new Date(nowMs + (options?.ttlMs ?? DEFAULT_CAPACITY_DRAIN_TTL_MS)).toISOString(),
				}
			: null;
		writeCapacityStateUnsafe(file);
		return file.draining;
	});
}
export function capacityDrain(nowMs = Date.now()): CapacityDrain | null {
	return withStateFileLockSync(capacityStateLockPath(), () => {
		const file = readCapacityStateUnsafe();
		const hadDrain = file.draining !== null;
		const drain = activeCapacityDrainUnsafe(file, nowMs);
		if (hadDrain && drain === null) writeCapacityStateUnsafe(file);
		return drain;
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

/**
 * Per-node lease counts for display and for advisory placement spreading. Every
 * read takes the admission state lock, so a render loop or a multi-node
 * placement pass is coalesced into one read per tick. Admission never consults
 * this reader: it compares capacity under the lock it already holds.
 */
export function createNodeLeaseUsageReader(options: {
	now: () => number;
	cacheMs?: number;
	onError?: (error: unknown) => void;
}): (nodeId: string) => number {
	const cacheMs = options.cacheMs ?? 200;
	let cache: { atMs: number; nodes: Readonly<Record<string, number>> } | null = null;
	return (nodeId) => {
		const atMs = options.now();
		if (cache === null || atMs - cache.atMs >= cacheMs) {
			try {
				cache = { atMs, nodes: capacityLeaseUsage().nodes };
			} catch (error) {
				options.onError?.(error);
				cache = { atMs, nodes: {} };
			}
		}
		return cache.nodes[nodeId] ?? 0;
	};
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
