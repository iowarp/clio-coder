import { lstat, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import {
	clearAbandonedStateLock,
	StateFileLockTimeoutError,
	stateLockIsAbandoned,
	withStateFileLock,
} from "../state-file-lock.js";
import { clioCachePath } from "../xdg.js";

/**
 * The sandbox cache's size cap and its pruning. Contained commands keep their
 * tool caches (npm, pnpm's store, pip, uv, Playwright) under one directory so
 * installs stay warm across sessions; without a cap it only grows.
 *
 * A process that plans a contained command holds a lease for the rest of its
 * life, a lock file kept by the repository's state-file lock (owner pid and
 * birth token, mtime refreshed every few seconds). The pruner removes nothing
 * while any lease is live, and it removes only whole top-level entries of the
 * cache directory, least recently used first, after renaming each to a
 * `.prune-` name inside the same directory, so a command that starts after the
 * check never finds half a tool cache. Nothing outside the directory is
 * touched and no link is followed.
 */

const GIB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A lease on another host is refreshed every 5 s; one unrefreshed this long belongs to a process that is gone. */
const FOREIGN_LEASE_EXPIRES_MS = 60_000;
const TRASH_PREFIX = ".prune-";

/** `safety.sandboxCacheMaxGiB` in bytes; 0 means no cap. */
export function sandboxCacheCapBytes(gib: number): number {
	return Math.max(0, Math.floor(gib * GIB));
}

/** The contained commands' tool cache, `<cache dir>/sandbox-cache`. */
export function sandboxCacheDir(cacheRoot: string = clioCachePath()): string {
	return path.join(cacheRoot, "sandbox-cache");
}

/** Beside the cache, in Clio's cache root, which contained commands cannot write. */
function leaseDir(cacheDir: string): string {
	return path.join(path.dirname(cacheDir), "sandbox-cache-leases");
}

const leased = new Set<string>();

/**
 * Record that this process may use the sandbox cache from now until it exits.
 * Idempotent. The lock is taken synchronously when it is free, which a lease
 * named for this host and pid always is, and is never released: an exited
 * owner is what makes it abandoned.
 */
export function holdSandboxCacheLease(cacheDir: string): void {
	if (leased.has(cacheDir)) return;
	leased.add(cacheDir);
	const name = `${hostname().replace(/[^A-Za-z0-9._-]/gu, "_")}-${process.pid}`;
	void withStateFileLock(path.join(leaseDir(cacheDir), name), () => new Promise<never>(() => {}), {
		note: "sandbox cache in use",
	}).catch(() => {
		// A cache root that cannot hold the lease cannot be pruned either; the next contained command tries again.
		leased.delete(cacheDir);
	});
}

/** Live leases, clearing abandoned ones; null when the lease directory cannot be read, which rules nobody out. */
async function liveLeases(cacheDir: string): Promise<number | null> {
	const dir = leaseDir(cacheDir);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null;
	}
	let live = 0;
	for (const name of names) {
		if (name.startsWith(".") || !name.endsWith(".lock") || name.endsWith(".reclaim.lock")) continue;
		const lock = path.join(dir, name);
		if (stateLockIsAbandoned(lock, FOREIGN_LEASE_EXPIRES_MS)) clearAbandonedStateLock(lock, FOREIGN_LEASE_EXPIRES_MS);
		else live += 1;
	}
	return live;
}

interface TreeMeasure {
	bytes: number;
	/** Newest file access or modification, or directory modification, anywhere in the tree. */
	lastUsedMs: number;
	unreadable: number;
}

/**
 * Size and last use of one tree without following links. A directory's atime
 * is skipped because listing it, as this walk does, refreshes it; a file's is
 * kept, since lstat never opens the file.
 */
async function measureTree(root: string): Promise<TreeMeasure> {
	const total: TreeMeasure = { bytes: 0, lastUsedMs: 0, unreadable: 0 };
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		let stats: Awaited<ReturnType<typeof lstat>>;
		try {
			stats = await lstat(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") total.unreadable += 1;
			continue;
		}
		const used = stats.isDirectory() ? stats.mtimeMs : Math.max(stats.mtimeMs, stats.atimeMs);
		total.lastUsedMs = Math.max(total.lastUsedMs, used);
		if (!stats.isDirectory()) {
			total.bytes += stats.size;
			continue;
		}
		try {
			for (const name of await readdir(current)) stack.push(path.join(current, name));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") total.unreadable += 1;
		}
	}
	return total;
}

interface CacheEntry extends TreeMeasure {
	name: string;
	/** A real directory, the only kind the pruner removes. */
	toolDir: boolean;
}

async function cacheEntries(cacheDir: string): Promise<CacheEntry[]> {
	const entries: CacheEntry[] = [];
	for (const dirent of await readdir(cacheDir, { withFileTypes: true })) {
		const measured = await measureTree(path.join(cacheDir, dirent.name));
		entries.push({ name: dirent.name, toolDir: dirent.isDirectory(), ...measured });
	}
	return entries;
}

export interface SandboxCacheMeasure {
	cacheDir: string;
	bytes: number;
	unreadable: number;
}

