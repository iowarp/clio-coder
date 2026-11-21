import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { BIRTH_TOKEN_SOURCE_AVAILABLE, processAlive, processBirthToken } from "../../core/process-identity.js";
import { fsyncDirectoryAsync, safeResourceWriteAsync } from "../../core/safe-resource-write.js";
import {
	FILE_LOCK_ACQUIRE_TIMEOUT_MS,
	withStateFileLockSection,
	withStateFileLockSync,
} from "../../core/state-file-lock.js";
import { clioStateDir, clioStatePath } from "../../core/xdg.js";
import { atomicWrite } from "../../engine/session.js";
import { endpointLabel, foregroundStreamUsage, maxConcurrentRequestsRemedy } from "../providers/endpoint-capacity.js";
import type { DispatchReservationRecord } from "./reservation-store.js";

export { processBirthToken } from "../../core/process-identity.js";

export const MAX_CAPACITY_LEASES = 1_000;
export const DEFAULT_CAPACITY_LEASE_TTL_MS = 30_000;
/**
 * A lease from another host cannot be probed here, so it is dropped only once
 * it is this far past its expiry. A live owner renews on every heartbeat, so
 * only a dead or partitioned owner gets this old.
 */
const FOREIGN_LEASE_GRACE_MS = 10 * DEFAULT_CAPACITY_LEASE_TTL_MS;
/** `LOCAL_NODE_ID` in transport.ts; imported by value it would pull worker spawning into every admission reader. */
const LOCAL_NODE_ID = "local";
// Admission waits and lease renewal yield while they wait for the lock, but
// release, rename, reservation writes and the planners' usage reads still block
// the event loop, and a blocked process cannot renew. If such a caller could
// wait longer than a lease lives, a live holder would watch its own lease expire.
if (FILE_LOCK_ACQUIRE_TIMEOUT_MS >= DEFAULT_CAPACITY_LEASE_TTL_MS)
	throw new Error(
		`dispatch: lock acquire timeout (${FILE_LOCK_ACQUIRE_TIMEOUT_MS}ms) must stay under the capacity lease TTL (${DEFAULT_CAPACITY_LEASE_TTL_MS}ms)`,
	);
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
	/** Canonical inference endpoint; absent when the lease names none. */
	endpointKey?: string;
	/** Owner host. */
	host: string;
	ownerPid: number;
	processBirthToken: string;
	acquiredAt: string;
	expiresAt: string;
	heartbeatAt: string;
	reservationOwnerId: string | null;
	reservationMemberId: string | null;
	/** The worker's prompt cache lane among the live leases of its head, on every process of this state dir (FL-17). */
	cacheLane?: CacheLane;
}
/** A lane among the live holders of one cache key: `key` names the head, `lane` ends its provider routing id. */
export interface CacheLane {
	key: string;
	lane: number;
}
/**
 * A main session's prompt cache lane (M-11). It holds no capacity slot, so no admission reader sees it, and it is
 * reaped like a lease by its owner process. A released record stays as a hint for a bounded time so the same
 * conversation resumed in a new process takes its old lane back when it is free.
 */
export interface MainCacheLaneRecord extends CacheLane {
	conversation: string;
	host: string;
	ownerPid: number;
	processBirthToken: string;
	acquiredAt: string;
	expiresAt: string;
	releasedAt?: string;
}
export interface CapacityLimits {
	global: number;
	nodes: Readonly<Record<string, number>>;
	endpoints: Readonly<Record<string, number>>;
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
	/** Main sessions' cache lanes; absent when there are none. */
	cacheLanes?: MainCacheLaneRecord[];
}
export interface LeaseOwnerProbe {
	birthToken(pid: number): string | null;
	/** True when a missing token proves the owner is gone. Defaults to true. */
	tokenProvesDeath?: boolean;
	/** Liveness fallback for platforms with no birth-token source. */
	alive?(pid: number): boolean;
}

function onThisHost(host: string): boolean {
	return host === hostname();
}
function isLoopbackEndpoint(endpointKey: string): boolean {
	let host: string;
	try {
		host = new URL(endpointKey).hostname;
	} catch {
		// Not a URL (a provider-scoped key such as copilot-sdk), so it names a shared service.
		return false;
	}
	return host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
}
/**
 * On a shared state dir, the global dispatch cap is per host: a lease or held
 * reservation counts toward this host's global cap only when this host took it,
 * including leases targeting a named node. The node `local` is a different
 * machine on every host, so its per-node slots also count only where they were
 * taken. A named node is the same machine from everywhere, so its per-node cap
 * counts across hosts, and so does a shared provider endpoint. A loopback
 * endpoint is the server on the machine that runs the worker: each host's own
 * for `local`, the node itself for a named node.
 */
export function countsInGlobalCap(host: string): boolean {
	return onThisHost(host);
}
export function countsOnThisNode(host: string, nodeId: string): boolean {
	return nodeId !== LOCAL_NODE_ID || onThisHost(host);
}
export function countsOnThisEndpoint(host: string, nodeId: string, endpointKey: string): boolean {
	return nodeId !== LOCAL_NODE_ID || !isLoopbackEndpoint(endpointKey) || onThisHost(host);
}
function leaseOnEndpoint(lease: CapacityLease, endpointKey: string): boolean {
	return lease.endpointKey === endpointKey && countsOnThisEndpoint(lease.host, lease.nodeId, endpointKey);
}

