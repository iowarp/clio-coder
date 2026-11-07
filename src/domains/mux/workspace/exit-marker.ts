/**
 * The exit handshake between a Clio hosted in its private pane host and the
 * launcher that owns the terminal.
 *
 * Kept apart from the launcher so the Clio in the pane loads these few lines
 * on its way out and nothing else from the hosting code.
 *
 * The marker is named after the host's own socket. Both sides already know
 * that path, the launcher because it chose it and the pane because herdr
 * hands every pane `HERDR_SOCKET_PATH`, so they agree on it without a variable
 * of Clio's own having to survive the pane host's environment, and on either
 * platform layout (src/domains/mux/workspace/platform.ts).
 */

import { createHash } from "node:crypto";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { isClioHostSocket } from "./platform.js";

/**
 * Every pane host Clio starts is named with this prefix and a hash, and Clio
 * acts on no host without both. The bare name `clio-coder` is deliberately
 * not matched: a session by that name is somebody's own, or an earlier
 * build's, and is never attached to, migrated or stopped.
 */
export const WORKSPACE_SESSION_PREFIX = "clio-coder-";

/**
 * The host for one project: one per concrete directory. herdr keeps focus per
 * server, so two projects sharing a host would share one view, and keys typed
 * in one terminal would land in the other project's Clio. The directory is
 * resolved first, so a symlinked path reaches the same host as the directory
 * it names, and a second worktree, being a different directory, gets its own.
 */
export function workspaceSessionFor(cwd: string): { session: string; cwd: string } {
	const canonical = realpathSync(cwd);
	return {
		session: `${WORKSPACE_SESSION_PREFIX}${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`,
		cwd: canonical,
	};
}

/** The session name a Clio host socket belongs to, or null for any other socket. */
export function clioHostSessionOf(socketPath: string | undefined): string | null {
	if (!socketPath || !isClioHostSocket(socketPath)) return null;
	const normalized = socketPath.replace(/\\/gu, "/");
	const name = basename(normalized);
	return name === "herdr.sock" ? basename(dirname(normalized)) : name.slice(0, -".sock".length);
}

/** `<socket path without .sock>.exit-`: every marker of one host starts with this. */
export function exitMarkerStem(socketPath: string): string {
	return `${socketPath.endsWith(".sock") ? socketPath.slice(0, -".sock".length) : socketPath}.exit-`;
}

export function exitMarkerPath(socketPath: string, paneId: string): string {
	return `${exitMarkerStem(socketPath)}${paneId.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

/** True when this process runs in a pane of a private host Clio started. */
export function hostedInWorkspace(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.HERDR_ENV === "1" && isClioHostSocket(env.HERDR_SOCKET_PATH);
}

/**
 * Called by a Clio that is quitting cleanly. Inside Clio's own host it tells
 * the launcher that owns the terminal that this pane is done; anywhere else it
 * does nothing.
 */
export function markWorkspaceExit(env: NodeJS.ProcessEnv = process.env): void {
	const socket = env.HERDR_SOCKET_PATH;
	const paneId = env.HERDR_PANE_ID;
	if (!hostedInWorkspace(env) || !socket || !paneId) return;
	try {
		writeFileSync(exitMarkerPath(socket, paneId), "", { mode: 0o600 });
	} catch {
		// The launcher then leaves the workspace open, which is the safe side.
	}
}

/**
 * Called by a Clio that is starting in a hosted pane. A marker already there
 * belongs to an earlier Clio in the same pane, and left in place it would make
 * the next launcher on this host hang up the moment it attached.
 */
export function clearWorkspaceExit(env: NodeJS.ProcessEnv = process.env): void {
	const socket = env.HERDR_SOCKET_PATH;
	const paneId = env.HERDR_PANE_ID;
	if (!hostedInWorkspace(env) || !socket || !paneId) return;
	rmSync(exitMarkerPath(socket, paneId), { force: true });
}
