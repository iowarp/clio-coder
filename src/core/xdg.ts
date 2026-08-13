import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Resolve per-platform config/data/state/cache directories for Clio.
 *
 * This is the single resolution order, documented once:
 *   1. Platform defaults.
 *      Linux: XDG Base Directory spec (XDG_CONFIG_HOME, XDG_DATA_HOME,
 *      XDG_STATE_HOME, XDG_CACHE_HOME).
 *      macOS: ~/Library/Application Support/clio/{config,data,state} and
 *      ~/Library/Caches/clio.
 *      Windows: %APPDATA%/clio/{config,data} and %LOCALAPPDATA%/clio/{state,cache}.
 *      Every root is distinct on every platform; no root nests inside another.
 *   2. CLIO_HOME replaces all four roots symmetrically with
 *      CLIO_HOME/{config,data,state,cache}.
 *   3. CLIO_CONFIG_DIR / CLIO_DATA_DIR / CLIO_STATE_DIR / CLIO_CACHE_DIR each
 *      override their one root and beat CLIO_HOME (most specific wins).
 *
 * Role contents: config holds user-authored files (settings, credentials,
 * agents, skills, prompts, extensions, runtimes); data holds durable artifacts
 * (memory, evidence, evals); state holds machine-produced session state
 * (sessions, audit, receipts, runs.json, recent-models.json, install.json,
 * interviews, scratch); cache holds disposable derived files.
 */

export interface ClioDirs {
	config: string;
	data: string;
	state: string;
	cache: string;
}

let cachedConfigDir: string | undefined;
let cachedDataDir: string | undefined;
let cachedStateDir: string | undefined;
let cachedCacheDir: string | undefined;

function envOrNull(key: string): string | null {
	const v = process.env[key]?.trim();
	return v && v.length > 0 ? v : null;
}

function platformDefaults(): ClioDirs {
	const p = platform();
	const h = homedir();
	if (p === "win32") {
		const appData = process.env.APPDATA ?? join(h, "AppData", "Roaming");
		const localAppData = process.env.LOCALAPPDATA ?? join(h, "AppData", "Local");
		return {
			config: join(appData, "clio", "config"),
			data: join(appData, "clio", "data"),
			state: join(localAppData, "clio", "state"),
			cache: join(localAppData, "clio", "cache"),
		};
	}
	if (p === "darwin") {
		const base = join(h, "Library", "Application Support", "clio");
		return {
			config: join(base, "config"),
			data: join(base, "data"),
			state: join(base, "state"),
			cache: join(h, "Library", "Caches", "clio"),
		};
	}
	const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(h, ".config");
	const xdgData = process.env.XDG_DATA_HOME ?? join(h, ".local", "share");
	const xdgState = process.env.XDG_STATE_HOME ?? join(h, ".local", "state");
	const xdgCache = process.env.XDG_CACHE_HOME ?? join(h, ".cache");
	return {
		config: join(xdgConfig, "clio"),
		data: join(xdgData, "clio"),
		state: join(xdgState, "clio"),
		cache: join(xdgCache, "clio"),
	};
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

function resolveRole(specificVar: string, role: keyof ClioDirs, defaults: ClioDirs): string {
	const specific = envOrNull(specificVar);
	if (specific) return specific;
	const home = clioHomeOrNull();
	if (home) return join(home, role);
	return defaults[role];
}

export function resolveClioDirs(): ClioDirs {
	const defaults = platformDefaults();
	return {
		config: resolveRole("CLIO_CONFIG_DIR", "config", defaults),
		data: resolveRole("CLIO_DATA_DIR", "data", defaults),
		state: resolveRole("CLIO_STATE_DIR", "state", defaults),
		cache: resolveRole("CLIO_CACHE_DIR", "cache", defaults),
	};
}

export function clioConfigDir(): string {
	if (cachedConfigDir) return cachedConfigDir;
	cachedConfigDir = ensureDir(resolveClioDirs().config);
	return cachedConfigDir;
}

export function clioDataDir(): string {
	if (cachedDataDir) return cachedDataDir;
	cachedDataDir = ensureDir(resolveClioDirs().data);
	return cachedDataDir;
}

export function clioStateDir(): string {
	if (cachedStateDir) return cachedStateDir;
	cachedStateDir = ensureDir(resolveClioDirs().state);
	return cachedStateDir;
}

export function clioCacheDir(): string {
	if (cachedCacheDir) return cachedCacheDir;
	cachedCacheDir = ensureDir(resolveClioDirs().cache);
	return cachedCacheDir;
}

export function clioStatePath(): string {
	return cachedStateDir ?? resolveClioDirs().state;
}

/**
 * True when the state root this process resolved is no longer on disk.
 *
 * `clio uninstall` removes the whole root while processes holding session
 * writers, ledgers and audit files are still running, and every writer under
 * the root mkdirs its parent back: `safeResourceWrite` does it before the temp
 * file, the state file lock does it before the critical section, the audit
 * writer does it before opening the day's file. A write landing after the
 * removal therefore recreated the state home, so an uninstall that reported
 * success left one behind and the next `clio` start read state from a home that
 * was supposed to be gone. The live case was the shutdown checkpoint, roughly
 * two minutes late, rebuilding the root around a meta.json and tree.json that
 * announced `lastCheckpointReason: shutdown`.
 *
 * "Removed" and "never created" are not the same thing, and only the first is a
 * reason to refuse a write. With no cached root this process has not resolved
 * one yet, so a writer creating it is an ordinary first run; the audit writer
 * reaches its first row before anything else has called `clioStateDir()`, and
 * treating that as an uninstall silently disabled audit on a fresh install.
 * Reads the cache directly rather than `clioStateDir()` because the latter
 * creates the directory it is being asked about.
 *
 * Every writer under the state root calls this before it touches disk, and
 * again inside whatever lock it holds, because the removal can land while the
 * call waits for a sibling process to leave its critical section.
 */
export function stateRootRemoved(): boolean {
	if (cachedStateDir === undefined) return false;
	return !existsSync(cachedStateDir);
}

export function resetXdgCache(): void {
	cachedConfigDir = undefined;
	cachedDataDir = undefined;
	cachedStateDir = undefined;
	cachedCacheDir = undefined;
}
