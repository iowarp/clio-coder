/**
 * The exit handshake between a workspace-hosted Clio and its launcher.
 *
 * Kept apart from the launcher so the Clio in the pane loads these few lines
 * on its way out and nothing else from the workspace code.
 *
 * The marker lives beside the session's own socket. Both sides already know
 * that directory, the launcher because it chose the session and the pane
 * because herdr hands every pane `HERDR_SOCKET_PATH`, so they agree on it
 * without a variable of Clio's own having to survive the pane host's
 * environment.
 */

import { createHash } from "node:crypto";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Every herdr session Clio hosts is named with this prefix, and Clio acts on
 * no session without it. The bare name `clio-coder` is deliberately not
 * matched: a session by that name is somebody's own, or an earlier build's,
 * and is never attached to, migrated or stopped.
 */
export const WORKSPACE_SESSION_PREFIX = "clio-coder-";

/**
 * The session for one project: one per concrete directory. herdr keeps focus
 * per server, so two projects sharing a session would share one view, and
 * keys typed in one terminal would land in the other project's Clio. The
 * directory is resolved first, so a symlinked path reaches the same session
 * as the directory it names, and a second worktree, being a different
 * directory, gets its own.
 */
export function workspaceSessionFor(cwd: string): { session: string; cwd: string } {
	const canonical = realpathSync(cwd);
	return {
		session: `${WORKSPACE_SESSION_PREFIX}${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`,
		cwd: canonical,
	};
}

export const EXIT_MARKER_PREFIX = "clio-exit-";

export function exitMarkerPath(sessionDir: string, paneId: string): string {
	return join(sessionDir, `${EXIT_MARKER_PREFIX}${paneId.replace(/[^A-Za-z0-9_-]/gu, "_")}`);
}

/** True when this process runs in a pane of a workspace session Clio hosts. */
export function hostedInWorkspace(env: NodeJS.ProcessEnv = process.env): boolean {
	const socket = env.HERDR_SOCKET_PATH;
	return (
		env.HERDR_ENV === "1" && Boolean(socket) && basename(dirname(socket ?? "")).startsWith(WORKSPACE_SESSION_PREFIX)
	);
}

/**
 * Called by a Clio that is quitting cleanly. Inside a Clio workspace it tells
 * the launcher that owns the terminal that this pane is done; anywhere else it
 * does nothing.
 */
export function markWorkspaceExit(env: NodeJS.ProcessEnv = process.env): void {
	const socket = env.HERDR_SOCKET_PATH;
	const paneId = env.HERDR_PANE_ID;
	if (!hostedInWorkspace(env) || !socket || !paneId) return;
	try {
		writeFileSync(exitMarkerPath(dirname(socket), paneId), "");
	} catch {
		// The launcher then leaves the workspace open, which is the safe side.
	}
}

/**
 * Called by a Clio that is starting in a workspace pane. A marker already
 * there belongs to an earlier Clio in the same pane, and left in place it
 * would make the next launcher on this workspace hang up the moment it
 * attached.
 */
export function clearWorkspaceExit(env: NodeJS.ProcessEnv = process.env): void {
	const socket = env.HERDR_SOCKET_PATH;
	const paneId = env.HERDR_PANE_ID;
	if (!hostedInWorkspace(env) || !socket || !paneId) return;
	rmSync(exitMarkerPath(dirname(socket), paneId), { force: true });
}
