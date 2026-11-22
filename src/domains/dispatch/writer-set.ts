/**
 * One writer set per checkout (DESIGN 4.5, fleet M8).
 *
 * A checkout has one writer set at a time. Members of a set have disjoint write roots or their own worktrees; one
 * dispatch call's requests and their retries form one set. A second set, from another dispatch call in this process
 * or from any other process (a second TUI, `clio-coder run`, a fleet), queues behind the live one and joins when it
 * empties, or gives up when its run's deadline passes. Nothing is refused for being busy.
 *
 * Across processes the set is one record under the state root, named by the canonical checkout, holding the pid,
 * birth token and lease stamps of the process that owns the set. A record whose owner is gone (dead pid, reused pid, a
 * zombie, or another host whose lease lapsed under the lease clock rule in `lease-clock.ts`) is taken over. A record
 * this build
 * cannot read fails the join closed. A fleet run holds the record for its whole run; its own steps are writers of
 * this process and never wait on it, and only another fleet does.
 *
 * Replaces the parallel-writer conflict, the checkout writer lease and the fleet workspace lock.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";
import {
	BIRTH_TOKEN_SOURCE_AVAILABLE,
	processAlive,
	processBirthToken,
	processIsZombie,
} from "../../core/process-identity.js";
import { tryWithStateFileLockSync, withStateFileLockSync } from "../../core/state-file-lock.js";
import { isStorePath, storeGrantBoundaries } from "../../core/store-paths.js";
import { clioStateDir } from "../../core/xdg.js";
import { atomicWrite } from "../../engine/session.js";
import type { AgentSpec } from "../agents/spec.js";
import type { DispatchRequest } from "./contract.js";
import { withDispatchIntentWriteRoots } from "./intent.js";
import { isLeaseInstant, LEASE_HEARTBEAT_MS, leaseLapsed, leaseRenewal } from "./lease-clock.js";

// ---------------------------------------------------------------------------------------------------------------------
// Write roots

/** A request's declared write roots, canonical and resolved against its cwd; empty when it declared none. */
export function canonicalWriteRoots(request: Pick<DispatchRequest, "cwd" | "writeRoots" | "intent">): string[] {
	return (request.writeRoots ?? request.intent?.writeRoots ?? []).map((root) =>
		canonicalizeExistingPath(resolve(request.cwd ?? process.cwd(), root)),
	);
}

/**
 * True when a root on one side contains, or is contained by, a root on the other.
 * Store directories never overlap: a put is atomic and its record write-once,
 * so two writers granted one tag both land (M-31, D-MCP 4.6).
 */
export function writeRootsOverlap(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
	const l = left.filter((root) => !isStorePath(root));
	const r = right.filter((root) => !isStorePath(root));
	const contains = (parent: string, child: string) => {
		const rel = relative(parent, child);
		return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
	};
	return l.some((a) => r.some((b) => contains(a, b) || contains(b, a)));
}

/**
 * A warning naming every pair of tasks in one parallel call whose declared
 * write roots overlap (equal, or one inside the other), or null when none do.
 * Admission still starts them; each task worktree merges back on its own, so
 * overlapping roots can collide at merge time.
 */
export function overlappingWriteRootsWarning(
	requests: ReadonlyArray<Pick<DispatchRequest, "agentId" | "cwd" | "writeRoots" | "intent">>,
	positions?: ReadonlyArray<number>,
): string | null {
	const roots = requests.map((request) => canonicalWriteRoots(request).filter((root) => !isStorePath(root)));
	const label = (index: number) => `task ${positions?.[index] ?? index + 1} (${requests[index]?.agentId})`;
	const lines: string[] = [];
	for (let i = 0; i < requests.length; i++)
		for (let j = i + 1; j < requests.length; j++) {
			const left = roots[i] ?? [];
			const right = roots[j] ?? [];
			const shared = left.flatMap((a) =>
				right.filter((b) => writeRootsOverlap([a], [b])).map((b) => (a === b ? a : `${a} ~ ${b}`)),
			);
			if (shared.length > 0) lines.push(`${label(i)} and ${label(j)}: ${shared.join(", ")}`);
		}
	if (lines.length === 0) return null;
	const list = lines.map((line) => `- ${line}`).join("\n");
	return `warning: parallel tasks declare overlapping intent.write_roots; their changes may conflict:\n${list}`;
}

