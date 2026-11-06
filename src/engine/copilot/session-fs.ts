/**
 * The session filesystem the Copilot runtime sees, under the SDK's `sessionFs` contract.
 *
 * The SDK's `mode: "empty"` requires an explicit persistence location: `baseDirectory` or `sessionFs`.
 * `baseDirectory` would set `COPILOT_HOME` for the runtime, which is also where the official
 * `copilot login` keeps its sign-in, so it would hide the very login Clio is meant to use.
 *
 * With `sessionFs`, the runtime routes every session file operation through this provider: its own records
 * under `sessionStatePath`, and the workspace namespace rooted at `initialCwd` (the runtime stats the
 * session's working directory there while creating a session). Paths keep their real absolute form; the
 * provider decides by where they point:
 *
 * - Session state: `sessionStatePath` is `<cache>/copilot-sdk/state`, which nothing on disk uses. A path
 *   under it lands in this session's own directory, `<cache>/copilot-sdk/sessions/<session id>/`, per OS
 *   user, removed when Clio closes the conversation. Containment is physical, not only lexical: the cache
 *   root is resolved once with realpath, every directory below it must be a real directory (a symlinked
 *   component is refused, missing ones are created one level at a time), and the final entry is never a
 *   symlink, so no state read, write, rename or cleanup follows a link out of the session directory.
 * - In read-only mode the session's own state is held in memory instead (session-fs-memory.ts), so a
 *   read-only process leaves Clio's cache as it found it; the namespace and workspace rules are the same.
 * - Everything else is the user's real filesystem, served read-only. Copilot's built-in tools are disabled
 *   and every change to the workspace goes through Clio's own tools and permission policy, so a write,
 *   mkdir, rename or rm there is refused.
 *
 * Identity anchoring: the cache root's realpath and its device/inode are fixed at first use, and each session
 * directory's device/inode when it is first created or found. Both are re-verified immediately before every
 * mutation and every cleanup, so a root or session directory that was swapped out (for a link or another
 * directory) is refused rather than written into or deleted.
 *
 * Known limit: a window remains between that re-verification and the syscall that follows it, and the
 * syscall traverses pathnames again. Closing it needs descriptor-relative directory operations (openat,
 * unlinkat, mkdirat), which Node does not expose. Exploiting it requires an attacker who can already write
 * inside this OS user's own cache directory and race each operation; O_NOFOLLOW still guards the final entry.
 */

