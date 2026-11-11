import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";

/**
 * Process identity for durable owner records. A pid alone cannot tell "the
 * holder is gone" from "the pid was reused", so records carry the owner's birth
 * token as well; every adjudicator in the tree reads it from here.
 */

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
export const BIRTH_TOKEN_SOURCE_AVAILABLE = readProcStartTime(process.pid) !== null;

export function processBirthToken(pid = process.pid): string | null {
	const started = readProcStartTime(pid);
	if (started !== null) return started;
	return BIRTH_TOKEN_SOURCE_AVAILABLE ? null : `pid-${pid}`;
}

/**
 * Wall-clock start of `pid` in epoch milliseconds, or null where /proc is not
 * available. Lets a caller that recorded only a pid and a timestamp tell a
 * process that existed at that time from one that reused the pid later.
 * Resolution is one clock tick plus the whole-second boot time, so callers
 * compare with a tolerance of about a second.
 */
export function processStartedAtMs(pid: number): number | null {
	const ticks = readProcStartTime(pid);
	if (ticks === null) return null;
	try {
		const btime = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1];
		if (btime === undefined) return null;
		// USER_HZ is 100 on every Linux ABI Node supports; /proc exposes no portable way to read it.
		return Number(btime) * 1000 + (Number(ticks) * 1000) / 100;
	} catch {
		// /proc/stat unreadable means the start time is unknown, which callers treat as unverifiable.
		return null;
	}
}

/** True when /proc shows `pid` exited and awaits reaping; such a process holds nothing. False where /proc is absent. */
export function processIsZombie(pid: number): boolean {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
		return state === "Z" || state === "X";
	} catch {
		return false;
	}
}

export function processAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the pid exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Whether the process a record names is still the one running: true while its pid lives with the same birth token,
 * false once it is gone or the pid was reused, and null for another host, which cannot be probed from here. A
 * missing token cannot disprove a live pid, the same call `liveSessionOwner` makes.
 */
export function processIdentityAlive(identity: {
	host: string;
	pid: number;
	birthToken: string | null;
}): boolean | null {
	if (identity.host !== hostname()) return null;
	if (!processAlive(identity.pid)) return false;
	if (identity.birthToken === null) return true;
	const current = processBirthToken(identity.pid);
	return current === null || current === identity.birthToken;
}

function readPidNamespace(pid: number | "self"): string | null {
	try {
		return readlinkSync(`/proc/${pid}/ns/pid`);
	} catch {
		return null;
	}
}

function readBootId(): string | null {
	try {
		return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
	} catch {
		return null;
	}
}

/**
 * This process's pid namespace (`pid:[<inode>]`) and the kernel's boot id, or null where /proc does not expose them.
 * A namespace inode is only meaningful within one boot, so the two travel together. Compare against our own
 * namespace, never a fixed "initial" one: WSL2 and Clio's own bwrap run every process in a non-initial namespace.
 */
export const PID_NAMESPACE = readPidNamespace("self");
export const BOOT_ID = readBootId();

/** The owner fields a durable record carries so another process can adjudicate it. */
export interface OwnerIdentity {
	host: string;
	pid: number;
	birthToken: string | null;
	pidNs: string | null;
	bootId: string | null;
}

export function ownerIdentity(): OwnerIdentity {
	return { host: hostname(), pid: process.pid, birthToken: processBirthToken(), pidNs: PID_NAMESPACE, bootId: BOOT_ID };
}

/** A recorded owner as a reader sees it; `host` null and absent `pidNs`/`bootId` are records from before those fields. */
export interface RecordedOwner {
	host: string | null;
	pid: number;
	birthToken: string | null;
	pidNs?: string | null;
	bootId?: string | null;
}

export type OwnerState = "alive" | "gone" | "unknown";

type ProcStatusReader = (pid: number) => string;

const readProcStatus: ProcStatusReader = (pid) => readFileSync(`/proc/${pid}/status`, "utf8");
let procStatusReader = readProcStatus;

/** Replace how `/proc/<pid>/status` is read, so a test can stand in for a kernel without NSpid; null restores it. */
export function setProcStatusReaderForTesting(reader: ProcStatusReader | null): void {
	procStatusReader = reader ?? readProcStatus;
	namespaceScans.clear();
}

