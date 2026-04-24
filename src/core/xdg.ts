import { mkdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Resolve per-platform config/data/cache directories for Clio.
 *
 * Linux: XDG Base Directory spec. macOS: ~/Library paths. Windows: %APPDATA%/%LOCALAPPDATA%.
 * Overrides: CLIO_HOME short-circuits everything (data + config + cache under one dir).
 * Individual overrides: CLIO_DATA_DIR, CLIO_CONFIG_DIR, CLIO_CACHE_DIR.
 */

let cachedDataDir: string | undefined;
let cachedCacheDir: string | undefined;
let cachedConfigDir: string | undefined;

function envOrNull(key: string): string | null {
	const v = process.env[key]?.trim();
	return v && v.length > 0 ? v : null;
}

function platformDefaults(): { data: string; cache: string; config: string } {
	const p = platform();
	const h = homedir();
	if (p === "win32") {
		const appData = process.env.APPDATA ?? join(h, "AppData", "Roaming");
		const localAppData = process.env.LOCALAPPDATA ?? join(h, "AppData", "Local");
		return {
			data: join(appData, "clio"),
			cache: join(localAppData, "Temp", "clio"),
			config: join(appData, "clio"),
		};
	}
	if (p === "darwin") {
		return {
			data: join(h, "Library", "Application Support", "clio"),
			cache: join(h, "Library", "Caches", "clio"),
			config: join(h, "Library", "Application Support", "clio"),
		};
	}
	const xdgData = process.env.XDG_DATA_HOME ?? join(h, ".local", "share");
	const xdgCache = process.env.XDG_CACHE_HOME ?? join(h, ".cache");
	const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(h, ".config");
	return { data: join(xdgData, "clio"), cache: join(xdgCache, "clio"), config: join(xdgConfig, "clio") };
}

function ensureDir(dir: string): string {
	try {
		mkdirSync(dir, { recursive: true });
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code !== "EEXIST") throw err;
	}
	const s = statSync(dir);
	if (!s.isDirectory()) throw new Error(`Expected directory at ${dir}`);
	return dir;
}

function clioHomeOrNull(): string | null {
	return envOrNull("CLIO_HOME");
}

export function resolveClioDirs(): { data: string; cache: string; config: string } {
	const overrideData =
		envOrNull("CLIO_DATA_DIR") ?? (clioHomeOrNull() ? join(clioHomeOrNull() as string, "data") : null);
	const overrideCache =
		envOrNull("CLIO_CACHE_DIR") ?? (clioHomeOrNull() ? join(clioHomeOrNull() as string, "cache") : null);
	const overrideConfig = envOrNull("CLIO_CONFIG_DIR") ?? (clioHomeOrNull() ? (clioHomeOrNull() as string) : null);
	const defaults = platformDefaults();
	return {
		data: overrideData ?? defaults.data,
		cache: overrideCache ?? defaults.cache,
		config: overrideConfig ?? defaults.config,
	};
}

export function clioDataDir(): string {
	if (cachedDataDir) return cachedDataDir;
	cachedDataDir = ensureDir(resolveClioDirs().data);
	return cachedDataDir;
}

export function clioCacheDir(): string {
	if (cachedCacheDir) return cachedCacheDir;
	cachedCacheDir = ensureDir(resolveClioDirs().cache);
	return cachedCacheDir;
}

export function clioConfigDir(): string {
	if (cachedConfigDir) return cachedConfigDir;
	cachedConfigDir = ensureDir(resolveClioDirs().config);
	return cachedConfigDir;
}

export function clioDataPath(): string {
	return cachedDataDir ?? resolveClioDirs().data;
}

export function clioCachePath(): string {
	return cachedCacheDir ?? resolveClioDirs().cache;
}

export function clioConfigPath(): string {
	return cachedConfigDir ?? resolveClioDirs().config;
}

export function resetXdgCache(): void {
	cachedDataDir = undefined;
	cachedCacheDir = undefined;
	cachedConfigDir = undefined;
}
