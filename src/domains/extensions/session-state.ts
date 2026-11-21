/**
 * The per-session files extensions keep under the state directory follow the
 * session's lifecycle: a fork inherits the parent's pinned context blocks, and
 * removing a session removes its pinned blocks, its dock frame and taps, and
 * each extension's session key-value state and its open workspace. The session
 * domain calls these at its fork and delete seams, and a session host's startup
 * removes what sessions deleted without that seam left behind.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { safeResourceBackupPath, safeResourceWrite } from "../../core/safe-resource-write.js";
import { recordedSessionIds } from "../../engine/session.js";
import { extensionDockPaths } from "./dock-frame.js";
import { pinnedContextFile } from "./pinned-context.js";
import { extensionDataPaths } from "./runtime-state.js";
import { sessionWorkspaceFile, sessionWorkspacesDir } from "./workspace-session.js";

/**
 * Give a forked session the parent's current pinned blocks: they are the
 * extensions' state for this line of work, and the fork's copied transcript
 * still shows them. Best effort; a fork never fails over its pins.
 */
export function inheritPinnedContext(stateDir: string, parentSessionId: string, childSessionId: string): void {
	try {
		const source = pinnedContextFile(stateDir, parentSessionId);
		if (!existsSync(source)) return;
		safeResourceWrite(pinnedContextFile(stateDir, childSessionId), readFileSync(source, "utf8"));
	} catch {
		// The fork starts without pins, as it did before; the next hook that pins sets them again.
	}
}

/** Remove what extensions kept for a deleted session. Best effort; the session is already gone. */
export function forgetExtensionSessionState(stateDir: string, sessionId: string): void {
	const dock = extensionDockPaths(stateDir, sessionId);
	const files = [
		pinnedContextFile(stateDir, sessionId),
		dock.frameFile,
		dock.tapFile,
		sessionWorkspaceFile(stateDir, sessionId),
	];
	let extensionIds: string[] = [];
	try {
		extensionIds = readdirSync(path.join(stateDir, "extensions"), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
			.map((entry) => entry.name);
	} catch {
		// No extension has written state yet.
	}
	for (const extensionId of extensionIds) {
		const stateFile = extensionDataPaths(stateDir, extensionId, sessionId).stateFile;
		if (stateFile !== null) files.push(stateFile, safeResourceBackupPath(stateFile));
	}
	for (const file of files) {
		try {
			rmSync(file, { force: true });
		} catch {
			// An undeletable file stays; it is never read for another session.
		}
	}
}

/** A file named for a session: `<encoded session id>.json`, or the backup a write keeps beside it. */
const SESSION_FILE = /^(.+)\.json(?:\.bak)?$/u;

/**
 * Remove what extensions kept for sessions that no longer exist, found by the session-named files (each extension's
 * session values and the open workspace). Only an orphan goes: a recorded session keeps its state however old it is,
 * `keep` (the host's own session) keeps its state even before its directory exists, and nothing goes when the
 * sessions cannot be listed (C-35). Best effort.
 */
export function pruneOrphanedExtensionSessionState(stateDir: string, keep: string | null): void {
	const recorded = recordedSessionIds(stateDir);
	if (recorded === null) return;
	const dirs = [sessionWorkspacesDir(stateDir)];
	try {
		for (const entry of readdirSync(path.join(stateDir, "extensions"), { withFileTypes: true }))
			if (entry.isDirectory() && !entry.name.startsWith("."))
				dirs.push(path.join(stateDir, "extensions", entry.name, "sessions"));
	} catch {
		// No extension has written state yet.
	}
	const orphans = new Set<string>();
	for (const dir of dirs) {
		let names: string[] = [];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			const encoded = SESSION_FILE.exec(name)?.[1];
			if (encoded === undefined) continue;
			try {
				const id = decodeURIComponent(encoded);
				if (id !== keep && !recorded.has(id)) orphans.add(id);
			} catch {
				// Not a name this host wrote.
			}
		}
	}
	for (const id of orphans) forgetExtensionSessionState(stateDir, id);
}
