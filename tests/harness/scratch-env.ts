/**
 * One home for Clio state isolation in tests. Every test that touches Clio state
 * needs a throwaway `CLIO_CODER_HOME` with the five per-root `CLIO_CODER_*_DIR` vars pointing
 * inside it (per-root vars beat `CLIO_CODER_HOME`, so they must move in lockstep), and
 * in-process tests must also reset the XDG cache so `src/` re-resolves the scratch
 * dirs. This module is the single implementation the harness and contract tests
 * delegate to, in three flavors matching the three call sites:
 *
 *   - makeScratchHome()  — child-process isolation: returns an env to hand a
 *     spawned binary (does not mutate process.env).
 *   - isolateClioEnv()   — in-process isolation with a full env backup/restore.
 *   - newScratchClioHome()/clearScratchClioHome() — in-process isolation that
 *     keeps the scratch dir as a plain string (minimal beforeEach/afterEach edit).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetXdgCache } from "../../src/core/xdg.js";

export interface ScratchClioEnvOptions {
	/** Set CLIO_CODER_REQUIRE_HOME_PREFIX=1 (child-process/binary isolation wants this; in-process tests do not). */
	requireHomePrefix?: boolean;
}

/** The CLIO_* env vars that isolate all Clio state under `dir`. */
export function scratchClioEnvVars(dir: string, options: ScratchClioEnvOptions = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		CLIO_CODER_HOME: dir,
		CLIO_CODER_DATA_DIR: join(dir, "data"),
		CLIO_CODER_CONFIG_DIR: join(dir, "config"),
		CLIO_CODER_STATE_DIR: join(dir, "state"),
		CLIO_CODER_CACHE_DIR: join(dir, "cache"),
	};
	if (options.requireHomePrefix) env.CLIO_CODER_REQUIRE_HOME_PREFIX = "1";
	return env;
}

export interface ScratchHome {
	dir: string;
	env: NodeJS.ProcessEnv;
	cleanup: () => void;
}

/**
 * Child-process isolation: make a fresh scratch home and return its dir, the
 * CLIO_* env to hand a spawned binary (including CLIO_CODER_REQUIRE_HOME_PREFIX), and a
 * cleanup. Does not touch process.env — the child reads env fresh.
 */
export function makeScratchHome(prefix = "clio-e2e-"): ScratchHome {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	return {
		dir,
		env: scratchClioEnvVars(dir, { requireHomePrefix: true }),
		cleanup() {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		},
	};
}

/**
 * Point process.env at a fresh scratch home and reset the XDG cache so in-process
 * `src/` code resolves the scratch dirs. Returns the dir as a plain string; pair
 * it with clearScratchClioHome(dir) in afterEach. Does not back up process.env.
 */
export function newScratchClioHome(prefix = "clio-scratch-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	Object.assign(process.env, scratchClioEnvVars(dir));
	resetXdgCache();
	return dir;
}

/** Remove a scratch home created by newScratchClioHome and reset the XDG cache. */
export function clearScratchClioHome(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
	resetXdgCache();
}

export interface IsolatedClioEnv {
	dir: string;
	restore: () => void;
}

/**
 * In-process isolation with a full process.env snapshot: mkdtemp a scratch home,
 * point the CLIO_* vars at it, reset the XDG cache, and return restore() that
 * undoes every env change (removing keys the test added), removes the scratch,
 * and resets the cache again. Use this where a test must leave process.env
 * exactly as it found it.
 */
export function isolateClioEnv(prefix = "clio-scratch-"): IsolatedClioEnv {
	const envBackup: NodeJS.ProcessEnv = { ...process.env };
	const dir = mkdtempSync(join(tmpdir(), prefix));
	Object.assign(process.env, scratchClioEnvVars(dir));
	resetXdgCache();
	return {
		dir,
		restore() {
			for (const key of Object.keys(process.env)) {
				if (!(key in envBackup)) Reflect.deleteProperty(process.env, key);
			}
			for (const [key, value] of Object.entries(envBackup)) {
				if (value !== undefined) process.env[key] = value;
			}
			rmSync(dir, { recursive: true, force: true });
			resetXdgCache();
		},
	};
}
