/**
 * Read-only mode's Copilot session state: the namespace and workspace rules of session-fs.ts, with the
 * session's own records held in this process instead of under Clio's cache. They are gone when Clio closes
 * the conversation or the process exits, as the disk records would be.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import type { SessionFsFileInfo, SessionFsProvider } from "@github/copilot-sdk";

/** Where a runtime path points: this session's own state, by its parts below the state path, or the real filesystem. */
export type SessionFsLocated = { state: false; real: string } | { state: true; inside: string[] };

interface MemoryEntry {
	directory: boolean;
	content: string;
	birthtime: string;
	mtime: string;
}

/** Each open memory session's entries, keyed by its parts joined with "/"; "" is the session directory. */
const sessions = new Map<string, Map<string, MemoryEntry>>();
/** Sessions Clio closed; as on disk, a closed session's state is never written again. */
const closed = new Set<string>();

function fsError(code: string, path: string): Error {
	return Object.assign(new Error(`${code}: session entry ${path}`), { code });
}

/** Within `of`, the session directory "" included. */
function within(key: string, of: string): boolean {
	return of === "" || key === of || key.startsWith(`${of}/`);
}

/** Drop a memory session's records; true when there was one. */
export function dropMemorySessionFs(sessionId: string): boolean {
	if (!sessions.delete(sessionId)) return false;
	closed.add(sessionId);
	return true;
}

export function createMemorySessionFs(
	sessionId: string,
	locate: (path: string) => SessionFsLocated,
	refuseWorkspaceWrite: (path: string) => never,
): SessionFsProvider {
	const entries = sessions.get(sessionId) ?? new Map<string, MemoryEntry>();
	if (!closed.has(sessionId)) sessions.set(sessionId, entries);
	const live = (): Map<string, MemoryEntry> => {
		if (sessions.get(sessionId) !== entries) throw new Error(`Copilot session state refused: ${sessionId} was closed`);
		return entries;
	};
	const now = (): string => new Date().toISOString();
	const directory = (): MemoryEntry => {
		const at = now();
		return { directory: true, content: "", birthtime: at, mtime: at };
	};
	/** The session directory and every directory down to `inside`, created as needed. */
	const makeDirectories = (inside: readonly string[]): void => {
		const state = live();
		for (let depth = 0; depth <= inside.length; depth++) {
			const key = inside.slice(0, depth).join("/");
			const entry = state.get(key);
			if (entry === undefined) state.set(key, directory());
			else if (!entry.directory) throw fsError("ENOTDIR", key);
		}
	};
	const stateWrite = (path: string): string[] => {
		const located = locate(path);
		if (!located.state) return refuseWorkspaceWrite(path);
		return located.inside;
	};
	const existing = (inside: readonly string[], path: string): MemoryEntry => {
		const entry = live().get(inside.join("/"));
		if (entry === undefined) throw fsError("ENOENT", path);
		return entry;
	};
	const children = (inside: readonly string[], path: string): Array<[string, MemoryEntry]> => {
		const key = inside.join("/");
		if (!existing(inside, path).directory) throw fsError("ENOTDIR", path);
		const prefix = key === "" ? "" : `${key}/`;
		const found: Array<[string, MemoryEntry]> = [];
		for (const [name, entry] of live()) {
			if (name === key || !name.startsWith(prefix)) continue;
			const rest = name.slice(prefix.length);
			if (!rest.includes("/")) found.push([rest, entry]);
		}
		return found.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	};
	const write = (path: string, content: string, append: boolean): void => {
		const inside = stateWrite(path);
		makeDirectories(inside.slice(0, -1));
		const key = inside.join("/");
		const prior = live().get(key);
		if (prior?.directory) throw fsError("EISDIR", path);
		const at = now();
		live().set(key, {
			directory: false,
			content: append && prior ? prior.content + content : content,
			birthtime: prior?.birthtime ?? at,
			mtime: at,
		});
	};
	const remove = (key: string): void => {
		for (const name of [...live().keys()]) if (within(name, key)) live().delete(name);
	};
	const statOf = async (path: string): Promise<SessionFsFileInfo> => {
		const located = locate(path);
		if (!located.state) {
			const info = await stat(located.real);
			return {
				isFile: info.isFile(),
				isDirectory: info.isDirectory(),
				size: info.size,
				mtime: info.mtime.toISOString(),
				birthtime: info.birthtime.toISOString(),
			};
		}
		const entry = existing(located.inside, path);
		return {
			isFile: !entry.directory,
			isDirectory: entry.directory,
			size: Buffer.byteLength(entry.content, "utf8"),
			mtime: entry.mtime,
			birthtime: entry.birthtime,
		};
	};
	return {
		async readFile(path) {
			const located = locate(path);
			if (!located.state) return readFile(located.real, "utf8");
			const entry = existing(located.inside, path);
			if (entry.directory) throw fsError("EISDIR", path);
			return entry.content;
		},
		async writeFile(path, content) {
			write(path, content, false);
		},
		async appendFile(path, content) {
			write(path, content, true);
		},
		async exists(path) {
			try {
				await statOf(path);
				return true;
			} catch {
				return false;
			}
		},
		stat: statOf,
		async mkdir(path, recursive) {
			const inside = stateWrite(path);
			if (recursive) {
				makeDirectories(inside);
				return;
			}
			// As on disk: the session directory itself appears on demand, every other parent must already exist.
			makeDirectories([]);
			if (inside.length === 0) return;
			const parent = live().get(inside.slice(0, -1).join("/"));
			if (parent === undefined) throw fsError("ENOENT", path);
			if (!parent.directory) throw fsError("ENOTDIR", path);
			if (live().has(inside.join("/"))) throw fsError("EEXIST", path);
			live().set(inside.join("/"), directory());
		},
		async readdir(path) {
			const located = locate(path);
			if (!located.state) return readdir(located.real);
			return children(located.inside, path).map(([name]) => name);
		},
		async readdirWithTypes(path) {
			const located = locate(path);
			if (!located.state) {
				const found = await readdir(located.real, { withFileTypes: true });
				return found.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }));
			}
			return children(located.inside, path).map(([name, entry]) => ({
				name,
				type: entry.directory ? "directory" : "file",
			}));
		},
		async rm(path, recursive, force) {
			const inside = stateWrite(path);
			const key = inside.join("/");
			const entry = live().get(key);
			if (entry === undefined) {
				if (!force) throw fsError("ENOENT", path);
				return;
			}
			if (entry.directory && !recursive) throw fsError("EISDIR", path);
			remove(key);
		},
		async rename(src, dest) {
			const from = stateWrite(src);
			const to = stateWrite(dest);
			makeDirectories(from.slice(0, -1));
			makeDirectories(to.slice(0, -1));
			const fromKey = from.join("/");
			const toKey = to.join("/");
			const moving = existing(from, src);
			if (fromKey === toKey) return;
			if (within(toKey, fromKey)) throw fsError("EINVAL", dest);
			const target = live().get(toKey);
			if (target !== undefined) {
				if (moving.directory && !target.directory) throw fsError("ENOTDIR", dest);
				if (!moving.directory && target.directory) throw fsError("EISDIR", dest);
				if (target.directory && children(to, dest).length > 0) throw fsError("ENOTEMPTY", dest);
				remove(toKey);
			}
			const moved = [...live()].filter(([name]) => within(name, fromKey));
			for (const [name] of moved) live().delete(name);
			for (const [name, entry] of moved) live().set(toKey + name.slice(fromKey.length), entry);
		},
	};
}
