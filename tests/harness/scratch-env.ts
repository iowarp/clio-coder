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
 *
 * The in-process flavors point `process.env.CLIO_CODER_*` at a scratch dir and
 * restore it later; that window is a single process-wide critical section, not
 * a per-test one. Under `--experimental-test-isolation=none` every contract file
 * shares one process, and Node's own test-runner scheduling can interleave two
 * files' beforeEach/afterEach even when neither file's own test bodies do
 * anything concurrent (issue #84: `interop-consent.test.ts` and
 * `interop-state.test.ts`, both fully synchronous test bodies, still clobbered
 * each other's `CLIO_CODER_HOME` at full-suite scale; the gap the runner
 * itself inserts between hook invocations was enough). Acquiring an
 * in-process lock before mutating `process.env` and releasing it on restore
 * serializes every window process-wide, so two isolated-env regions from
 * different files can never overlap in wall-clock time regardless of how the
 * runner schedules them. `makeScratchHome()` never touches `process.env`, so
 * it does not need the lock.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetXdgCache } from "../../src/core/xdg.js";

let envLockChain: Promise<void> = Promise.resolve();

/**
 * Queues behind whatever isolated-env window is currently open and returns a
 * release function; call it exactly once when this window's env mutation is
 * fully undone. Every acquire before it must release before this one resolves.
 */
async function acquireEnvLock(): Promise<() => void> {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const previous = envLockChain;
	envLockChain = gate;
	await previous;
	return release;
}

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

/** Release functions for open newScratchClioHome() windows, keyed by scratch dir. */
const openScratchHomeReleases = new Map<string, () => void>();

/**
 * Point process.env at a fresh scratch home and reset the XDG cache so in-process
 * `src/` code resolves the scratch dirs. Returns the dir as a plain string; pair
 * it with clearScratchClioHome(dir) in afterEach. Does not back up process.env.
 *
 * Async because it queues behind the process-wide env lock (see module header):
 * `beforeEach` must `await` it so a concurrently-scheduled suite's own window
 * can't open while this one is still live.
 */
export async function newScratchClioHome(prefix = "clio-scratch-"): Promise<string> {
	const release = await acquireEnvLock();
	const dir = mkdtempSync(join(tmpdir(), prefix));
	openScratchHomeReleases.set(dir, release);
	Object.assign(process.env, scratchClioEnvVars(dir));
	resetXdgCache();
	return dir;
}

/** Remove a scratch home created by newScratchClioHome, reset the XDG cache, and release the env lock. */
export function clearScratchClioHome(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
	resetXdgCache();
	const release = openScratchHomeReleases.get(dir);
	if (release) {
		openScratchHomeReleases.delete(dir);
		release();
	}
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
 *
 * Async for the same reason as newScratchClioHome(): it queues behind the
 * process-wide env lock, so `beforeEach` must `await` it.
 */
export async function isolateClioEnv(prefix = "clio-scratch-"): Promise<IsolatedClioEnv> {
	const release = await acquireEnvLock();
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
			release();
		},
	};
}
