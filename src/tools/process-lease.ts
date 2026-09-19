/**
 * A durable claim's proof of which process owns it, shared by the compete
 * groups and the task worktrees. The lease names the host, the PID, and a
 * PID-reuse-resistant birth token, so restart recovery can tell a dead owner
 * from a live one and from an unrelated process that inherited the PID.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

export interface ProcessLease {
	host: string;
	pid: number;
	birthToken: string | null;
}

export interface ProcessSnapshot {
	alive: boolean;
	birthToken: string | null;
}

/**
 * Return a PID-reuse-resistant process identity where the host exposes one.
 * Linux's kernel start ticks are stable for the lifetime of a process. The
 * portable fallback uses `ps` start time; if neither is available we retain
 * liveness but refuse to signal a live PID during restart recovery.
 */
export function processSnapshot(pid: number): ProcessSnapshot {
	if (!Number.isSafeInteger(pid) || pid <= 0) return { alive: false, birthToken: null };
	try {
		process.kill(pid, 0);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EPERM") return { alive: false, birthToken: null };
	}

	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
		const close = stat.lastIndexOf(")");
		if (close > 0) {
			// Fields after the command name start at kernel field 3. Field 3 is
			// process state and field 22 (index 19 here) is starttime in ticks.
			const fields = stat
				.slice(close + 1)
				.trim()
				.split(/\s+/u);
			if (fields[0] === "Z") return { alive: false, birthToken: fields[19] ?? null };
			const startTicks = fields[19];
			if (startTicks !== undefined && /^\d+$/u.test(startTicks)) {
				return { alive: true, birthToken: `linux:${startTicks}` };
			}
		}
	} catch {
		// Non-Linux host or procfs unavailable; try the portable fallback.
	}

	try {
		const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
		}).trim();
		if (started.length > 0) return { alive: true, birthToken: `ps:${started}` };
	} catch {
		// The PID exists, but it cannot be identified strongly enough to kill.
	}
	return { alive: true, birthToken: null };
}

export function currentProcessLease(): ProcessLease {
	return {
		host: hostname(),
		pid: process.pid,
		birthToken: processSnapshot(process.pid).birthToken,
	};
}

export function validProcessLease(value: unknown): value is ProcessLease {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const lease = value as Record<string, unknown>;
	return (
		typeof lease.host === "string" &&
		lease.host.length > 0 &&
		typeof lease.pid === "number" &&
		Number.isSafeInteger(lease.pid) &&
		lease.pid > 0 &&
		(lease.birthToken === null || typeof lease.birthToken === "string")
	);
}

export function ownerIsAlive(owner: ProcessLease): boolean {
	if (owner.host !== hostname()) return true;
	const snapshot = processSnapshot(owner.pid);
	if (!snapshot.alive) return false;
	// A null identity cannot distinguish PID reuse, so preserving is the only
	// safe choice. Supported hosts normally provide a token above.
	if (owner.birthToken === null || snapshot.birthToken === null) return true;
	return owner.birthToken === snapshot.birthToken;
}
