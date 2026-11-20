/**
 * Session verbs for a process that holds no session open: `clio-coder session rename|rm` (SPEC L3, 6.7). A fresh
 * CLI process cannot see another process's open session through the session domain, so every mutation checks the
 * owner in meta.json and the live registry first and refuses one held elsewhere.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { clioStateDir } from "../../core/xdg.js";
import {
	atomicWrite,
	type ClioSessionOwner,
	noteSessionDeleted,
	readSessionMeta,
	SESSION_FILE_MODE,
	sessionPaths,
} from "../../engine/session.js";
import type { SessionMeta } from "./contract.js";
import type { SessionInfoEntry } from "./entries.js";
import { sessionLiveOwner } from "./live-owner.js";
import { newTurnId } from "./manager.js";
import { appendEntryToSessionFile, removeSessionDirectory } from "./tree/manager.js";

/** Sessions whose `parentSessionId` names `sessionId`, in any workspace. */
function listSessionChildren(sessionId: string): string[] {
	const root = join(clioStateDir(), "sessions");
	if (!existsSync(root)) return [];
	const children: string[] = [];
	for (const bucket of readdirSync(root, { withFileTypes: true })) {
		if (!bucket.isDirectory()) continue;
		for (const session of readdirSync(join(root, bucket.name), { withFileTypes: true })) {
			if (!session.isDirectory()) continue;
			try {
				const meta = JSON.parse(readFileSync(join(root, bucket.name, session.name, "meta.json"), "utf8")) as {
					id?: unknown;
					parentSessionId?: unknown;
				};
				if (meta.parentSessionId === sessionId && typeof meta.id === "string") children.push(meta.id);
			} catch {
				// A missing or malformed meta.json (a removed session) names no parent.
			}
		}
	}
	return children.sort();
}

/**
 * Name a session at rest under its state lock. Returns the owner and writes nothing when another process holds
 * the session open; the name lands in the ledger and in meta.json together (#443).
 */
export function renameSessionAtRest(sessionId: string, name: string): ClioSessionOwner | null {
	const metaPath = sessionPaths(readSessionMeta(sessionId)).meta;
	return withStateFileLockSync(metaPath, () => {
		const meta = readSessionMeta(sessionId) as SessionMeta;
		const owner = sessionLiveOwner(meta);
		if (owner) return owner;
		const entry: SessionInfoEntry = {
			kind: "sessionInfo",
			turnId: newTurnId(),
			parentTurnId: null,
			timestamp: new Date().toISOString(),
			name,
		};
		appendEntryToSessionFile(sessionId, entry);
		const trimmed = name.trim();
		if (trimmed) meta.name = trimmed;
		else delete meta.name;
		atomicWrite(metaPath, JSON.stringify(meta, null, 2), SESSION_FILE_MODE);
		return null;
	});
}

export type SessionRemovalRefusal =
	| { readonly kind: "live"; readonly owner: ClioSessionOwner }
	| { readonly kind: "children"; readonly children: ReadonlyArray<string> };

/** Why `session rm` must not remove this session: a live owner, then forks that name it as parent. */
export function sessionRemovalRefusal(sessionId: string): SessionRemovalRefusal | null {
	const owner = sessionLiveOwner(readSessionMeta(sessionId));
	if (owner) return { kind: "live", owner };
	const children = listSessionChildren(sessionId);
	return children.length > 0 ? { kind: "children", children } : null;
}

/**
 * Remove a session at rest. The tombstone runs under the session's state lock and re-checks the meta.json owner,
 * so a resume that claimed the session after {@link sessionRemovalRefusal} read it still wins. A session that never
 * ended (a crashed run) is refused there too and throws; nothing is announced as deleted until the removal lands.
 */
export function removeSessionAtRest(sessionId: string): void {
	removeSessionDirectory(sessionId);
	noteSessionDeleted(sessionId);
}