function isWriter(request: DispatchRequest, classes: ReadonlyMap<string, AgentSpec["capabilityClass"]>): boolean {
	return request.worktree !== true && request.readOnly !== true && classes.get(request.agentId) !== "read-only";
}

/**
 * Admit a parallel batch that `writerSetConflict` refuses only because
 * writers holding a store grant declared no write roots. Store writes are not
 * workspace writes, so each such writer is confined to its granted store
 * directories, which never overlap. Requests are rewritten in place only when
 * that clears the conflict; otherwise nothing changes and the original refusal
 * stands. Returns true when the batch was confined.
 */
export function confineGrantOnlyWriters(requests: DispatchRequest[], specs: ReadonlyArray<AgentSpec>): boolean {
	const classes = new Map(specs.map((spec) => [spec.id, spec.capabilityClass]));
	const confined = requests.map((request): DispatchRequest => {
		const tags = request.storeTags ?? [];
		if (!isWriter(request, classes) || tags.length === 0 || canonicalWriteRoots(request).length > 0) return request;
		const roots = storeGrantBoundaries(request.cwd ?? process.cwd(), tags);
		return request.intent !== undefined
			? { ...request, intent: withDispatchIntentWriteRoots(request.intent, roots) }
			: { ...request, writeRoots: roots };
	});
	if (confined.every((request, index) => request === requests[index])) return false;
	if (writerSetConflict(confined, specs) !== null) return false;
	for (const [index, request] of confined.entries()) requests[index] = request;
	return true;
}

/**
 * The members one dispatch call puts in its writer set must have disjoint declared write roots or their own
 * worktrees; null when they do. This is the one writer refusal left: a set that can never be valid.
 */