function capacityStatePath(): string {
	return join(clioStateDir(), "dispatch-admission.json");
}
/** Whether the store exists, without creating the state root the way `clioStateDir` does; doctor must not. */
function capacityStateExists(): boolean {
	return existsSync(join(clioStatePath(), "dispatch-admission.json"));
}
/** The admission state file itself keys the one cross-process transaction lock. */
export function capacityStateLockPath(): string {
	return capacityStatePath();
}
function clone(lease: CapacityLease): CapacityLease {
	return { ...lease, ...(lease.cacheLane !== undefined ? { cacheLane: { ...lease.cacheLane } } : {}) };
}
function validCacheLane(value: unknown): value is CacheLane {
	if (typeof value !== "object" || value === null) return false;
	const lane = value as Partial<CacheLane>;
	return typeof lane.key === "string" && Number.isInteger(lane.lane) && (lane.lane ?? -1) >= 0;
}
function validMainCacheLane(value: unknown): value is MainCacheLaneRecord {
	if (!validCacheLane(value)) return false;
	const record = value as Partial<MainCacheLaneRecord>;
	return (
		typeof record.conversation === "string" &&
		typeof record.host === "string" &&
		Number.isInteger(record.ownerPid) &&
		typeof record.processBirthToken === "string" &&
		validTimestamp(record.acquiredAt) &&
		validTimestamp(record.expiresAt) &&
		(record.releasedAt === undefined || validTimestamp(record.releasedAt))
	);
}
function valid(value: unknown): value is CapacityLease {
	if (typeof value !== "object" || value === null) return false;
	const lease = value as Partial<CapacityLease>;
	return (
		typeof lease.leaseId === "string" &&
		typeof lease.assignmentId === "string" &&
		typeof lease.nodeId === "string" &&
		(lease.endpointKey === undefined || typeof lease.endpointKey === "string") &&
		typeof lease.host === "string" &&
		Number.isInteger(lease.ownerPid) &&
		typeof lease.processBirthToken === "string" &&
		typeof lease.acquiredAt === "string" &&
		typeof lease.expiresAt === "string" &&
		typeof lease.heartbeatAt === "string" &&
		(lease.reservationOwnerId === null || typeof lease.reservationOwnerId === "string") &&
		(lease.reservationMemberId === null || typeof lease.reservationMemberId === "string") &&
		(lease.cacheLane === undefined || validCacheLane(lease.cacheLane))
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
/** The one reservation shape every current writer records; `reservation-store.ts` interprets it. */
export function validReservationRecord(value: unknown): value is DispatchReservationRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<DispatchReservationRecord>;
	return (
		typeof record.ownerId === "string" &&
		typeof record.ownerPid === "number" &&
		Number.isInteger(record.ownerPid) &&
		record.ownerPid > 0 &&
		typeof record.host === "string" &&
		(record.processBirthToken === undefined || typeof record.processBirthToken === "string") &&
		(record.topology === "parallel" ||
			record.topology === "detached" ||
			record.topology === "sequential" ||
			record.topology === "pipeline" ||
			record.topology === "review" ||
			record.topology === "compete" ||
			record.topology === "council") &&
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
				(member.endpointKey === undefined || typeof member.endpointKey === "string") &&
				typeof member.costUpperBoundUsd === "number" &&
				Number.isFinite(member.costUpperBoundUsd) &&
				member.costUpperBoundUsd >= 0 &&
				(member.status === "held" || member.status === "consumed" || member.status === "released") &&
				(member.consumedAt === null || typeof member.consumedAt === "string") &&
				(member.releasedAt === null || typeof member.releasedAt === "string"),
		)
	);
}

/**
 * A stored record no current reader accepts. A settled one holds no capacity and is dropped where it is read.
 * A live one (an active reservation, or a lease whose expiry has not run out) may still bind a running process's
 * slots, so admission refuses until `clio-coder doctor --fix` drops it.
 */
export interface InvalidAdmissionRecord {
	kind: "reservation" | "capacity lease";
	label: string;
	live: boolean;
}

function recordLabel(value: unknown, key: "ownerId" | "leaseId", index: number): string {
	const id = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
	return typeof id === "string" && /^[\w.:-]{1,80}$/u.test(id) ? `'${id}'` : `#${index}`;
}

function liveInvalidLease(value: unknown, nowMs: number): boolean {
	const expiresAt =
		typeof value === "object" && value !== null ? (value as { expiresAt?: unknown }).expiresAt : undefined;
	const expiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
	// Renewal rewrites the expiry of a lease it can find, so a lease this stale has no live owner on any host.
	return Number.isFinite(expiry) && expiry + FOREIGN_LEASE_GRACE_MS > nowMs;
}

type CapacityStateScan = { state: CapacityStateFile; invalid: InvalidAdmissionRecord[] } | { problem: string };

