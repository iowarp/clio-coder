/**
 * The per-session files extensions keep under the state directory follow the
 * session's lifecycle: a fork inherits the parent's pinned context blocks, and
 * removing a session removes its pinned blocks, its dock frame and taps, and
 * each extension's session key-value state. The session domain calls these at
 * its fork and delete seams; nothing scans for orphans on boot.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { safeResourceBackupPath, safeResourceWrite } from "../../core/safe-resource-write.js";
import { extensionDockPaths } from "./dock-frame.js";
import { pinnedContextFile } from "./pinned-context.js";
import { extensionDataPaths } from "./runtime-state.js";

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
	const files = [pinnedContextFile(stateDir, sessionId), dock.frameFile, dock.tapFile];
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
