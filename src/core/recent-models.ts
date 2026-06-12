/**
 * Recently selected target/model refs ("targetId/wireModelId").
 *
 * Recents are runtime state, not user configuration, so they live in the state
 * dir (recent-models.json) and never in settings.yaml. Keeping them out
 * of the settings file means an Alt+L model pick does not rewrite settings.yaml
 * just to bump a recency list, which would fire the config watcher in every
 * other running session. Favorites (modelSelector.favorites) remain in
 * settings.yaml because they are deliberate user configuration.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clioStateDir } from "./xdg.js";

export function recentModelsPath(): string {
	return join(clioStateDir(), "recent-models.json");
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
 * Current recents, newest first, truncated to `limit`. An absent or unreadable
 * file is an empty list.
 */
export function listRecentModels(options?: { limit?: number }): string[] {
	const path = recentModelsPath();
	if (cache === null || cachePath !== path) {
		cache = readFromDisk(path) ?? [];
		cachePath = path;
	}
	const limit = Math.max(1, Math.floor(options?.limit ?? 12));
	return cache.slice(0, limit);
}

/** Move `ref` to the front of the recents list and persist to the state dir. */
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
