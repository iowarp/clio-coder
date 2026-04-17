/**
 * Low-level settings read/write. The config domain wraps this module with watcher,
 * hot-reload, and event emission. Kept in core/ because multiple domains (providers,
 * modes, prompts) need settings access before the domain loader has finished booting.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DEFAULT_SETTINGS } from "./defaults.js";
import { clioConfigDir } from "./xdg.js";

export type ClioSettings = typeof DEFAULT_SETTINGS;

export function settingsPath(): string {
	return join(clioConfigDir(), "settings.yaml");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

export function mergeSettings<T>(defaults: T, overrides: unknown): T {
	if (overrides === undefined) return cloneValue(defaults);
	if (Array.isArray(defaults)) {
		return Array.isArray(overrides) ? cloneValue(overrides as T) : cloneValue(defaults);
	}
	if (isPlainObject(defaults) && isPlainObject(overrides)) {
		const next = cloneValue(defaults) as Record<string, unknown>;
		for (const [key, overrideValue] of Object.entries(overrides)) {
			if (!(key in next)) {
				next[key] = cloneValue(overrideValue);
				continue;
			}
			next[key] = mergeSettings(next[key], overrideValue);
		}
		return next as T;
	}
	return cloneValue(overrides as T);
}

export function readSettings(): ClioSettings {
	const path = settingsPath();
	if (!existsSync(path)) return structuredClone(DEFAULT_SETTINGS);
	const raw = readFileSync(path, "utf8");
	const parsed = parseYaml(raw) as Partial<ClioSettings> | null;
	return mergeSettings(DEFAULT_SETTINGS, parsed ?? {});
}

export function writeSettings(settings: ClioSettings): void {
	writeFileSync(settingsPath(), stringifyYaml(settings), { encoding: "utf8", mode: 0o644 });
}
