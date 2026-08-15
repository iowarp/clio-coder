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
