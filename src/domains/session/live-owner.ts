import { hostname } from "node:os";
import { processAlive, processBirthToken } from "../../core/process-identity.js";
import type { ClioSessionOwner } from "../../engine/session.js";
import type { SessionMeta } from "./contract.js";

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