export function writerSetConflict(
	requests: ReadonlyArray<DispatchRequest>,
	specs: ReadonlyArray<AgentSpec>,
): string | null {
	const classes = new Map(specs.map((spec) => [spec.id, spec.capabilityClass]));
	const readOnlyIds = specs
		.filter((spec) => spec.capabilityClass === "read-only" && spec.audience !== "internal")
		.map((spec) => spec.id);
	const inspection =
		readOnlyIds.length > 0
			? `For inspection or review, dispatch read-only recipes instead: ${readOnlyIds.join(", ")}.`
			: "For inspection, choose read-only recipes from dispatch(list: true).";
	const writers = requests.filter((request) => isWriter(request, classes));
	const roots = writers.map(canonicalWriteRoots);
	for (let i = 0; i < writers.length; i++)
		for (let j = i + 1; j < writers.length; j++) {
			const left = roots[i] ?? [];
			const right = roots[j] ?? [];
			if (!left.length || !right.length || writeRootsOverlap(left, right)) {
				return `writer_set_conflict: ${writers[i]?.agentId} and ${writers[j]?.agentId} have overlapping or undeclared write roots, and members of one writer set need disjoint roots or their own worktrees. ${inspection} For authorized writes, use worktree: true, declare disjoint intent.write_roots, or serialize writers with writers: 1. Declared write roots withhold bash and verify from a writer unless a bwrap sandbox confines its writes; worktree: true keeps both.`;
			}
		}
	return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The checkout's writer set

export interface WriterSetRecord {
	version: 2;
	checkout: string;
	host: string;
	pid: number;
	processBirthToken: string;
	acquiredAt: string;
	/** The owner's last renewal and how long it holds, by the owner's wall clock (`lease-clock.ts`). */
	heartbeatAt: string;
	expiresAt: string;
}

/** How often a queued join looks again when nothing in this process woke it first. */
const WRITER_SET_POLL_MS = 1_000;

/** One member of this process's writer set. */
export interface WriterSetMember {
	/** Requests of one dispatch call, and their retries, share a group and never wait on each other. */
	group: string;
	/** Canonical declared write roots; null when the request declared none. */
	roots: ReadonlyArray<string> | null;
	/** A worktree run edits its own checkout, so it never shares the source checkout's set. */
	isolated: boolean;
	agentId: string;
	runId?: string;
	/**
	 * A fleet run holds the checkout's record for its whole run. Its own steps are writers of this process, so it
	 * waits only on another fleet, never on a writer here.
	 */
	fleet?: true;
}

export interface WriterSetLease {
	checkout: string;
	path: string;
	/** Name the run that holds this membership once dispatch has assigned its id. */
	bindRun(runId: string): void;
	release(): void;
}

export interface WriterSetProbe {
	birthToken(pid: number): string | null;
	tokenProvesDeath?: boolean;
	alive?(pid: number): boolean;
	/** True when the pid exited but was not reaped, so it holds nothing despite answering signals. */
	zombie?(pid: number): boolean;
	/** This host's name; defaults to os.hostname(). */
	host?: string;
}

/** A join that waited for the checkout's writer set until its run's deadline passed or its caller stopped it. */
export class WriterSetBusyError extends Error {
	readonly checkout: string;
	constructor(message: string, checkout: string) {
		super(message);
		this.name = "WriterSetBusyError";
		this.checkout = checkout;
	}
}

const held = new Map<
	string,
	{ count: number; path: string; members: Set<WriterSetMember>; stopHeartbeat: () => void }
>();
/** Joins of this process waiting on a set; each release wakes them to look again. */
const waiters = new Set<() => void>();
let exitHooksInstalled = false;

function wakeWaiters(): void {
	for (const wake of [...waiters]) wake();
}

/** The checkout as the record names it; callers pass the checkout root (the git top level where there is one). */
function canonicalCheckout(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function writerSetPath(checkout: string): string {
	const key = createHash("sha256").update(checkout, "utf8").digest("hex");
	return join(clioStateDir(), "checkout-writer-leases", `${key}.json`);
}

function validRecord(value: unknown): value is WriterSetRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Partial<WriterSetRecord>;
	return (
		record.version === 2 &&
		typeof record.checkout === "string" &&
		typeof record.host === "string" &&
		Number.isSafeInteger(record.pid) &&
		(record.pid ?? 0) > 0 &&
		typeof record.processBirthToken === "string" &&
		isLeaseInstant(record.acquiredAt) &&
		isLeaseInstant(record.heartbeatAt) &&
		isLeaseInstant(record.expiresAt)
	);
}

function readRecord(path: string): WriterSetRecord | null {
	if (!existsSync(path)) return null;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!validRecord(value)) throw new Error("invalid schema");
		return value;
	} catch (error) {
		throw new Error(
			`writer set record is unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}; remove it once no CLIO Coder process writes in that checkout`,
		);
	}
}

function ownerAlive(record: WriterSetRecord, probe: WriterSetProbe, nowMs: number): boolean {
	// Another host's pid cannot be probed from here: its owner stays live until its lease lapses (#439).
	if (record.host !== (probe.host ?? hostname())) return !leaseLapsed(record.expiresAt, nowMs, true);
	if (probe.zombie?.(record.pid) === true) return false;
	const current = probe.birthToken(record.pid);
	// A different birth token is a different process on a reused pid.
	if (current === null || current !== record.processBirthToken) return false;
	// Where the token cannot tell a reused pid from the owner, only a live pid with an unlapsed lease holds.
	if (probe.tokenProvesDeath === false)
		return (probe.alive?.(record.pid) ?? false) && !leaseLapsed(record.expiresAt, nowMs, false);
	return true;
}

const defaultProbe: WriterSetProbe = {
	birthToken: processBirthToken,
	tokenProvesDeath: BIRTH_TOKEN_SOURCE_AVAILABLE,
	alive: processAlive,
	zombie: processIsZombie,
};