function scanCapacityState(nowMs: number): CapacityStateScan {
	let parsed: CapacityStateFile;
	try {
		parsed = JSON.parse(readFileSync(capacityStatePath(), "utf8")) as CapacityStateFile;
	} catch (error) {
		return {
			problem: `dispatch capacity store is unreadable: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (
		parsed?.version !== 2 ||
		!(parsed.draining === null || validDrain(parsed.draining)) ||
		!Array.isArray(parsed.leases) ||
		!Array.isArray(parsed.reservations)
	)
		return { problem: `dispatch capacity store has an invalid schema (expected version 2): ${capacityStatePath()}` };
	const invalid: InvalidAdmissionRecord[] = [];
	const leases = parsed.leases.filter((lease, index) => {
		if (valid(lease)) return true;
		invalid.push({
			kind: "capacity lease",
			label: recordLabel(lease, "leaseId", index),
			live: liveInvalidLease(lease, nowMs),
		});
		return false;
	});
	const reservations = parsed.reservations.filter((record, index) => {
		if (validReservationRecord(record)) return true;
		const status = typeof record === "object" && record !== null ? (record as { status?: unknown }).status : undefined;
		invalid.push({ kind: "reservation", label: recordLabel(record, "ownerId", index), live: status === "active" });
		return false;
	});
	// A cache lane holds no capacity, so an invalid one is dropped where it is read, like a settled record.
	const cacheLanes = Array.isArray(parsed.cacheLanes) ? parsed.cacheLanes.filter(validMainCacheLane) : [];
	const { cacheLanes: _stored, ...rest } = parsed;
	return {
		state: {
			...rest,
			leases: leases.map(clone),
			reservations: structuredClone(reservations),
			...(cacheLanes.length > 0 ? { cacheLanes: cacheLanes.map((record) => ({ ...record })) } : {}),
		},
		invalid,
	};
}

function liveInvalidRefusal(live: ReadonlyArray<InvalidAdmissionRecord>): string {
	const name = (record: InvalidAdmissionRecord): string =>
		`${record.kind === "reservation" ? "active reservation" : "capacity lease"} ${record.label}`;
	const named = live.slice(0, 3).map(name).join(", ");
	const more = live.length > 3 ? ` and ${live.length - 3} more` : "";
	const what = live.length === 1 ? `an invalid ${named}` : `invalid live records (${named}${more})`;
	return `dispatch admission store has ${what} in ${capacityStatePath()}; if its owner is gone, run clio-coder doctor --fix to drop it`;
}

/**
 * Read the admission state, dropping every invalid settled record (see `InvalidAdmissionRecord`). `dropped`
 * counts them, so a caller holding the lock can rewrite the store.
 */
export function readCapacityStateRepairUnsafe(nowMs = Date.now()): { state: CapacityStateFile; dropped: number } {
	if (!existsSync(capacityStatePath()))
		return { state: { version: 2, draining: null, leases: [], reservations: [] }, dropped: 0 };
	const scan = scanCapacityState(nowMs);
	if ("problem" in scan) throw new Error(`${scan.problem}; clio-coder doctor --fix resets it`);
	const live = scan.invalid.filter((record) => record.live);
	if (live.length > 0) throw new Error(liveInvalidRefusal(live));
	return { state: scan.state, dropped: scan.invalid.length };
}

export function readCapacityStateUnsafe(): CapacityStateFile {
	return readCapacityStateRepairUnsafe().state;
}

export interface DispatchAdmissionStoreAudit {
	path: string;
	/** Why the whole file cannot be read; `repairDispatchAdmissionStore` resets it. */
	problem: string | null;
	reservations: number;
	leases: number;
	invalid: ReadonlyArray<InvalidAdmissionRecord>;
}

/** What doctor reports for the admission store, or null when there is none. Reads without writing. */
export function auditDispatchAdmissionStore(nowMs = Date.now()): DispatchAdmissionStoreAudit | null {
	if (!capacityStateExists()) return null;
	const scan = scanCapacityState(nowMs);
	if ("problem" in scan)
		return { path: capacityStatePath(), problem: scan.problem, reservations: 0, leases: 0, invalid: [] };
	return {
		path: capacityStatePath(),
		problem: null,
		reservations: scan.state.reservations.length,
		leases: scan.state.leases.length,
		invalid: scan.invalid,
	};
}

/**
 * `doctor --fix`: drop every invalid record, live ones included, and reset a file that cannot be read at all.
 * Leases and reservations are process-lifetime state, not history, so nothing worth keeping goes with them.
 */
export function repairDispatchAdmissionStore(nowMs = Date.now()): DispatchAdmissionStoreAudit | null {
	if (!capacityStateExists()) return null;
	return withStateFileLockSync(capacityStateLockPath(), () => {
		const scan = scanCapacityState(nowMs);
		if ("problem" in scan) {
			writeCapacityStateUnsafe({ version: 2, draining: null, leases: [], reservations: [] });
			return { path: capacityStatePath(), problem: scan.problem, reservations: 0, leases: 0, invalid: [] };
		}
		if (scan.invalid.length > 0) writeCapacityStateUnsafe(scan.state);
		return {
			path: capacityStatePath(),
			problem: null,
			reservations: scan.state.reservations.length,
			leases: scan.state.leases.length,
			invalid: scan.invalid,
		};
	});
}
export function writeCapacityStateUnsafe(file: CapacityStateFile): void {
	assertCapacityLeaseBound(file);
	atomicWrite(capacityStatePath(), JSON.stringify(file, null, 2));
}

function assertCapacityLeaseBound(file: CapacityStateFile): void {
	// Truncating here would hand back a lease that no process can see or release,
	// so the bound is an admission failure instead of a silent drop.
	if (file.leases.length > MAX_CAPACITY_LEASES)
		throw new Error(
			`dispatch: admission denied: capacity lease store is full (${file.leases.length}/${MAX_CAPACITY_LEASES})`,
		);
}

/** Retry a prepared write if a synchronous planner changed the snapshot (#428). */
export async function updateCapacityStateAsync<T>(
	update: (state: CapacityStateFile) => { result: T; changed: boolean },
): Promise<T> {
	const conflict = Symbol("capacity snapshot changed");
	for (let attempt = 0; attempt < 32; attempt += 1) {
		const prepared = await withStateFileLockSection(capacityStateLockPath(), () => {
			const state = readCapacityStateUnsafe();
			const before = JSON.stringify(state);
			const { result, changed } = update(state);
			// The async writer enforces the same bound as writeCapacityStateUnsafe (#428).
			if (changed) assertCapacityLeaseBound(state);
			return { before, contents: JSON.stringify(state, null, 2), result, changed };
		});
		if (!prepared.changed) {
			// A sibling may have renamed this state and still be flushing it (#428).
			await fsyncDirectoryAsync(dirname(capacityStatePath()));
			return prepared.result;
		}
		try {
			await safeResourceWriteAsync(capacityStatePath(), prepared.contents, {
				withRename: (commit) =>
					withStateFileLockSection(capacityStateLockPath(), () => {
						if (JSON.stringify(readCapacityStateUnsafe()) !== prepared.before) throw conflict;
						commit();
					}),
			});
			return prepared.result;
		} catch (error) {
			if (error !== conflict) throw error;
		}
	}
	throw new Error("dispatch: capacity settlement failed after 32 concurrent snapshot changes");
}

export function releaseCapacityLeaseAsync(leaseId: string): Promise<boolean> {
	return updateCapacityStateAsync((file) => {
		const before = file.leases.length;
		file.leases = file.leases.filter((lease) => lease.leaseId !== leaseId);
		const changed = before !== file.leases.length;
		return { result: changed, changed };
	});
}

const defaultProbe: LeaseOwnerProbe = {
	birthToken: processBirthToken,
	tokenProvesDeath: BIRTH_TOKEN_SOURCE_AVAILABLE,
	alive: processAlive,
};
function ownerHoldsLease(
	lease: Pick<CapacityLease, "ownerPid" | "processBirthToken">,
	probe: LeaseOwnerProbe,
): boolean {
	const current = probe.birthToken(lease.ownerPid);
	if (current === null || current !== lease.processBirthToken) return false;
	// A synthetic token matches any process that reuses the pid, so where a
	// missing token proves nothing the token proves nothing either: require a
	// liveness signal before treating the lease as held.
	if (probe.tokenProvesDeath === false) return probe.alive?.(lease.ownerPid) ?? false;
	return true;
}
function ownerStillHolds(
	record: Pick<CapacityLease, "host" | "ownerPid" | "processBirthToken" | "expiresAt">,
	nowMs: number,
	probe: LeaseOwnerProbe,
): boolean {
	// A record from another host is never probed here: on a shared state dir a
	// local pid probe would inspect the wrong process. Only its age can end it.
	if (!onThisHost(record.host)) return Date.parse(record.expiresAt) + FOREIGN_LEASE_GRACE_MS > nowMs;
	if (!ownerHoldsLease(record, probe)) return false;
	// A real birth token identifies this exact process, so it outranks the
	// expiry: an owner that missed heartbeats because it sat blocked on the
	// admission lock is alive, not gone, and taking its slot would put two
	// processes over the same cap. Where the token is synthetic it proves
	// nothing about pid reuse, so there the expiry still decides.
	return probe.tokenProvesDeath !== false || Date.parse(record.expiresAt) > nowMs;
}
function reclaim(file: CapacityStateFile, nowMs: number, probe: LeaseOwnerProbe): void {
	file.leases = file.leases.filter((lease) => ownerStillHolds(lease, nowMs, probe));
	if (file.cacheLanes === undefined) return;
	const at = new Date(nowMs).toISOString();
	const kept: MainCacheLaneRecord[] = [];
	for (const record of file.cacheLanes) {
		// A dead owner's lane becomes a hint for its conversation; a hint lasts as long as a cached prefix might.
		if (record.releasedAt === undefined && !ownerStillHolds(record, nowMs, probe)) record.releasedAt = at;
		if (record.releasedAt === undefined || Date.parse(record.releasedAt) + MAIN_CACHE_LANE_HINT_MS > nowMs)
			kept.push(record);
	}
	setCacheLanes(file, kept);
}
function setCacheLanes(file: CapacityStateFile, records: MainCacheLaneRecord[]): void {
	if (records.length > 0) file.cacheLanes = records;
	else delete file.cacheLanes;
}

/** A main session's lane outlives no-birth-token owners by this long without a claim; each claim renews it. */
const MAIN_CACHE_LANE_TTL_MS = 60 * 60_000;
/** How long a released main lane stays a hint for its conversation: about as long as the backend keeps a prefix. */
const MAIN_CACHE_LANE_HINT_MS = 60 * 60_000;
const MAX_MAIN_CACHE_LANES = 1_000;

function lowestFreeCacheLane(file: CapacityStateFile, key: string, preferred?: number): number {
	const taken = new Set<number>();
	for (const lease of file.leases) if (lease.cacheLane?.key === key) taken.add(lease.cacheLane.lane);
	for (const record of file.cacheLanes ?? [])
		if (record.key === key && record.releasedAt === undefined) taken.add(record.lane);
	if (preferred !== undefined && !taken.has(preferred)) return preferred;
	let lane = 0;
	while (taken.has(lane)) lane += 1;
	return lane;
}

/**
 * The prompt cache lane of a worker's lease (FL-17): the lowest lane no live lease or main session of `key` holds on
 * any process sharing this state dir, kept on the lease and released with it. Null when the lease is gone.
 */
export function claimLeaseCacheLane(
	leaseId: string,
	key: string,
	options: { nowMs?: number; probe?: LeaseOwnerProbe } = {},
): number | null {
	return withStateFileLockSync(capacityStateLockPath(), () => {
		const file = readCapacityStateUnsafe();
		reclaim(file, options.nowMs ?? Date.now(), options.probe ?? defaultProbe);
		const lease = file.leases.find((entry) => entry.leaseId === leaseId);
		if (lease === undefined) return null;
		if (lease.cacheLane?.key === key) return lease.cacheLane.lane;
		delete lease.cacheLane;
		lease.cacheLane = { key, lane: lowestFreeCacheLane(file, key) };
		writeCapacityStateUnsafe(file);
		return lease.cacheLane.lane;
	});
}

export interface ClaimMainCacheLaneInput {
	key: string;
	conversation: string;
	nowMs?: number;
	ownerPid?: number;
	processBirthToken?: string;
	probe?: LeaseOwnerProbe;
}

/**
 * A main session's prompt cache lane (M-11): kept while it holds `key`, else its old lane on `key` when that is free,
 * else the lowest free one, across every process sharing this state dir. Each claim renews the record.
 */
export function claimMainCacheLane(input: ClaimMainCacheLaneInput): number {
	return withStateFileLockSync(capacityStateLockPath(), () => {
		const nowMs = input.nowMs ?? Date.now();
		const file = readCapacityStateUnsafe();
		reclaim(file, nowMs, input.probe ?? defaultProbe);
		const ownerPid = input.ownerPid ?? process.pid;
		const token = input.processBirthToken ?? processBirthToken(ownerPid);
		if (!token) throw new Error("dispatch: cannot establish process birth token");
		const host = hostname();
		const records = file.cacheLanes ?? [];
		const at = new Date(nowMs).toISOString();
		const expiresAt = new Date(nowMs + MAIN_CACHE_LANE_TTL_MS).toISOString();
		const ours = (record: MainCacheLaneRecord): boolean =>
			record.releasedAt === undefined &&
			record.conversation === input.conversation &&
			record.host === host &&
			record.ownerPid === ownerPid &&
			record.processBirthToken === token;
		const held = records.find((record) => ours(record) && record.key === input.key);
		if (held !== undefined) {
			held.expiresAt = expiresAt;
			writeCapacityStateUnsafe(file);
			return held.lane;
		}
		const hint = [...records]
			.reverse()
			.find(
				(record) =>
					record.releasedAt !== undefined && record.conversation === input.conversation && record.key === input.key,
			);
		// This conversation's other head and its released hints on this key give way to the new claim.
		const kept = records.filter(
			(record) =>
				!ours(record) &&
				!(record.releasedAt !== undefined && record.conversation === input.conversation && record.key === input.key),
		);
		setCacheLanes(file, kept);
		const lane = lowestFreeCacheLane(file, input.key, hint?.lane);
		// The oldest hints go first; a full store of live lanes is a claim failure, as a full lease store is.
		while (kept.length >= MAX_MAIN_CACHE_LANES) {
			const index = kept.findIndex((record) => record.releasedAt !== undefined);
			if (index < 0) throw new Error(`dispatch: main cache lane store is full (${kept.length}/${MAX_MAIN_CACHE_LANES})`);
			kept.splice(index, 1);
		}
		kept.push({
			key: input.key,
			lane,
			conversation: input.conversation,
			host,
			ownerPid,
			processBirthToken: token,
			acquiredAt: at,
			expiresAt,
		});
		setCacheLanes(file, kept);
		writeCapacityStateUnsafe(file);
		return lane;
	});
}

/** Release this process's main cache lanes: one conversation's, or all of them when none is named. */
export function releaseMainCacheLanes(
	conversation: string | undefined,
	owner: { ownerPid?: number; processBirthToken?: string; nowMs?: number } = {},
): void {
	if (!capacityStateExists()) return;
	withStateFileLockSync(capacityStateLockPath(), () => {
		const file = readCapacityStateUnsafe();
		const ownerPid = owner.ownerPid ?? process.pid;
		const token = owner.processBirthToken ?? processBirthToken(ownerPid);
		const at = new Date(owner.nowMs ?? Date.now()).toISOString();
		let changed = false;
		for (const record of file.cacheLanes ?? []) {
			if (record.releasedAt !== undefined || record.host !== hostname() || record.ownerPid !== ownerPid) continue;
			if (record.processBirthToken !== token) continue;
			if (conversation !== undefined && record.conversation !== conversation) continue;
			record.releasedAt = at;
			changed = true;
		}
		if (changed) writeCapacityStateUnsafe(file);
	});
}

/** The cross-process lane store the engine's main cache routing claims through (M-11). */
export const mainCacheLaneStore = {
	claim: (key: string, conversation: string): number => claimMainCacheLane({ key, conversation }),
	release: (conversation: string | undefined): void => releaseMainCacheLanes(conversation),
};
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
 * Held reservation slots are capacity too, so admission must count them. The read
 * already dropped every record `validReservationRecord` rejects; this re-checks the
 * fields it counts, and still fails closed, because silently skipping a record would
 * under-count capacity and admit past the cap.
 */
function heldReservationUsage(
	values: ReadonlyArray<unknown>,
	transferring?: { ownerId: string; memberId: string },
): {
	global: number;
	nodes: Record<string, number>;
	endpoints: Record<string, number>;
	/** Foreign hosts holding counted reservation slots per node. */
	foreignNodeHosts: Map<string, Set<string>>;
	/** Foreign hosts holding counted reservation slots per endpoint. */
	foreignEndpointHosts: Map<string, Set<string>>;
	/** Whether this process owns any counted held global slot. */
	ownHeld: boolean;
} {
	let global = 0;
	const nodes: Record<string, number> = {};
	const endpoints: Record<string, number> = {};
	const foreignNodeHosts = new Map<string, Set<string>>();
	const foreignEndpointHosts = new Map<string, Set<string>>();
	let ownHeld = false;
	for (const value of values) {
		if (typeof value !== "object" || value === null)
			throw new Error("dispatch capacity store has invalid reservation records");
		const record = value as {
			ownerId?: unknown;
			ownerPid?: unknown;
			host?: unknown;
			status?: unknown;
			members?: unknown;
		};
		if (typeof record.status !== "string" || !RESERVATION_STATUSES.has(record.status) || !Array.isArray(record.members))
			throw new Error("dispatch capacity store has invalid reservation records");
		if (record.status !== "active") continue;
		if (typeof record.host !== "string") throw new Error("dispatch capacity store has invalid reservation records");
		const host = record.host;
		const byWave = new Map<number, number>();
		const byNodeWave = new Map<string, Map<number, number>>();
		const byEndpointWave = new Map<string, Map<number, number>>();
		let transferringWave: number | undefined;
		if (transferring !== undefined && record.ownerId === transferring.ownerId) {
			const member = record.members.find(
				(raw) => typeof raw === "object" && raw !== null && raw.memberId === transferring.memberId,
			);
			// Transfer validates and consumes the member under this same lock.
			// A retry's existing lease also carries that validated identity.
			if (member?.status !== "consumed" || !Number.isInteger(member.wave))
				throw new Error("dispatch: capacity transfer requires a consumed reservation member");
			transferringWave = member.wave;
		}
		for (const raw of record.members) {
			if (typeof raw !== "object" || raw === null)
				throw new Error("dispatch capacity store has invalid reservation records");
			const member = raw as { status?: unknown; wave?: unknown; nodeId?: unknown; endpointKey?: unknown };
			if (
				typeof member.status !== "string" ||
				!MEMBER_STATUSES.has(member.status) ||
				!Number.isInteger(member.wave) ||
				typeof member.nodeId !== "string"
			)
				throw new Error("dispatch capacity store has invalid reservation records");
			if (member.status !== "held") continue;
			const wave = member.wave as number;
			if (member.endpointKey !== undefined && typeof member.endpointKey !== "string")
				throw new Error("dispatch capacity store has invalid reservation records");
			// Waves reuse the owner's reserved slots. Only its same-wave peers
			// compete with this lease; other waves stay held in durable state and
			// still count at their full peak against every other owner.
			if (transferringWave !== undefined && wave !== transferringWave) continue;
			if (countsInGlobalCap(host)) {
				byWave.set(wave, (byWave.get(wave) ?? 0) + 1);
			}
			if (countsOnThisNode(host, member.nodeId)) {
				const nodeWaves = byNodeWave.get(member.nodeId) ?? new Map<number, number>();
				nodeWaves.set(wave, (nodeWaves.get(wave) ?? 0) + 1);
				byNodeWave.set(member.nodeId, nodeWaves);
			}
			if (typeof member.endpointKey === "string" && countsOnThisEndpoint(host, member.nodeId, member.endpointKey)) {
				const endpointWaves = byEndpointWave.get(member.endpointKey) ?? new Map<number, number>();
				endpointWaves.set(wave, (endpointWaves.get(wave) ?? 0) + 1);
				byEndpointWave.set(member.endpointKey, endpointWaves);
			}
		}
		global += Math.max(0, ...byWave.values());
		for (const [id, waves] of byNodeWave) {
			nodes[id] = (nodes[id] ?? 0) + Math.max(0, ...waves.values());
			if (!onThisHost(host)) {
				const hosts = foreignNodeHosts.get(id) ?? new Set<string>();
				hosts.add(host as string);
				foreignNodeHosts.set(id, hosts);
			}
		}
		for (const [key, waves] of byEndpointWave) {
			endpoints[key] = (endpoints[key] ?? 0) + Math.max(0, ...waves.values());
			if (!onThisHost(host)) {
				const hosts = foreignEndpointHosts.get(key) ?? new Set<string>();
				hosts.add(host as string);
				foreignEndpointHosts.set(key, hosts);
			}
		}
		if (byWave.size > 0 && record.ownerPid === process.pid) ownHeld = true;
	}
	return { global, nodes, endpoints, foreignNodeHosts, foreignEndpointHosts, ownHeld };
}

/**
 * Names the other hosts holding counted slots and the way to free a dead one's,
 * since this host cannot see whether those processes are alive.
 */
function foreignHoldersNote(
	leases: ReadonlyArray<CapacityLease>,
	reservationHosts: ReadonlySet<string> | undefined,
): string {
	const hosts = new Set(reservationHosts);
	for (const lease of leases) if (!onThisHost(lease.host)) hosts.add(lease.host as string);
	if (hosts.size === 0) return "";
	return ` (held by ${[...hosts].sort().join(", ")}; if that process is gone: clio-coder session terminate <id> --force)`;
}

export interface EndpointCapacityHolders {
	leases: number;
	reservations: number;
	foregroundStreams: number;
}

/** Who holds slots on one endpoint now, by kind, for a surface explaining a wait. */
export function endpointCapacityHolders(endpointKey: string): EndpointCapacityHolders {
	return withStateFileLockSync(capacityStateLockPath(), () => {
		const file = readCapacityStateUnsafe();
		reclaim(file, Date.now(), defaultProbe);
		return {
			leases: file.leases.filter((lease) => leaseOnEndpoint(lease, endpointKey)).length,
			reservations: heldReservationUsage(file.reservations).endpoints[endpointKey] ?? 0,
			foregroundStreams: foregroundStreamUsage()[endpointKey] ?? 0,
		};
	});
}

/** Name the endpoint-capacity addends that are actually nonzero. */
export function describeEndpointCapacityHolders(holders: EndpointCapacityHolders): string {
	const parts: string[] = [];
	const add = (count: number, singular: string, plural: string): void => {
		if (count > 0) parts.push(`${count} ${count === 1 ? singular : plural}`);
	};
	add(holders.leases, "active lease", "active leases");
	add(holders.reservations, "held reservation", "held reservations");
	add(holders.foregroundStreams, "foreground stream", "foreground streams");
	if (parts.length === 0) return "no active lease, held reservation, or foreground stream currently holds a slot";
	const named =
		parts.length === 1
			? parts[0]
			: parts.length === 2
				? `${parts[0]} and ${parts[1]}`
				: `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
	const total = holders.leases + holders.reservations + holders.foregroundStreams;
	return `${named} ${total === 1 ? "holds" : "hold"} ${total === 1 ? "the slot" : "the slots"}`;
}

/**
 * The ways past a saturated inference endpoint, in the order an operator can
 * act on them.
 *
 * `maxConcurrentRequests` is named because the conservative default of one slot
 * is a guess about an unprobed server, and on a server started with
 * `--parallel 4` it is simply wrong. Without that sentence the denial reads as
 * a hardware limit and the operator has no reason to look for a setting.
 *
 * `rosterFloor` is the smallest same-wave width the caller's topology can have.
 * A council runs its whole roster in one wave, so "dispatch fewer at once" is
 * not a move it has; saying so keeps the remedy honest.
 */
export function endpointCapacityRemedy(endpointKey: string, input?: { rosterFloor?: number }): string {
	const raise = maxConcurrentRequestsRemedy(
		endpointKey,
		"set this target's maxConcurrentRequests to the slot count the server was started with",
	);
	const ways = `${raise}, collect in-flight runs, or point workers at a second server`;
	if (input?.rosterFloor === undefined) return `reduce the same-wave worker count, ${ways}`;
	return `a council runs its whole roster in one wave and cannot go below ${input.rosterFloor} members, so ${ways}`;
}

function assertCapacity(
	file: CapacityStateFile,
	nodeId: string,
	endpointKey: string | undefined,
	limits: CapacityLimits,
	transferring?: { ownerId: string; memberId: string },
): void {
	const held = heldReservationUsage(file.reservations, transferring);
	const globalLeases = file.leases.filter((lease) => countsInGlobalCap(lease.host));
	const globalUsed = globalLeases.length + held.global;
	// The denial names the compliant next move, not just the gate. A model told
	// only that it is full re-dispatches with a different agent; the work it is
	// waiting on is already running under its own detached assignments.
	if (globalUsed >= limits.global) {
		const ownsSlots = held.ownHeld || globalLeases.some((lease) => lease.ownerPid === process.pid);
		throw new Error(
			`dispatch: admission denied: global capacity reached (${globalUsed}/${limits.global}).${ownsSlots ? " Collect the runs already in flight before dispatching more; re-dispatching with a different agent or options does not free a slot." : ""}`,
		);
	}
	const nodeLimit = limits.nodes[nodeId];
	if (nodeLimit !== undefined) {
		if (nodeLimit < 1) throw new Error(`dispatch: admission denied: node '${nodeId}' capacity unavailable`);
		const onNode = file.leases.filter((lease) => lease.nodeId === nodeId && countsOnThisNode(lease.host, lease.nodeId));
		const used = onNode.length + (held.nodes[nodeId] ?? 0);
		if (used >= nodeLimit)
			throw new Error(
				`dispatch: admission denied: node '${nodeId}' capacity reached (${used}/${nodeLimit})${foreignHoldersNote(onNode, held.foreignNodeHosts.get(nodeId))}`,
			);
	}
	if (endpointKey !== undefined) {
		const endpointLimit = limits.endpoints[endpointKey];
		if (endpointLimit !== undefined) {
			if (endpointLimit < 1)
				throw new Error(`dispatch: admission denied: endpoint '${endpointLabel(endpointKey)}' capacity unavailable`);
			const onEndpoint = file.leases.filter((lease) => leaseOnEndpoint(lease, endpointKey));
			const holders: EndpointCapacityHolders = {
				leases: onEndpoint.length,
				reservations: held.endpoints[endpointKey] ?? 0,
				foregroundStreams: foregroundStreamUsage()[endpointKey] ?? 0,
			};
			const used = holders.leases + holders.reservations + holders.foregroundStreams;
			if (used >= endpointLimit)
				throw new Error(
					`dispatch: admission denied: endpoint '${endpointLabel(endpointKey)}' capacity reached (${used}/${endpointLimit} slots): ${describeEndpointCapacityHolders(holders)}${foreignHoldersNote(onEndpoint, held.foreignEndpointHosts.get(endpointKey))}; ${endpointCapacityRemedy(endpointKey)}`,
				);
		}
	}
}
export interface AcquireCapacityLeaseInput {
	assignmentId: string;
	nodeId: string;
	endpointKey?: string;
	limits: CapacityLimits;
	nowMs?: number;
	ttlMs?: number;
	ownerPid?: number;
	processBirthToken?: string;
	reservation?: { ownerId: string; memberId: string };
	probe?: LeaseOwnerProbe;
	onAcquiredUnderLock?: (state: CapacityStateFile) => void;
}
export function acquireCapacityLease(input: AcquireCapacityLeaseInput): CapacityLease {
	return withStateFileLockSync(capacityStateLockPath(), () => acquireCapacityLeaseUnsafe(input));
}
/** The caller holds the capacity state lock; a throw leaves the stored state untouched. */
export function acquireCapacityLeaseUnsafe(input: AcquireCapacityLeaseInput): CapacityLease {
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
		if (existing.nodeId !== input.nodeId || existing.endpointKey !== input.endpointKey) {
			const without = { ...file, leases: file.leases.filter((lease) => lease !== existing) };
			assertCapacity(
				without,
				input.nodeId,
				input.endpointKey,
				input.limits,
				existing.reservationOwnerId !== null && existing.reservationMemberId !== null
					? { ownerId: existing.reservationOwnerId, memberId: existing.reservationMemberId }
					: undefined,
			);
			existing.nodeId = input.nodeId;
			if (input.endpointKey === undefined) delete existing.endpointKey;
			else existing.endpointKey = input.endpointKey;
		}
		existing.heartbeatAt = new Date(nowMs).toISOString();
		existing.expiresAt = new Date(nowMs + (input.ttlMs ?? DEFAULT_CAPACITY_LEASE_TTL_MS)).toISOString();
		writeCapacityStateUnsafe(file);
		return clone(existing);
	}
	input.onAcquiredUnderLock?.(file);
	assertCapacity(file, input.nodeId, input.endpointKey, input.limits, input.reservation);
	const token = input.processBirthToken ?? processBirthToken(input.ownerPid ?? process.pid);
	if (!token) throw new Error("dispatch: cannot establish process birth token");
	const at = new Date(nowMs).toISOString();
	const lease: CapacityLease = {
		leaseId: `lease-${nowMs.toString(36)}-${randomBytes(6).toString("hex")}`,
		assignmentId: input.assignmentId,
		nodeId: input.nodeId,
		...(input.endpointKey !== undefined ? { endpointKey: input.endpointKey } : {}),
		host: hostname(),
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

/**
 * Renew every listed lease in one read and one write. The caller holds the
 * capacity state lock. A lease absent from the store is reported as missing,
 * because whoever removed it has already handed its slot to someone else.
 */
export function renewCapacityLeasesUnsafe(
	leaseIds: ReadonlyArray<string>,
	nowMs = Date.now(),
	ttlMs = DEFAULT_CAPACITY_LEASE_TTL_MS,
	/** Runs before the write, so state that rides on a lease renews in the same transaction. */
	onRenewedUnderLock?: (file: CapacityStateFile, renewed: ReadonlyArray<CapacityLease>) => void,
): { renewed: CapacityLease[]; missing: string[] } {
	const file = readCapacityStateUnsafe();
	const byId = new Map(file.leases.map((lease) => [lease.leaseId, lease]));
	const renewed: CapacityLease[] = [];
	const missing: string[] = [];
	const heartbeatAt = new Date(nowMs).toISOString();
	const expiresAt = new Date(nowMs + ttlMs).toISOString();
	for (const leaseId of leaseIds) {
		const lease = byId.get(leaseId);
		if (lease === undefined) {
			missing.push(leaseId);
			continue;
		}
		lease.heartbeatAt = heartbeatAt;
		lease.expiresAt = expiresAt;
		renewed.push(lease);
	}
	if (renewed.length > 0) {
		onRenewedUnderLock?.(file, renewed);
		writeCapacityStateUnsafe(file);
	}
	return { renewed: renewed.map(clone), missing };
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
/** Synchronous usage read for admission planners whose host API cannot yield. */
export function capacityLeaseUsage(options?: { nowMs?: number; probe?: LeaseOwnerProbe }): {
	global: number;
	nodes: Readonly<Record<string, number>>;
	endpoints: Readonly<Record<string, number>>;
	endpointHolders: Readonly<Record<string, EndpointCapacityHolders>>;
} {
	return withStateFileLockSync(capacityStateLockPath(), () => capacityLeaseUsageUnsafe(options));
}

/** Fresh usage for async admission: wait for the same lock without blocking callbacks. */
export function capacityLeaseUsageAsync(options?: {
	nowMs?: number;
	probe?: LeaseOwnerProbe;
}): Promise<ReturnType<typeof capacityLeaseUsage>> {
	return withStateFileLockSection(capacityStateLockPath(), () => capacityLeaseUsageUnsafe(options));
}

/** The caller holds the capacity state lock for this read and any reclamation write. */
export function capacityLeaseUsageUnsafe(options?: {
	nowMs?: number;
	probe?: LeaseOwnerProbe;
}): ReturnType<typeof capacityLeaseUsage> {
	const file = readCapacityStateUnsafe();
	const before = file.leases.length;
	reclaim(file, options?.nowMs ?? Date.now(), options?.probe ?? defaultProbe);
	if (before !== file.leases.length) writeCapacityStateUnsafe(file);
	const leases = file.leases;
	let global = 0;
	const nodes: Record<string, number> = {};
	const foreground = foregroundStreamUsage();
	const endpoints: Record<string, number> = { ...foreground };
	const endpointHolders: Record<string, EndpointCapacityHolders> = Object.fromEntries(
		Object.entries(foreground).map(([endpointKey, foregroundStreams]) => [
			endpointKey,
			{ leases: 0, reservations: 0, foregroundStreams },
		]),
	);
	for (const lease of leases) {
		if (countsInGlobalCap(lease.host)) global += 1;
		if (countsOnThisNode(lease.host, lease.nodeId)) {
			nodes[lease.nodeId] = (nodes[lease.nodeId] ?? 0) + 1;
		}
		if (lease.endpointKey !== undefined && countsOnThisEndpoint(lease.host, lease.nodeId, lease.endpointKey)) {
			endpoints[lease.endpointKey] = (endpoints[lease.endpointKey] ?? 0) + 1;
			const holders = endpointHolders[lease.endpointKey] ?? { leases: 0, reservations: 0, foregroundStreams: 0 };
			endpointHolders[lease.endpointKey] = { ...holders, leases: holders.leases + 1 };
		}
	}
	return { global, nodes, endpoints, endpointHolders };
}

/** Coherent current endpoint occupancy, including held reservation waves.
 * The caller still owns admission; process-local streams are not global leases.
 */
export function endpointCapacityUsage(): Readonly<Record<string, number>> {
	return withStateFileLockSync(capacityStateLockPath(), () => {
		const file = readCapacityStateUnsafe();
		reclaim(file, Date.now(), defaultProbe);
		const held = heldReservationUsage(file.reservations);
		const usage: Record<string, number> = { ...foregroundStreamUsage() };
		for (const [key, count] of Object.entries(held.endpoints)) usage[key] = (usage[key] ?? 0) + count;
		for (const lease of file.leases) {
			if (lease.endpointKey !== undefined && leaseOnEndpoint(lease, lease.endpointKey))
				usage[lease.endpointKey] = (usage[lease.endpointKey] ?? 0) + 1;
		}
		return usage;
	});
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
/**
 * Drop every lease whose owner is exactly `owner` ({host, pid, birth}). Leases
 * from another host are reclaimed by `reclaim` only after a long grace, so a
 * node that died with a lease held pins its slots until then; `clio-coder session terminate
 * --force` calls this once that node's session heartbeat is stale (#439).
 */
export function releaseCapacityLeasesOwnedBy(owner: {
	host: string;
	pid: number;
	birth: string | null;
}): Promise<number> {
	return withStateFileLockSection(capacityStateLockPath(), () => {
		if (owner.birth === null) return 0;
		const file = readCapacityStateUnsafe();
		const before = file.leases.length;
		const owned = (record: Pick<CapacityLease, "host" | "ownerPid" | "processBirthToken">): boolean =>
			record.host === owner.host && record.ownerPid === owner.pid && record.processBirthToken === owner.birth;
		file.leases = file.leases.filter((lease) => !owned(lease));
		const released = before - file.leases.length;
		// The dead owner's main cache lanes go with its leases; they hold no slot, so they are not counted.
		const lanes = file.cacheLanes?.length ?? 0;
		setCacheLanes(
			file,
			(file.cacheLanes ?? []).filter((record) => !owned(record)),
		);
		if (released > 0 || (file.cacheLanes?.length ?? 0) !== lanes) writeCapacityStateUnsafe(file);
		return released;
	});
}
