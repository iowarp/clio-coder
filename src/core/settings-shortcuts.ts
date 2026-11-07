/**
 * Pinned and recently changed settings for the interactive Settings screen.
 *
 * These are UI personalization, not effective configuration, so they live in the
 * state dir (settings-shortcuts.json) and never in settings.yaml. Writing them
 * to settings would fire the config watcher in every other running session
 * each time someone pins a row. Entries are settings row ids; ids whose row no
 * longer exists (a deleted profile) are simply not shown.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "./safe-resource-write.js";
import { clioStateDir, stateRootRemoved } from "./xdg.js";

export interface SettingsShortcuts {
	/** Pinned row ids in the order they were pinned, oldest first. */
	pinned: string[];
	/** Successfully changed row ids, newest first. */
	recent: string[];
}

/** Stored beyond what is shown so rows that vanish do not starve the visible list. */
const STORED_RECENT_LIMIT = 36;
const STORED_PIN_LIMIT = 60;

function shortcutsPath(): string {
	return join(clioStateDir(), "settings-shortcuts.json");
}

let cache: SettingsShortcuts | null = null;
let cachePath: string | null = null;

function cleanIds(value: unknown, limit: number): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const id = entry.trim();
		if (id.length === 0 || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
		if (out.length >= limit) break;
	}
	return out;
}

function readFromDisk(path: string): SettingsShortcuts | null {
	if (!existsSync(path)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		const record =
			parsed !== null && typeof parsed === "object" ? (parsed as { pinned?: unknown; recent?: unknown }) : {};
		return {
			pinned: cleanIds(record.pinned, STORED_PIN_LIMIT),
			recent: cleanIds(record.recent, STORED_RECENT_LIMIT),
		};
	} catch {
		// A corrupted file counts as empty: personalization is never worth blocking Settings.
		return { pinned: [], recent: [] };
	}
}

/** Current shortcuts. An absent or unreadable file is empty. */
export function listSettingsShortcuts(): SettingsShortcuts {
	const path = shortcutsPath();
	if (cache === null || cachePath !== path) {
		cache = readFromDisk(path) ?? { pinned: [], recent: [] };
		cachePath = path;
	}
	return { pinned: [...cache.pinned], recent: [...cache.recent] };
}

function commit(update: (base: SettingsShortcuts) => SettingsShortcuts): SettingsShortcuts {
	const path = shortcutsPath();
	// Re-read so pins from another running session merge in instead of being overwritten.
	const base = readFromDisk(path) ?? (cachePath === path && cache !== null ? cache : { pinned: [], recent: [] });
	const next = update({ pinned: [...base.pinned], recent: [...base.recent] });
	cache = next;
	cachePath = path;
	// A Settings screen outliving `clio-coder uninstall` must not rebuild the state root.
	if (stateRootRemoved()) return { pinned: [...next.pinned], recent: [...next.recent] };
	try {
		safeResourceWrite(path, `${JSON.stringify(next, null, "\t")}\n`, { encoding: "utf8" });
	} catch {
		// Best-effort: the in-memory list still serves the rest of this session.
	}
	return { pinned: [...next.pinned], recent: [...next.recent] };
}

/** Pin or unpin one row. */
export function setSettingPinned(id: string, pinned: boolean): SettingsShortcuts {
	return commit((base) => ({
		pinned: pinned
			? [...base.pinned.filter((entry) => entry !== id), id].slice(-STORED_PIN_LIMIT)
			: base.pinned.filter((entry) => entry !== id),
		recent: base.recent,
	}));
}

/** Move a successfully changed row to the front of the recent list. */
export function rememberChangedSetting(id: string): SettingsShortcuts {
	return commit((base) => ({
		pinned: base.pinned,
		recent: [id, ...base.recent.filter((entry) => entry !== id)].slice(0, STORED_RECENT_LIMIT),
	}));
}
