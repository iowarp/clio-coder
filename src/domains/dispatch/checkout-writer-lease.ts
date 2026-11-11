import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import {
	BIRTH_TOKEN_SOURCE_AVAILABLE,
	processAlive,
	processBirthToken,
	processIsZombie,
} from "../../core/process-identity.js";
import { tryWithStateFileLockSync, withStateFileLockSync } from "../../core/state-file-lock.js";
import { clioStateDir } from "../../core/xdg.js";
import { atomicWrite } from "../../engine/session.js";
import { writeRootsOverlap } from "./parallel-writers.js";

export interface CheckoutWriterLeaseRecord {
	version: 1;
	checkout: string;
	/** Host of the holder; absent in records written before hosts were recorded, which read as this host. */
	host?: string;
	pid: number;
	processBirthToken: string;
	acquiredAt: string;
	/**
	 * When the holder last proved it still runs, and how long that proof lasts. Absent in records written before
	 * holders heartbeat; such a record is judged by its pid alone, and another host's is honored indefinitely.
	 */
	heartbeatAt?: string;
	heartbeatExpiresMs?: number;
}

/**
 * How often a holder refreshes its record, and how long a refresh stays good. The expiry spans several missed beats
 * and absorbs clock skew between hosts sharing the state directory well short of it.
 */
export const CHECKOUT_WRITER_LEASE_HEARTBEAT_MS = 15_000;
export const CHECKOUT_WRITER_LEASE_EXPIRY_MS = 120_000;

/**
 * One writer holding the lease inside this process. The pid record excludes
 * other processes; holders let the reentrant path refuse a writer from another
 * dispatch call that would share the checkout with a live one, such as a
 * foreground writer started while a detached writer still runs there.
 */
export interface CheckoutWriterHolder {
	/** Requests of one dispatch call, and their retries, share a group and never refuse each other. */
	group: string;
	/** Canonical declared write roots; null when the request declared none. */
	roots: ReadonlyArray<string> | null;
	/** A worktree run edits its own checkout, so it never conflicts on the source checkout. */
	isolated: boolean;
	agentId: string;
	runId?: string;
}

export interface CheckoutWriterLease {
	checkout: string;
	path: string;
	/** Name the run that holds this lease once dispatch has assigned its id. */
	bindRun(runId: string): void;
	release(): void;
}

export interface CheckoutWriterLeaseProbe {
	birthToken(pid: number): string | null;
	tokenProvesDeath?: boolean;
	alive?(pid: number): boolean;
	/** True when the pid exited but was not reaped, so it holds nothing despite answering signals. */
	zombie?(pid: number): boolean;
	/** This host's name; defaults to os.hostname(). */
	host?: string;
}

const held = new Map<
	string,
	{ count: number; path: string; holders: Set<CheckoutWriterHolder>; stopHeartbeat: () => void }
>();
let exitHooksInstalled = false;

function canonicalCheckout(checkout: string): string {
	return realpathSync(checkout);
}

function checkoutWriterLeasePath(checkout: string): string {
	const canonical = canonicalCheckout(checkout);
	const key = createHash("sha256").update(canonical, "utf8").digest("hex");
	return join(clioStateDir(), "checkout-writer-leases", `${key}.json`);
}

function validRecord(value: unknown): value is CheckoutWriterLeaseRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Partial<CheckoutWriterLeaseRecord>;
	return (
		record.version === 1 &&
		typeof record.checkout === "string" &&
		(record.host === undefined || typeof record.host === "string") &&
		Number.isSafeInteger(record.pid) &&
		(record.pid ?? 0) > 0 &&
		typeof record.processBirthToken === "string" &&
		typeof record.acquiredAt === "string" &&
		Number.isFinite(Date.parse(record.acquiredAt)) &&
		(record.heartbeatAt === undefined ||
			(typeof record.heartbeatAt === "string" && Number.isFinite(Date.parse(record.heartbeatAt)))) &&
		(record.heartbeatExpiresMs === undefined ||
			(Number.isSafeInteger(record.heartbeatExpiresMs) && (record.heartbeatExpiresMs ?? 0) > 0))
	);
}