interface NamespaceScan {
	visible: boolean;
	hostPid: number | null;
}

const NAMESPACE_SCAN_REUSE_MS = 1_000;
const namespaceScans = new Map<string, { scan: NamespaceScan; atMs: number }>();

/**
 * Find the process a record names in another pid namespace: a process here whose pid namespace is the recorded one
 * and whose innermost NSpid is the recorded pid. `visible` says whether a process of that namespace was seen with an
 * NSpid line, which is what lets a missing pid prove the owner gone. A parent or sibling namespace is never visible,
 * and neither is any namespace on a kernel without NSpid (before 4.1, as on EL7) or a member whose status cannot be
 * read: there a live owner and a dead one look the same.
 */
function scanNamespace(pidNs: string, pid: number): NamespaceScan {
	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return { visible: false, hostPid: null };
	}
	let visible = false;
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		if (readPidNamespace(Number(entry)) !== pidNs) continue;
		let nspid: string[] | undefined;
		try {
			nspid = /^NSpid:\s+(.+)$/m
				.exec(procStatusReader(Number(entry)))?.[1]
				?.trim()
				.split(/\s+/);
		} catch {
			// Exited between the readdir and the read, or not ours to read.
		}
		if (nspid === undefined) continue;
		visible = true;
		if (Number(nspid[nspid.length - 1]) === pid) return { visible, hostPid: Number(entry) };
	}
	return { visible, hostPid: null };
}

/**
 * A lock waiter asks about the same record on every poll and several times per attempt; a scan of /proc is reused
 * for a second, and only for a record carrying a birth token, so a reused pid writes a record that scans afresh. A
 * found host pid is still probed live by the caller.
 */
function findInNamespace(pidNs: string, pid: number, birthToken: string | null): NamespaceScan {
	if (birthToken === null) return scanNamespace(pidNs, pid);
	const key = `${pidNs} ${pid} ${birthToken}`;
	const now = performance.now();
	const cached = namespaceScans.get(key);
	if (cached !== undefined && now - cached.atMs < NAMESPACE_SCAN_REUSE_MS) return cached.scan;
	const scan = scanNamespace(pidNs, pid);
	if (namespaceScans.size >= 32) namespaceScans.clear();
	namespaceScans.set(key, { scan, atMs: now });
	return scan;
}

/**
 * Whether a recorded owner still runs: `alive`, `gone`, or `unknown` when it cannot be probed from here. Another host
 * is unknown. On this host a record from another boot is gone. A record from our own pid namespace, or one written
 * before the namespace was recorded, takes the pid and birth-token probe. A record from another namespace (an
 * Apptainer `--pid`/`--containall` container, or the host seen from inside one) is never judged by a local pid: its
 * pid is looked up inside that namespace when the namespace is visible here, and is unknown otherwise.
 */
export function ownerState(owner: RecordedOwner): OwnerState {
	if (owner.host !== null && owner.host !== hostname()) return "unknown";
	if (owner.bootId && BOOT_ID !== null && owner.bootId !== BOOT_ID) return "gone";
	let pid = owner.pid;
	if (owner.pidNs && PID_NAMESPACE !== null && owner.pidNs !== PID_NAMESPACE) {
		const found = findInNamespace(owner.pidNs, owner.pid, owner.birthToken);
		if (found.hostPid === null) return found.visible ? "gone" : "unknown";
		pid = found.hostPid;
	}
	if (!processAlive(pid)) return "gone";
	if (owner.birthToken === null) return "alive";
	const current = processBirthToken(pid);
	return current === null || current === owner.birthToken ? "alive" : "gone";
}

/** Whether a recorded owner is this very process: same host, pid and (when both are known) pid namespace. */
export function ownerIsThisProcess(owner: RecordedOwner): boolean {
	if (owner.pid !== process.pid || (owner.host !== null && owner.host !== hostname())) return false;
	return !owner.pidNs || PID_NAMESPACE === null || owner.pidNs === PID_NAMESPACE;
}