/** Renew the record while this process owns it; a contended beat is skipped and the next lands inside the TTL. */
function startHeartbeat(path: string, checkout: string, pid: number, token: string): () => void {
	const timer = setInterval(() => {
		try {
			tryWithStateFileLockSync(path, () => {
				const record = readRecord(path);
				if (record?.checkout !== checkout || record.pid !== pid || record.processBirthToken !== token) return;
				if (record.host !== hostname()) return;
				atomicWrite(path, JSON.stringify({ ...record, ...leaseRenewal(Date.now()) }, null, 2));
			});
		} catch {
			// A failed beat is retried on the next tick; only a long run of them lets the record lapse.
		}
	}, LEASE_HEARTBEAT_MS);
	timer.unref();
	return () => clearInterval(timer);
}

function releaseAllOnExit(): void {
	for (const [checkout, entry] of held) {
		entry.stopHeartbeat();
		try {
			withStateFileLockSync(entry.path, () => {
				const record = readRecord(entry.path);
				if (record?.checkout === checkout && record.pid === process.pid) unlinkSync(entry.path);
			});
		} catch {
			// Process exit is best effort. A stale record is taken over by the next join.
		}
	}
	held.clear();
}

function installExitHooks(): void {
	if (exitHooksInstalled) return;
	exitHooksInstalled = true;
	process.once("exit", releaseAllOnExit);
}

function membersConflict(existing: WriterSetMember, incoming: WriterSetMember): boolean {
	if (existing.group === incoming.group) return false;
	if (existing.fleet === true || incoming.fleet === true) return existing.fleet === true && incoming.fleet === true;
	if (existing.isolated || incoming.isolated) return false;
	return existing.roots === null || incoming.roots === null || writeRootsOverlap(existing.roots, incoming.roots);
}

function describeMember(member: WriterSetMember): string {
	const roots = member.roots === null ? "undeclared roots" : `roots ${member.roots.join(", ")}`;
	return member.fleet === true
		? `fleet ${member.runId ?? member.group}`
		: `run ${member.runId ?? "unknown"} (${member.agentId}, ${roots})`;
}

function releaseRecord(path: string, checkout: string, pid: number, token: string): void {
	withStateFileLockSync(path, () => {
		const record = readRecord(path);
		if (record?.checkout === checkout && record.pid === pid && record.processBirthToken === token) unlinkSync(path);
	});
}

function releaseMembership(checkout: string): void {
	const entry = held.get(checkout);
	if (entry === undefined) return;
	entry.count -= 1;
	if (entry.count > 0) return;
	held.delete(checkout);
	entry.stopHeartbeat();
	const token = processBirthToken(process.pid);
	try {
		if (token !== null) releaseRecord(entry.path, checkout, process.pid, token);
	} finally {
		wakeWaiters();
	}
}

interface JoinInput {
	checkout: string;
	member?: WriterSetMember;
	pid?: number;
	processBirthToken?: string;
	probe?: WriterSetProbe;
}

type JoinAttempt = { lease: WriterSetLease } | { waitingOn: string };

