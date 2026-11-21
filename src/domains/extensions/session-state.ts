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
import { recordedSessionIds, sessionRecorded } from "../../engine/session.js";
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
/** A pinned-context or dock file: the sha256 of its session id, as `pinnedContextFile` and `extensionDockPaths` name it. */
const HASHED_SESSION_FILE = /^[0-9a-f]{64}\.(?:json|taps)$/u;

/** The session ids named by each extension's session values and the open-workspace files. */
function sessionNamedIds(stateDir: string): Set<string> {
	const dirs = [sessionWorkspacesDir(stateDir)];
	try {
		for (const entry of readdirSync(path.join(stateDir, "extensions"), { withFileTypes: true }))
			if (entry.isDirectory() && !entry.name.startsWith("."))
				dirs.push(path.join(stateDir, "extensions", entry.name, "sessions"));
	} catch {
		// No extension has written state yet.
	}
	const ids = new Set<string>();
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
				ids.add(decodeURIComponent(encoded));
			} catch {
				// Not a name this host wrote.
			}
		}
	}
	return ids;
}

/** The pinned-context and dock files, which name their session only by a hash of its id. */
function hashedSessionFiles(stateDir: string): string[] {
	const files: string[] = [];
	for (const dir of [
		path.dirname(pinnedContextFile(stateDir, "")),
		path.dirname(extensionDockPaths(stateDir, null).frameFile),
	]) {
		try {
			for (const name of readdirSync(dir)) if (HASHED_SESSION_FILE.test(name)) files.push(path.join(dir, name));
		} catch {
			// Nothing pinned or docked yet.
		}
	}
	return files;
}

/**
 * Remove what extensions kept for sessions that no longer exist: each extension's session values, the open workspace,
 * pinned context and dock files. Only an orphan goes: a recorded session keeps its state however old it is, `keep`
 * (the host's own session) keeps its state even before its directory exists, and nothing goes when the sessions
 * cannot be listed (C-35). Best effort.
 *
 * The candidates are listed before the sessions are read, as `pruneWorkspaceSnapshots` does: a session another process
 * creates meanwhile is recorded by the time its files could be taken for an orphan's. Each named orphan's directory is
 * looked for once more right before its state goes, and hashed files are matched against a second read.
 */
export function pruneOrphanedExtensionSessionState(stateDir: string, keep: string | null): void {
	const named = sessionNamedIds(stateDir);
	const hashed = hashedSessionFiles(stateDir);
	const recorded = recordedSessionIds(stateDir);
	if (recorded === null) return;
	for (const id of named)
		if (id !== keep && !recorded.has(id) && !sessionRecorded(stateDir, id)) forgetExtensionSessionState(stateDir, id);
	if (hashed.length === 0) return;
	const live = recordedSessionIds(stateDir);
	if (live === null) return;
	// The dock of the moment before any session exists is never an orphan.
	const noSession = extensionDockPaths(stateDir, null);
	const kept = new Set([path.basename(noSession.frameFile), path.basename(noSession.tapFile)]);
	for (const id of new Set([...recorded, ...live, ...(keep !== null ? [keep] : [])])) {
		const dock = extensionDockPaths(stateDir, id);
		for (const file of [pinnedContextFile(stateDir, id), dock.frameFile, dock.tapFile]) kept.add(path.basename(file));
	}
	for (const file of hashed) {
		if (kept.has(path.basename(file))) continue;
		try {
			rmSync(file, { force: true });
		} catch {
			// An undeletable file stays; it is never read for another session.
		}
	}
}