import { constants, lstatSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import type { SessionFsConfig, SessionFsProvider } from "@github/copilot-sdk";
import { readOnlyMode } from "../../core/read-only-mode.js";
import { clioCacheDir, clioCachePath } from "../../core/xdg.js";
import { createMemorySessionFs, dropMemorySessionFs, type SessionFsLocated } from "./session-fs-memory.js";

/** Directories below the trusted cache root that lead to every session directory. */
const SESSIONS_PATH = ["copilot-sdk", "sessions"] as const;

/** Named, not created: configuring the client and cleaning up must not create the cache root. */
function copilotSdkCacheDir(): string {
	return join(clioCachePath(), "copilot-sdk");
}

/** Where each session's state appears in the runtime's namespace; mapped per session, never written as is. */
function sessionStateBase(): string {
	return join(copilotSdkCacheDir(), "state");
}

export function copilotSessionFsConfig(cwd = process.cwd()): SessionFsConfig {
	return {
		initialCwd: resolvePath(cwd),
		sessionStatePath: sessionStateBase(),
		conventions: process.platform === "win32" ? "windows" : "posix",
	};
}

function validSessionId(sessionId: string): string {
	if (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) throw new Error(`invalid Copilot session id: ${sessionId}`);
	return sessionId;
}

class SessionFsEscape extends Error {
	constructor(path: string, why: string) {
		super(`Copilot session state refused at ${path}: ${why}`);
		this.name = "SessionFsEscape";
	}
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Walk `parts` below `root`, each a real directory. With `create`, a missing level is made (one level, not
 * recursive, so mkdir never walks through a link someone planted). Returns null for a missing level when not
 * creating. A symlink or a non-directory anywhere on the way is refused.
 */
async function walkDirectories(
	root: string,
	parts: readonly string[],
	create: boolean,
	beforeCreate?: () => Promise<void>,
): Promise<string | null> {
	let current = root;
	for (const part of parts) {
		const next = join(current, part);
		let info = await lstat(next).catch((error: unknown) => {
			if (missing(error)) return null;
			throw error;
		});
		if (info === null) {
			if (!create) return null;
			// Inside a session directory every implicit mkdir first re-verifies that directory's identity.
			await beforeCreate?.();
			await mkdir(next).catch((error: unknown) => {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			});
			info = await lstat(next);
		}
		if (info.isSymbolicLink()) throw new SessionFsEscape(next, "a symlinked directory is not followed");
		if (!info.isDirectory()) throw new SessionFsEscape(next, "not a directory");
		current = next;
	}
	return current;
}

interface Identity {
	dev: number;
	ino: number;
}

function sameIdentity(info: { dev: number; ino: number }, identity: Identity): boolean {
	return info.dev === identity.dev && info.ino === identity.ino;
}

/** The cache root fixed at first use, keyed by the configured cache directory. */
const rootAnchors = new Map<string, { path: string; identity: Identity }>();
/** Each session directory's identity from when it was first created or found, keyed by its physical path. */
const sessionIdentities = new Map<string, Identity>();
/** Session directories Clio removed; a provider never recreates one. */
const closedSessions = new Set<string>();

/**
 * The cache root as it really was on disk at first use. Later calls reuse that path and refuse to go on when
 * the directory at it is no longer the same one (a swapped or replaced root).
 */
async function trustedRoot(): Promise<string> {
	const configured = clioCachePath();
	const anchor = rootAnchors.get(configured);
	if (!anchor) {
		const path = await realpath(configured);
		const info = await lstat(path);
		rootAnchors.set(configured, { path, identity: { dev: info.dev, ino: info.ino } });
		return path;
	}
	const info = await lstat(anchor.path).catch(() => null);
	if (!info || info.isSymbolicLink() || !info.isDirectory() || !sameIdentity(info, anchor.identity))
		throw new SessionFsEscape(anchor.path, "the cache root is no longer the directory first resolved");
	return anchor.path;
}

function trustedRootSync(): string | null {
	const configured = clioCachePath();
	const anchor = rootAnchors.get(configured);
	if (!anchor) {
		try {
			return realpathSync(configured);
		} catch {
			// No cache root, so no records to remove.
			return null;
		}
	}
	const info = lstatSync(anchor.path, { throwIfNoEntry: false });
	if (!info || info.isSymbolicLink() || !info.isDirectory() || !sameIdentity(info, anchor.identity)) return null;
	return anchor.path;
}

/** Record a session directory's identity the first time it is resolved. */
async function anchorSession(path: string): Promise<void> {
	if (sessionIdentities.has(path)) return;
	const info = await lstat(path);
	sessionIdentities.set(path, { dev: info.dev, ino: info.ino });
}

/**
 * Immediately before a mutation: the root is still the anchored one and the session directory, reached by its
 * full path, is still the real directory first resolved. An ancestor swapped for a link or another directory
 * changes what this path reaches, so it fails here.
 */
async function verifySession(root: string, sessionPath: string): Promise<void> {
	if ((await trustedRoot()) !== root) throw new SessionFsEscape(root, "the cache root moved");
	const identity = sessionIdentities.get(sessionPath);
	const info = await lstat(sessionPath).catch(() => null);
	if (!identity || !info || info.isSymbolicLink() || !info.isDirectory() || !sameIdentity(info, identity))
		throw new SessionFsEscape(sessionPath, "the session directory is no longer the one first resolved");
}

function sessionParts(sessionId: string): string[] {
	return [...SESSIONS_PATH, validSessionId(sessionId)];
}

/**
 * Remove one session directory without following a link out: a symlinked step on the way means the
 * directory was never Clio's, so only the link itself is removed. `rm` does not follow links inside the tree.
 */
export async function removeCopilotSessionRecords(sessionId: string): Promise<void> {
	// A read-only process kept its sessions in memory and leaves the disk as it found it.
	if (dropMemorySessionFs(sessionId) || readOnlyMode()) return;
	const root = await trustedRoot().catch(() => null);
	if (root === null) return;
	const parts = sessionParts(sessionId);
	const parent = await walkDirectories(root, parts.slice(0, -1), false).catch(() => null);
	if (parent === null) return;
	const target = join(parent, parts[parts.length - 1] as string);
	const info = await lstat(target).catch(() => null);
	if (info === null) return;
	if (info.isSymbolicLink() || !info.isDirectory()) {
		await unlink(target);
		return;
	}
	// A directory Clio resolved before must still be that directory; one it never resolved is removed as found.
	const identity = sessionIdentities.get(target);
	if (identity && !sameIdentity(info, identity))
		throw new SessionFsEscape(target, "the session directory is no longer the one first resolved");
	if (identity) await verifySession(root, target);
	await rm(target, { recursive: true, force: true });
	sessionIdentities.delete(target);
	closedSessions.add(target);
}

/** At process exit only synchronous work runs; the same rules as removeCopilotSessionRecords. */
export function removeCopilotSessionRecordsSync(sessionId: string): void {
	if (dropMemorySessionFs(sessionId) || readOnlyMode()) return;
	const root = trustedRootSync();
	if (root === null) return;
	let current = root;
	const parts = sessionParts(sessionId);
	for (const part of parts.slice(0, -1)) {
		current = join(current, part);
		const info = lstatSync(current, { throwIfNoEntry: false });
		if (!info || info.isSymbolicLink() || !info.isDirectory()) return;
	}
	const target = join(current, parts[parts.length - 1] as string);
	const info = lstatSync(target, { throwIfNoEntry: false });
	if (!info) return;
	if (info.isSymbolicLink() || !info.isDirectory()) {
		unlinkSync(target);
		return;
	}
	const identity = sessionIdentities.get(target);
	if (identity && !sameIdentity(info, identity)) return;
	rmSync(target, { recursive: true, force: true });
	sessionIdentities.delete(target);
	closedSessions.add(target);
}

function refuseWorkspaceWrite(path: string): never {
	throw new Error(
		`Clio does not let the Copilot runtime change ${path}; workspace changes go through Clio's own tools.`,
	);
}

/** O_NOFOLLOW where the platform has it; elsewhere the lstat check before the open is the guard. */
const NO_FOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

export function createCopilotSessionFs(sessionId: string): SessionFsProvider {
	const base = sessionStateBase();
	const parts = sessionParts(sessionId);
	/** Whether a runtime path is this session's own state, by its place in the runtime's namespace. */
	const locate = (path: string): SessionFsLocated => {
		const absolute = resolvePath(path);
		const inside = relative(base, absolute);
		if (inside === "") return { state: true, inside: [] };
		if (!inside.startsWith("..") && !isAbsolute(inside)) return { state: true, inside: inside.split(sep) };
		return { state: false, real: absolute };
	};
	// The mode is read where the session's state store is chosen: every write below goes to that store.
	if (readOnlyMode()) return createMemorySessionFs(sessionId, locate, refuseWorkspaceWrite);
	/**
	 * The one resolve-and-anchor policy for this session's directory. A directory anchored before must still be
	 * that directory: one that went missing or was replaced is refused and never recreated, and neither is one
	 * Clio already closed. Only a session never resolved is walked (created when `create`) and then anchored.
	 */
	const resolveSession = async (create: boolean): Promise<{ root: string; session: string } | null> => {
		// Creating state creates the cache root first, through the accessor that checks the home's layout.
		if (create) clioCacheDir();
		const root = await trustedRoot();
		const expected = join(root, ...parts);
		if (closedSessions.has(expected)) throw new SessionFsEscape(expected, "the session directory was closed");
		if (sessionIdentities.has(expected)) {
			await verifySession(root, expected);
			return { root, session: expected };
		}
		const session = await walkDirectories(root, parts, create);
		if (session === null) return null;
		await anchorSession(session);
		return { root, session };
	};
	/**
	 * The physical path of a state entry. The session directory comes from resolveSession; every directory from
	 * it to the entry's parent is a real directory, each created only after re-verifying the session, and the
	 * entry itself is never a symlink. Null when absent and not created.
	 */
	const statePath = async (inside: string[], create: boolean): Promise<string | null> => {
		const resolved = await resolveSession(create);
		if (resolved === null) return null;
		if (inside.length === 0) return resolved.session;
		const parent = await walkDirectories(resolved.session, inside.slice(0, -1), create, () =>
			verifySession(resolved.root, resolved.session),
		);
		if (parent === null) return null;
		const entry = join(parent, inside[inside.length - 1] as string);
		const info = await lstat(entry).catch((error: unknown) => {
			if (missing(error)) return null;
			throw error;
		});
		if (info?.isSymbolicLink()) throw new SessionFsEscape(entry, "a symlinked entry is not followed");
		return entry;
	};
	/** Where to read: a state entry under the containment rules, else the real workspace path. */
	const readable = async (path: string): Promise<string> => {
		const located = locate(path);
		if (!located.state) return located.real;
		const entry = await statePath(located.inside, false);
		if (entry === null) throw Object.assign(new Error(`ENOENT: no such session entry ${path}`), { code: "ENOENT" });
		return entry;
	};
	/** Re-verify the anchored root and session directory right before a mutation (see the known limit above). */
	const beforeMutation = async () => {
		const resolved = await resolveSession(false);
		if (resolved === null) throw new SessionFsEscape(join(...parts), "the session directory disappeared");
		await verifySession(resolved.root, resolved.session);
	};
	const writable = async (path: string): Promise<string> => {
		const located = locate(path);
		if (!located.state) return refuseWorkspaceWrite(path);
		return (await statePath(located.inside, true)) as string;
	};
	/** Write through a descriptor opened without following a final link (the lstat above covers other OSes). */
	const writeEntry = async (path: string, content: string, flags: number, mode: number | undefined) => {
		const target = await writable(path);
		await beforeMutation();
		const handle = await open(target, flags | NO_FOLLOW, mode);
		try {
			await handle.writeFile(content, "utf8");
		} finally {
			await handle.close();
		}
	};
	return {
		readFile: async (path) => readFile(await readable(path), "utf8"),
		async writeFile(path, content, mode) {
			await writeEntry(path, content, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, mode);
		},
		async appendFile(path, content, mode) {
			await writeEntry(path, content, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, mode);
		},
		async exists(path) {
			try {
				await stat(await readable(path));
				return true;
			} catch {
				// Any stat failure, a refused link included, reads as absent, which is what the runtime asks.
				return false;
			}
		},
		async stat(path) {
			const info = await stat(await readable(path));
			return {
				isFile: info.isFile(),
				isDirectory: info.isDirectory(),
				size: info.size,
				mtime: info.mtime.toISOString(),
				birthtime: info.birthtime.toISOString(),
			};
		},
		async mkdir(path, recursive, mode) {
			const located = locate(path);
			if (!located.state) return refuseWorkspaceWrite(path);
			const resolved = await resolveSession(true);
			if (resolved === null) throw new SessionFsEscape(join(...parts), "the session directory disappeared");
			const verify = () => verifySession(resolved.root, resolved.session);
			if (recursive) {
				await walkDirectories(resolved.session, located.inside, true, verify);
				return;
			}
			const parent = await walkDirectories(resolved.session, located.inside.slice(0, -1), false);
			if (parent === null)
				throw Object.assign(new Error(`ENOENT: no parent for session entry ${path}`), { code: "ENOENT" });
			const name = located.inside[located.inside.length - 1];
			if (name === undefined) return;
			await verify();
			await mkdir(join(parent, name), mode !== undefined ? { mode } : {});
		},
		readdir: async (path) => readdir(await readable(path)),
		async readdirWithTypes(path) {
			const entries = await readdir(await readable(path), { withFileTypes: true });
			return entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }));
		},
		async rm(path, recursive, force) {
			const located = locate(path);
			if (!located.state) return refuseWorkspaceWrite(path);
			const resolved = await resolveSession(false);
			const name = located.inside[located.inside.length - 1];
			const parent =
				resolved === null ? null : await walkDirectories(resolved.session, located.inside.slice(0, -1), false);
			const target = parent === null ? null : name === undefined ? parent : join(parent, name);
			const info = target === null ? null : await lstat(target).catch(() => null);
			if (target === null || info === null) {
				if (!force) throw Object.assign(new Error(`ENOENT: no such session entry ${path}`), { code: "ENOENT" });
				return;
			}
			await beforeMutation();
			// A link inside the session directory is removed as a link; rm never follows links inside a tree.
			if (info.isSymbolicLink()) await unlink(target);
			else await rm(target, { recursive, force });
		},
		async rename(src, dest) {
			// writable() refuses a symlinked source or destination and creates the destination's parents.
			const from = await writable(src);
			const to = await writable(dest);
			await beforeMutation();
			await rename(from, to);
		},
	};
}