function readRecord(path: string): CheckoutWriterLeaseRecord | null {
	if (!existsSync(path)) return null;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!validRecord(value)) throw new Error("invalid schema");
		return value;
	} catch (error) {
		throw new Error(
			`checkout writer lease is unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** True when the record carries a heartbeat that has lapsed; a record without one never reads as expired. */
function heartbeatExpired(record: CheckoutWriterLeaseRecord, nowMs: number): boolean {
	if (record.heartbeatAt === undefined || record.heartbeatExpiresMs === undefined) return false;
	// A beat stamped ahead of this clock is skew, not age, so it reads as fresh.
	return nowMs - Date.parse(record.heartbeatAt) > record.heartbeatExpiresMs;
}

function ownerAlive(record: CheckoutWriterLeaseRecord, probe: CheckoutWriterLeaseProbe, nowMs: number): boolean {
	// Another host's pid cannot be probed from here, so no local pid check judges it (#439): its holder stays live
	// until its heartbeat lapses, and a record that carries none stays live.
	if (record.host !== undefined && record.host !== (probe.host ?? hostname())) return !heartbeatExpired(record, nowMs);
	if (probe.zombie?.(record.pid) === true) return false;
	const current = probe.birthToken(record.pid);
	// A different birth token is a different process on a reused pid.
	if (current === null || current !== record.processBirthToken) return false;
	// Where the token cannot tell a reused pid from the holder, a live pid proves nothing on its own: the holder's
	// lapsed heartbeat shows it is gone.
	if (probe.tokenProvesDeath === false) return (probe.alive?.(record.pid) ?? false) && !heartbeatExpired(record, nowMs);
	return true;
}

const defaultProbe: CheckoutWriterLeaseProbe = {
	birthToken: processBirthToken,
	tokenProvesDeath: BIRTH_TOKEN_SOURCE_AVAILABLE,
	alive: processAlive,
	zombie: processIsZombie,
};

/**
 * Refresh the record while this process holds it. A beat never waits on the record's lock: a contended beat is
 * skipped and the next one lands well inside the expiry.
 */
function startHeartbeat(path: string, checkout: string, pid: number, token: string): () => void {
	const timer = setInterval(() => {
		try {
			tryWithStateFileLockSync(path, () => {
				const record = readRecord(path);
				if (record?.checkout !== checkout || record.pid !== pid || record.processBirthToken !== token) return;
				if (record.host !== undefined && record.host !== hostname()) return;
				atomicWrite(path, JSON.stringify({ ...record, heartbeatAt: new Date().toISOString() }, null, 2));
			});
		} catch {
			// A failed beat is retried on the next tick; only a long run of them lets the lease lapse.
		}
	}, CHECKOUT_WRITER_LEASE_HEARTBEAT_MS);
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
			// Process exit is best effort. A stale record is reclaimed by the next admission.
		}
	}
	held.clear();
}

function installExitHooks(): void {
	if (exitHooksInstalled) return;
	exitHooksInstalled = true;
	process.once("exit", releaseAllOnExit);
}

function holdersConflict(existing: CheckoutWriterHolder, incoming: CheckoutWriterHolder): boolean {
	if (existing.isolated || incoming.isolated || existing.group === incoming.group) return false;
	return existing.roots === null || incoming.roots === null || writeRootsOverlap(existing.roots, incoming.roots);
}

function writerConflictMessage(
	checkout: string,
	existing: CheckoutWriterHolder,
	incoming: CheckoutWriterHolder,
	operatorStarted = false,
): string {
	const roots = (value: ReadonlyArray<string> | null): string => (value === null ? "undeclared" : value.join(", "));
	const runId = existing.runId ?? "unknown";
	// A person reads this one: the monitor call and dispatch fields below are the model's remedy, not theirs.
	if (operatorStarted) {
		return `${incoming.agentId} cannot write in this checkout yet: ${existing.agentId} (run ${runId}) is still writing here. Wait for it, cancel it from /fleet, or start this one with --worktree.`;
	}
	return `checkout_writer_conflict: ${incoming.agentId} would write ${checkout} while run ${runId} (${existing.agentId}, started by an earlier dispatch call) is still live there; its write roots are ${roots(existing.roots)}, this request's are ${roots(incoming.roots)}. Wait for it with monitor(mode="wait", run_id="${runId}"), declare disjoint intent.write_roots on both dispatches, or use worktree: true.`;
}

/**
 * Take the checkout's writer lease. A request without a holder, such as a
 * read-only run, writes nothing, so it neither refuses another writer nor is
 * refused. Overlap refuses and never queues: a detached writer refuses
 * timeout_ms, so a foreground writer serialized behind it could wait without limit.
 */
export function acquireCheckoutWriterLease(input: {
	checkout: string;
	holder?: CheckoutWriterHolder;
	/** The person started this run, so a refusal speaks to them rather than to the model. */
	operatorStarted?: boolean;
	nowMs?: number;
	pid?: number;
	processBirthToken?: string;
	probe?: CheckoutWriterLeaseProbe;
}): CheckoutWriterLease {
	const checkout = canonicalCheckout(input.checkout);
	const path = checkoutWriterLeasePath(checkout);
	// The cross-process record below is exclusive, so a holderless request never takes it (#420).
	if (input.holder === undefined) return { checkout, path, bindRun: () => {}, release: () => {} };
	const holder = { ...input.holder };
	const bindRun = (runId: string): void => {
		holder.runId = runId;
	};
	const local = held.get(checkout);
	if (local !== undefined && (input.pid === undefined || input.pid === process.pid)) {
		for (const existing of local.holders) {
			if (holdersConflict(existing, holder))
				throw new Error(writerConflictMessage(checkout, existing, holder, input.operatorStarted === true));
		}
		local.holders.add(holder);
		local.count += 1;
		let released = false;
		return {
			checkout,
			path,
			bindRun,
			release: () => {
				if (released) return;
				released = true;
				local.holders.delete(holder);
				releaseCheckoutWriterLease(checkout);
			},
		};
	}
	mkdirSync(dirname(path), { recursive: true });
	const ownerPid = input.pid ?? process.pid;
	const token = input.processBirthToken ?? processBirthToken(ownerPid);
	if (token === null) throw new Error("dispatch: cannot establish checkout writer process birth token");
	const nowMs = input.nowMs ?? Date.now();
	withStateFileLockSync(path, () => {
		const existing = readRecord(path);
		if (existing !== null && ownerAlive(existing, input.probe ?? defaultProbe, nowMs)) {
			const where = existing.host !== undefined && existing.host !== hostname() ? ` on host ${existing.host}` : "";
			throw new Error(`checkout_writer_lease_held: checkout writer lease is held by pid ${existing.pid}${where}`);
		}
		const record: CheckoutWriterLeaseRecord = {
			version: 1,
			checkout,
			host: hostname(),
			pid: ownerPid,
			processBirthToken: token,
			acquiredAt: new Date(nowMs).toISOString(),
			heartbeatAt: new Date(nowMs).toISOString(),
			heartbeatExpiresMs: CHECKOUT_WRITER_LEASE_EXPIRY_MS,
		};
		atomicWrite(path, JSON.stringify(record, null, 2));
	});
	const stopHeartbeat = startHeartbeat(path, checkout, ownerPid, token);
	const entry =
		ownerPid === process.pid
			? { count: 1, path, holders: new Set<CheckoutWriterHolder>([holder]), stopHeartbeat }
			: undefined;
	if (entry !== undefined) {
		held.set(checkout, entry);
		installExitHooks();
	}
	let released = false;
	return {
		checkout,
		path,
		bindRun,
		release: () => {
			if (released) return;
			released = true;
			entry?.holders.delete(holder);
			if (ownerPid === process.pid) releaseCheckoutWriterLease(checkout);
			else {
				stopHeartbeat();
				releaseLeaseRecord(path, checkout, ownerPid, token);
			}
		},
	};
}

function releaseLeaseRecord(path: string, checkout: string, pid: number, token: string): void {
	withStateFileLockSync(path, () => {
		const record = readRecord(path);
		if (record?.checkout === checkout && record.pid === pid && record.processBirthToken === token) unlinkSync(path);
	});
}

function releaseCheckoutWriterLease(checkout: string): void {
	const entry = held.get(checkout);
	if (entry === undefined) return;
	entry.count -= 1;
	if (entry.count > 0) return;
	held.delete(checkout);
	entry.stopHeartbeat();
	const token = processBirthToken(process.pid);
	if (token !== null) releaseLeaseRecord(entry.path, checkout, process.pid, token);
}
