import { hostname } from "node:os";
import { processAlive, processBirthToken } from "../../core/process-identity.js";
import type { ClioSessionOwner } from "../../engine/session.js";
import type { SessionMeta } from "./contract.js";
import { formatAge, liveSessionView, ownerOnThisHost } from "./heartbeat.js";

/**
 * The process that holds this session's ledger open right now, or null. A ledger
 * that never ended but whose owner is gone is a crashed session and stays
 * resumable (#420). An owner on another host cannot be checked from here, so it
 * reads as live, the same call state-file-lock's ownerIsAlive makes.
 */
export function liveSessionOwner(meta: Pick<SessionMeta, "endedAt" | "owner">): ClioSessionOwner | null {
	const owner = meta.owner;
	if (meta.endedAt !== null || !owner || !Number.isSafeInteger(owner.pid)) return null;
	if (owner.host !== hostname()) return owner;
	if (!processAlive(owner.pid)) return null;
	if (owner.birth === null) return owner;
	const current = processBirthToken(owner.pid);
	return current === null || current === owner.birth ? owner : null;
}

/**
 * The owner the live registry names for this session when its heartbeat is fresh and it is another process
 * (#439). A run that has not stamped meta.json yet is visible only here; a stale beat or a pid gone on this host
 * owns nothing.
 */
export function registeredLiveOwner(sessionId: string, nowMs = Date.now()): ClioSessionOwner | null {
	const view = liveSessionView(sessionId, nowMs);
	if (view === null || view.stale || ownerOnThisHost(view) === "gone") return null;
	const { host, pid, birth } = view.record;
	if (host === hostname() && pid === process.pid) return null;
	return { host, pid, birth };
}

/** Who holds the session open, from its meta.json owner or its live record; null when nobody but this process does. */
export function sessionLiveOwner(meta: Pick<SessionMeta, "id" | "endedAt" | "owner">): ClioSessionOwner | null {
	const owner = liveSessionOwner(meta);
	if (owner && !(owner.host === hostname() && owner.pid === process.pid)) return owner;
	return registeredLiveOwner(meta.id);
}

/**
 * Why a resume is refused while `owner` holds the session. A foreign owner
 * cannot be probed, so its heartbeat age is the evidence (#439): a stale beat
 * points at the forced release, a fresh one at a terminate request. Plain
 * resume never steals either way.
 */
export function liveSessionRefusal(sessionId: string, owner: ClioSessionOwner, nowMs = Date.now()): string {
	const where = `pid ${owner.pid} on ${owner.host}`;
	if (owner.host === hostname()) return `session ${sessionId} is open in another process (${where}); end it there first`;
	const view = liveSessionView(sessionId, nowMs);
	if (view?.stale)
		return `session ${sessionId} is open in another process (${where}) whose heartbeat is stale ${formatAge(view.ageMs)}; run clio-coder session terminate ${sessionId} --force`;
	return `session ${sessionId} is open in another process (${where}); end it there first or run clio-coder session terminate ${sessionId}`;
}