/** The cache's size; null when it does not exist yet. Throws when it is not a real directory or cannot be listed. */
export async function measureSandboxCache(cacheDir: string = sandboxCacheDir()): Promise<SandboxCacheMeasure | null> {
	try {
		const stats = await lstat(cacheDir);
		if (!stats.isDirectory()) throw new Error(`${cacheDir} is not a directory`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const entries = await cacheEntries(cacheDir);
	return {
		cacheDir,
		bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
		unreadable: entries.reduce((sum, entry) => sum + entry.unreadable, 0),
	};
}

export type SandboxCacheSkip = "in-use" | "leases-unreadable" | "busy" | "stopped";

export interface SandboxCachePruneResult {
	cacheDir: string;
	capBytes: number;
	/** Null when the cache does not exist. */
	beforeBytes: number | null;
	afterBytes: number | null;
	removed: Array<{ name: string; bytes: number }>;
	failed: Array<{ name: string; error: string }>;
	/** Why pruning stopped short, or null when it ran to the cap (or had nothing to do). */
	skipped: SandboxCacheSkip | null;
	/** Live leases at the moment the pruner stopped for them. */
	liveLeases: number;
}

/**
 * Remove the least recently used top-level tool directories until the cache
 * fits `capBytes`, unless a process may be using it. One pruner at a time; a
 * second one returns `busy` without waiting. Leases are read again before
 * each removal, so a command that starts mid-prune stops it.
 */
export async function pruneSandboxCache(options: {
	capBytes: number;
	cacheDir?: string;
	stopped?: () => boolean;
}): Promise<SandboxCachePruneResult> {
	const cacheDir = options.cacheDir ?? sandboxCacheDir();
	const result: SandboxCachePruneResult = {
		cacheDir,
		capBytes: options.capBytes,
		beforeBytes: null,
		afterBytes: null,
		removed: [],
		failed: [],
		skipped: null,
		liveLeases: 0,
	};
	const exists = await measureSandboxCache(cacheDir);
	if (exists === null) return result;
	try {
		await withStateFileLock(path.join(leaseDir(cacheDir), ".prune"), () => pruneLocked(result, options.stopped), {
			timeoutMs: 0,
			note: "sandbox cache prune",
		});
	} catch (error) {
		if (!(error instanceof StateFileLockTimeoutError)) throw error;
		result.skipped = "busy";
		result.beforeBytes = exists.bytes;
		result.afterBytes = exists.bytes;
	}
	return result;
}

/** False when a lease is live or unreadable; the result then says which. */
async function nobodyUses(result: SandboxCachePruneResult): Promise<boolean> {
	const live = await liveLeases(result.cacheDir);
	if (live === 0) return true;
	result.skipped = live === null ? "leases-unreadable" : "in-use";
	result.liveLeases = live ?? 0;
	return false;
}

async function pruneLocked(result: SandboxCachePruneResult, stopped?: () => boolean): Promise<void> {
	const { cacheDir } = result;
	let entries = await cacheEntries(cacheDir);
	let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
	result.beforeBytes = total;
	result.afterBytes = total;
	if (result.capBytes <= 0 || !(await nobodyUses(result))) return;
	// An earlier prune that stopped mid-removal left its renamed directories; no tool names them.
	for (const entry of entries.filter((candidate) => candidate.name.startsWith(TRASH_PREFIX))) {
		await rm(path.join(cacheDir, entry.name), { recursive: true, force: true }).catch(() => {});
	}
	entries = entries.filter((entry) => !entry.name.startsWith(TRASH_PREFIX));
	total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
	result.afterBytes = total;
	const candidates = entries
		.filter((entry) => entry.toolDir)
		.sort((a, b) => a.lastUsedMs - b.lastUsedMs || a.name.localeCompare(b.name));
	for (const entry of candidates) {
		if (total <= result.capBytes) break;
		if (stopped?.() === true) {
			result.skipped = "stopped";
			break;
		}
		if (!(await nobodyUses(result))) break;
		const source = path.join(cacheDir, entry.name);
		const trash = path.join(cacheDir, `${TRASH_PREFIX}${entry.name}-${process.pid}-${Date.now()}`);
		try {
			const stats = await lstat(source);
			// Replaced by a link or a file since the walk: not a tool directory any more, and never followed.
			if (!stats.isDirectory()) continue;
			await rename(source, trash);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				result.failed.push({ name: entry.name, error: error instanceof Error ? error.message : String(error) });
			continue;
		}
		try {
			await rm(trash, { recursive: true, force: true });
		} catch (error) {
			result.failed.push({ name: entry.name, error: error instanceof Error ? error.message : String(error) });
			continue;
		}
		total -= entry.bytes;
		result.removed.push({ name: entry.name, bytes: entry.bytes });
	}
	result.afterBytes = total;
}

/**
 * The startup prune: at most one completed prune a day, recorded in a stamp
 * beside the leases. A prune that stopped for a lease, another pruner or the
 * host's shutdown records nothing, so the next startup tries again. Null when
 * it was not due, the cap is off or there is no cache.
 */
export async function pruneSandboxCacheDaily(options: {
	capBytes: number;
	cacheDir?: string;
	nowMs?: number;
	stopped?: () => boolean;
}): Promise<SandboxCachePruneResult | null> {
	if (options.capBytes <= 0) return null;
	const cacheDir = options.cacheDir ?? sandboxCacheDir();
	const nowMs = options.nowMs ?? Date.now();
	const stamp = path.join(leaseDir(cacheDir), ".prune.stamp");
	const last = Number((await readFile(stamp, "utf8").catch(() => "")).trim() || Number.NaN);
	if (Number.isFinite(last) && last <= nowMs && nowMs - last < DAY_MS) return null;
	const result = await pruneSandboxCache({
		capBytes: options.capBytes,
		cacheDir,
		...(options.stopped !== undefined ? { stopped: options.stopped } : {}),
	});
	if (result.beforeBytes === null || result.skipped !== null) return result;
	await writeFile(stamp, `${nowMs}\n`).catch(() => {});
	return result;
}
