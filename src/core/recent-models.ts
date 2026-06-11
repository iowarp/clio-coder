/**
 * Recently selected target/model refs ("targetId/wireModelId").
 *
 * Recents are runtime state, not user configuration, so they live in the data
 * dir (state/recent-models.json) instead of settings.yaml. Keeping them out of
 * the settings file means an Alt+L model pick no longer rewrites settings.yaml
 * just to bump a recency list, which previously fired the config watcher in
 * every other running session. Favorites (modelSelector.favorites) remain in
 * settings.yaml because they are deliberate user configuration.
 *
 * Migration: settings files written before this split carry the list under
 * state.recentModels. The first read that finds no data-dir file seeds it from
 * that legacy list. The legacy key stays schema-valid and is left in place;
 * it simply stops being updated.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clioDataDir } from "./xdg.js";

export function recentModelsPath(): string {
	return join(clioDataDir(), "state", "recent-models.json");
}

let cache: string[] | null = null;
let cachePath: string | null = null;

function readFromDisk(path: string): string[] | null {
	if (!existsSync(path)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!Array.isArray(parsed)) return [];
		const seen = new Set<string>();
		const out: string[] = [];
		for (const entry of parsed) {
			if (typeof entry !== "string") continue;
			const trimmed = entry.trim();
			if (trimmed.length === 0 || seen.has(trimmed)) continue;
			seen.add(trimmed);
			out.push(trimmed);
		}
		return out;
	} catch {
		// A corrupted file counts as empty rather than absent so a stale legacy
		// settings list cannot resurrect over fresher (but unreadable) state.
		return [];
	}
}

function writeToDisk(path: string, refs: ReadonlyArray<string>): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(refs, null, "\t")}\n`, "utf8");
	renameSync(tmp, path);
}

/**
 * Current recents, newest first, truncated to `limit`. When the data-dir file
 * does not exist yet and `migrateFrom` (the legacy state.recentModels list) is
 * provided, it seeds both the cache and the file once. Without `migrateFrom`
 * an absent file is treated as empty but not cached, so a later call that does
 * carry the legacy list can still migrate it.
 */
export function listRecentModels(options?: { migrateFrom?: ReadonlyArray<string>; limit?: number }): string[] {
	const path = recentModelsPath();
	if (cache === null || cachePath !== path) {
		const disk = readFromDisk(path);
		if (disk !== null) {
			cache = disk;
			cachePath = path;
		} else if (options?.migrateFrom !== undefined) {
			const migrated = [...options.migrateFrom];
			cache = migrated;
			cachePath = path;
			if (migrated.length > 0) {
				try {
					writeToDisk(path, migrated);
				} catch {
					// Recents are best-effort convenience state; a failed write must
					// never break model selection.
				}
			}
		} else {
			return [];
		}
	}
	const limit = Math.max(1, Math.floor(options?.limit ?? 12));
	return cache.slice(0, limit);
}

/** Move `ref` to the front of the recents list and persist to the data dir. */
export function rememberRecentModel(ref: string, limit: number): string[] {
	const path = recentModelsPath();
	// Re-read so refs remembered by other processes since our last load are
	// merged instead of overwritten. Plain last-writer-wins on the file is
	// acceptable for a recency list; no lock needed.
	const base = readFromDisk(path) ?? (cachePath === path && cache !== null ? cache : []);
	const max = Math.max(1, Math.floor(limit));
	const next = [ref, ...base.filter((entry) => entry !== ref)].slice(0, max);
	cache = next;
	cachePath = path;
	try {
		writeToDisk(path, next);
	} catch {
		// Best-effort, as above.
	}
	return next;
}

/** Test hook: clear the in-process cache after CLIO_* dir overrides change. */
export function resetRecentModelsCache(): void {
	cache = null;
	cachePath = null;
}
