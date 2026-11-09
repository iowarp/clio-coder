import type { Stats } from "node:fs";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
} from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * The one read boundary for durable state a reader trusts: telemetry scopes and gate decision artifacts (#434). A
 * path is readable only when it is not itself a symlink and resolves strictly beneath the resolved state root, so a
 * symlinked `telemetry`, `runs`, scope directory or file cannot serve a foreign tree as this host's record. Files are
 * opened without following a final symlink and must be regular files. Every reader of those paths opens them here.
 */

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function beneath(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** Whether `path` exists, is not a symlink, and resolves beneath the state root. */
export function withinStateRoot(stateDir: string, path: string): boolean {
	try {
		if (lstatSync(path).isSymbolicLink()) return false;
		return beneath(realpathSync(stateDir), realpathSync(path));
	} catch {
		// A path that does not resolve holds nothing to read.
		return false;
	}
}

export async function withinStateRootAsync(stateDir: string, path: string): Promise<boolean> {
	try {
		if ((await lstat(path)).isSymbolicLink()) return false;
		return beneath(await realpath(stateDir), await realpath(path));
	} catch {
		// A path that does not resolve holds nothing to read.
		return false;
	}
}

/** Destructive cleanup accepts no directory links below the chosen state root. */
export function unlinkedStateDirectory(stateDir: string, directory: string): boolean {
	try {
		const root = resolve(stateDir);
		const suffix = relative(root, resolve(directory));
		if (isAbsolute(suffix) || suffix.split(sep)[0] === "..") return false;
		const rootStat = lstatSync(root);
		const stat = lstatSync(directory);
		return (
			rootStat.isDirectory() &&
			!rootStat.isSymbolicLink() &&
			stat.isDirectory() &&
			!stat.isSymbolicLink() &&
			realpathSync(directory) === resolve(realpathSync(root), suffix)
		);
	} catch {
		// Missing or replaced directories hold nothing cleanup may remove.
		return false;
	}
}

function outside(path: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${path} is not beneath the state root`), { code: "ENOENT" });
}

/** A regular file, opened without following a final symlink. The caller has bounded its directory. */
export function readRegularFileSync(path: string): Buffer {
	const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
	try {
		if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a regular file`);
		return readFileSync(fd);
	} finally {
		closeSync(fd);
	}
}

/**
 * The bytes of a regular file from an offset the caller picks once it has the open file's stats, opened as
 * `readRegularFileSync` opens it. A start past the end reads nothing.
 */
export function readRegularFileFromSync(
	path: string,
	startFor: (stats: Stats) => number,
): { bytes: Buffer; start: number; stats: Stats } {
	const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
	try {
		const stats = fstatSync(fd);
		if (!stats.isFile()) throw new Error(`${path} is not a regular file`);
		const start = Math.min(Math.max(0, startFor(stats)), stats.size);
		const chunks: Buffer[] = [];
		let position = start;
		for (;;) {
			// The size stat saw first, then whatever a writer appended since, as a cold `readFileSync` would.
			const chunk = Buffer.allocUnsafe(position < stats.size ? stats.size - position : 64 * 1024);
			const read = readSync(fd, chunk, 0, chunk.length, position);
			if (read === 0) break;
			chunks.push(chunk.subarray(0, read));
			position += read;
		}
		return { bytes: Buffer.concat(chunks), start, stats };
	} finally {
		closeSync(fd);
	}
}

export async function readRegularFile(path: string): Promise<Buffer> {
	const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
	try {
		if (!(await handle.stat()).isFile()) throw new Error(`${path} is not a regular file`);
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

/**
 * A file beneath the state root. Throws ENOENT when the file or its directory is missing, symlinked or outside the
 * root, so callers treat a refused path as an absent one.
 */
export function readStateFileSync(stateDir: string, path: string): Buffer {
	if (!withinStateRoot(stateDir, dirname(path))) throw outside(path);
	return readRegularFileSync(path);
}

export async function readStateFile(stateDir: string, path: string): Promise<Buffer> {
	if (!(await withinStateRootAsync(stateDir, dirname(path)))) throw outside(path);
	return readRegularFile(path);
}

/** A directory's names beneath the state root; ENOENT when it is missing, symlinked or outside the root. */
export function listStateDirectorySync(stateDir: string, path: string): string[] {
	if (!withinStateRoot(stateDir, path)) throw outside(path);
	return readdirSync(path);
}

export async function listStateDirectory(stateDir: string, path: string): Promise<string[]> {
	if (!(await withinStateRootAsync(stateDir, path))) throw outside(path);
	return readdir(path);
}

/** A path's own stat beneath the state root, never a symlink's target; null when refused or missing. */
export function statStatePathSync(stateDir: string, path: string): Stats | null {
	if (!withinStateRoot(stateDir, path)) return null;
	try {
		return lstatSync(path);
	} catch {
		// Removed between the check and the stat: absent.
		return null;
	}
}

export async function statStatePath(stateDir: string, path: string): Promise<Stats | null> {
	if (!(await withinStateRootAsync(stateDir, path))) return null;
	return lstat(path).catch(() => null);
}
