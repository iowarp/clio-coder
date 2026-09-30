import { readFileSync } from "node:fs";

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
