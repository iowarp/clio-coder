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
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { clioStateDir } from "../../../core/xdg.js";
import { heldExitSummary } from "./exit-summary-handoff.js";
import { isClioHostSocket } from "./platform.js";

/**
 * Every pane host Clio starts is named with this prefix and a hash, and Clio
 * acts on no host without both. The bare name `clio-coder` is deliberately
 * not matched: a session by that name is somebody's own, or an earlier
 * build's, and is never attached to, migrated or stopped.
 */
export const WORKSPACE_SESSION_PREFIX = "clio-coder-";

/**
 * The host for one project and Clio state root. herdr keeps focus per
 * server, so two projects sharing a host would share one view, and keys typed
 * in one terminal would land in the other project's Clio. The directory is
 * resolved first, so a symlinked path reaches the same host as the directory
 * it names, and a second worktree, being a different directory, gets its own.
 *
 * One folder has a few ordered slots, so a second terminal in the same folder
 * gets its own host instead of sharing the first one's view. Slot 0 keeps the
 * original hash input, so hosts, locks and markers from earlier builds stay
 * valid.
 */
export const WORKSPACE_HOST_SLOTS = 4;

export function workspaceSessionFor(cwd: string, slot = 0): { session: string; cwd: string } {
	const canonical = realpathSync(cwd);
	const state = realpathSync(clioStateDir());
	return {
		session: `${WORKSPACE_SESSION_PREFIX}${createHash("sha256")
			.update(JSON.stringify(slot === 0 ? [state, canonical] : [state, canonical, slot]))
			.digest("hex")
			.slice(0, 12)}`,
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

/** A marker larger than this is not an exit summary Clio wrote, and is not printed. */
const EXIT_SUMMARY_MAX_BYTES = 256 * 1024;

/**
 * Called by a Clio that is exiting. Inside Clio's own host it tells
 * the launcher that owns the terminal that this pane is done; anywhere else it
 * does nothing. The marker's content is the exit summary this Clio printed in
 * its pane (exit-summary-handoff.ts), which the launcher prints in the
 * operator's terminal after the host is gone. It is staged and renamed into
 * place, so the launcher never sees a marker whose summary is half written.
 */
export function markWorkspaceExit(env: NodeJS.ProcessEnv = process.env, exitCode = 0): void {
	const socket = env.HERDR_SOCKET_PATH;
	const paneId = env.HERDR_PANE_ID;
	if (!hostedInWorkspace(env) || !socket || !paneId) return;
	const marker = exitMarkerPath(socket, paneId);
	const header = exitCode === 0 ? "" : `clio-coder-exit:${exitCode}\n`;
	// Sanitized pane ids hold no dot, so the staged name is never another pane's marker.
	const staged = `${marker}.${process.pid}.tmp`;
	try {
		writeFileSync(staged, `${header}${heldExitSummary() ?? ""}`, { mode: 0o600 });
		renameSync(staged, marker);
		return;
	} catch {
		rmSync(staged, { force: true });
	}
	try {
		writeFileSync(marker, header, { mode: 0o600 });
	} catch {
		// The launcher then leaves the workspace open, which is the safe side.
	}
}

/**
 * The exit status and summary a marker carries, or null when it is invalid. Read by the
 * launcher before it deletes the marker with the workspace.
 */
export function readWorkspaceExitResult(marker: string): { exitCode: number; summary: string | null } | null {
	try {
		const stat = lstatSync(marker);
		if (!stat.isFile() || stat.size > EXIT_SUMMARY_MAX_BYTES) return null;
		const raw = readFileSync(marker, "utf8");
		const header = /^clio-coder-exit:(\d+)\n/u.exec(raw);
		const exitCode = header ? Number(header[1]) : 0;
		if (exitCode > 255) return null;
		const summary = header ? raw.slice(header[0].length) : raw;
		return { exitCode, summary: summary || null };
	} catch {
		return null;
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