/** Join now, or say what the join waits on. */
function tryJoin(input: JoinInput, checkout: string, path: string): JoinAttempt {
	const member = input.member === undefined ? undefined : { ...input.member };
	// The record is exclusive, so a run that writes nothing never takes it (#420).
	if (member === undefined) return { lease: { checkout, path, bindRun: () => {}, release: () => {} } };
	const bindRun = (runId: string): void => {
		member.runId = runId;
	};
	const local = held.get(checkout);
	if (local !== undefined && (input.pid === undefined || input.pid === process.pid)) {
		for (const existing of local.members)
			if (membersConflict(existing, member)) return { waitingOn: `${describeMember(existing)} in this process` };
		local.members.add(member);
		local.count += 1;
		let released = false;
		return {
			lease: {
				checkout,
				path,
				bindRun,
				release: () => {
					if (released) return;
					released = true;
					local.members.delete(member);
					releaseMembership(checkout);
				},
			},
		};
	}
	mkdirSync(dirname(path), { recursive: true });
	const ownerPid = input.pid ?? process.pid;
	const token = input.processBirthToken ?? processBirthToken(ownerPid);
	if (token === null) throw new Error("dispatch: cannot establish the writer set owner's process birth token");
	const waitingOn = withStateFileLockSync(path, (): string | null => {
		const nowMs = Date.now();
		const existing = readRecord(path);
		if (existing !== null && ownerAlive(existing, input.probe ?? defaultProbe, nowMs)) {
			const where = existing.host !== hostname() ? ` on host ${existing.host}` : "";
			return `the writer set of pid ${existing.pid}${where}`;
		}
		const renewal = leaseRenewal(nowMs);
		const record: WriterSetRecord = {
			version: 2,
			checkout,
			host: hostname(),
			pid: ownerPid,
			processBirthToken: token,
			acquiredAt: renewal.heartbeatAt,
			...renewal,
		};
		atomicWrite(path, JSON.stringify(record, null, 2));
		return null;
	});
	if (waitingOn !== null) return { waitingOn };
	const stopHeartbeat = startHeartbeat(path, checkout, ownerPid, token);
	const entry =
		ownerPid === process.pid ? { count: 1, path, members: new Set<WriterSetMember>([member]), stopHeartbeat } : undefined;
	if (entry !== undefined) {
		held.set(checkout, entry);
		installExitHooks();
	}
	let released = false;
	return {
		lease: {
			checkout,
			path,
			bindRun,
			release: () => {
				if (released) return;
				released = true;
				entry?.members.delete(member);
				if (ownerPid === process.pid) releaseMembership(checkout);
				else {
					stopHeartbeat();
					releaseRecord(path, checkout, ownerPid, token);
				}
			},
		},
	};
}

/**
 * Join the checkout's writer set. A member that would overlap a live set waits for it to empty, waking on every
 * release in this process and polling the record for other processes, until `deadlineAt` (a wall-clock instant, the
 * run's sealed deadline) passes or `signal` aborts; then it throws `WriterSetBusyError`. The wait itself is a span in
 * this process, so it runs on the monotonic clock from the deadline's distance at entry. `onQueued` is told once what
 * the join waits on.
 */
export async function joinWriterSet(
	input: JoinInput & {
		deadlineAt?: number;
		signal?: AbortSignal;
		pollMs?: number;
		onQueued?: (waitingOn: string) => void;
	},
): Promise<WriterSetLease> {
	const checkout = canonicalCheckout(input.checkout);
	const path = writerSetPath(checkout);
	const startedAt = performance.now();
	const deadline =
		input.deadlineAt === undefined ? Number.POSITIVE_INFINITY : startedAt + (input.deadlineAt - Date.now());
	let queued = false;
	for (;;) {
		input.signal?.throwIfAborted();
		const attempt = tryJoin(input, checkout, path);
		if ("lease" in attempt) return attempt.lease;
		const agent = input.member?.agentId ?? "writer";
		if (!queued) {
			queued = true;
			input.onQueued?.(attempt.waitingOn);
		}
		const remaining = deadline - performance.now();
		if (remaining <= 0) {
			throw new WriterSetBusyError(
				`writer_set_busy: ${agent} waited ${Math.round((performance.now() - startedAt) / 1000)} s for ${attempt.waitingOn} to finish writing in ${checkout}, and its run's deadline passed first. Wait for that work to settle, declare disjoint intent.write_roots, or use worktree: true.`,
				checkout,
			);
		}
		await new Promise<void>((resolveWait) => {
			const done = (): void => {
				clearTimeout(timer);
				waiters.delete(done);
				input.signal?.removeEventListener("abort", done);
				resolveWait();
			};
			const timer = setTimeout(done, Math.min(remaining, input.pollMs ?? WRITER_SET_POLL_MS));
			waiters.add(done);
			input.signal?.addEventListener("abort", done, { once: true });
		});
	}
}
