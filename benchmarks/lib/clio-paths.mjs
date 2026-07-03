/**
 * Shared Clio XDG directory resolver for the JavaScript benchmark and live
 * measurement harnesses (benchmarks/live/live-turns.mjs,
 * benchmarks/live/turn-report.mjs). It resolves Clio's config/data/state/cache
 * directories through `clio paths --json` (the built dist in this checkout),
 * the single source of truth for directory resolution. The embedded fallback
 * below exists only for a broken or missing dist and must mirror src/core/xdg.ts,
 * including the rule that per-root `CLIO_*_DIR` vars beat `CLIO_HOME`.
 *
 * The live-smoke gate (scripts/live-smoke.mjs) creates fresh scratch roots
 * rather than resolving existing ones, so it does not import this module.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

// Repo root is two levels up from benchmarks/lib/.
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const DIST_CLI = join(REPO_ROOT, "dist", "cli", "index.js");
const DIR_KEYS = ["config", "data", "state", "cache"];

function envDir(key) {
	const value = process.env[key]?.trim();
	return value && value.length > 0 ? value : null;
}

/**
 * Resolve all four Clio directories. Prefers the built dist's `clio paths
 * --json`; falls back to the embedded resolver when the dist is missing or
 * broken.
 */
export function clioDirs() {
	if (existsSync(DIST_CLI)) {
		try {
			const raw = execFileSync(process.execPath, [DIST_CLI, "paths", "--json"], {
				encoding: "utf8",
				timeout: 15_000,
				stdio: ["ignore", "pipe", "ignore"],
			});
			const dirs = JSON.parse(raw);
			if (DIR_KEYS.every((key) => typeof dirs[key] === "string" && dirs[key].length > 0)) {
				return { config: dirs.config, data: dirs.data, state: dirs.state, cache: dirs.cache };
			}
		} catch {
			// Broken or missing dist; fall through to the embedded resolution.
		}
	}
	return embeddedDirs();
}

/** Resolve just the Clio state dir (where session ledgers live). */
export function clioStateDir() {
	return clioDirs().state;
}

function platformDefaults() {
	const home = homedir();
	if (platform() === "win32") {
		const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
		const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
		return {
			config: join(appData, "clio", "config"),
			data: join(appData, "clio", "data"),
			state: join(localAppData, "clio", "state"),
			cache: join(localAppData, "clio", "cache"),
		};
	}
	if (platform() === "darwin") {
		const app = join(home, "Library", "Application Support", "clio");
		return {
			config: join(app, "config"),
			data: join(app, "data"),
			state: join(app, "state"),
			cache: join(home, "Library", "Caches", "clio"),
		};
	}
	return {
		config: join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "clio"),
		data: join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "clio"),
		state: join(process.env.XDG_STATE_HOME ?? join(home, ".local", "state"), "clio"),
		cache: join(process.env.XDG_CACHE_HOME ?? join(home, ".cache"), "clio"),
	};
}

function embeddedDirs() {
	const fallback = platformDefaults();
	const clioHome = envDir("CLIO_HOME");
	return {
		config: envDir("CLIO_CONFIG_DIR") ?? (clioHome ? join(clioHome, "config") : fallback.config),
		data: envDir("CLIO_DATA_DIR") ?? (clioHome ? join(clioHome, "data") : fallback.data),
		state: envDir("CLIO_STATE_DIR") ?? (clioHome ? join(clioHome, "state") : fallback.state),
		cache: envDir("CLIO_CACHE_DIR") ?? (clioHome ? join(clioHome, "cache") : fallback.cache),
	};
}
