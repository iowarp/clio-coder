/**
 * V8 compile cache for the dynamically imported command graphs.
 *
 * The interactive chunk graph alone is ~1,400 ES modules, and V8 compilation
 * of it measures ~227 ms per cold boot (CPU profile, compileSourceTextModule).
 * Node's module compile cache persists the bytecode across processes and cuts
 * that to ~70 ms. The cache is a pure optimization: enableCompileCache() never
 * throws, and a failure to enable it must never affect a command.
 *
 * Enable order matters twice over. In this process, only modules loaded after
 * the call are cached, so the CLI calls this before its per-command dynamic
 * import and after the --help/--version fast paths (which keep their
 * no-filesystem-write contract). Enablement is further gated on Clio's cache
 * root already existing, because read-only commands (`paths`, bare `doctor`)
 * promise to write nothing to a home Clio never set up; a pristine home pays
 * one uncached boot and every initialized install caches from then on. In
 * spawned native workers, the entry's whole
 * static graph resolves before any application code runs, so the only lever
 * that reaches them in time is the NODE_COMPILE_CACHE environment variable;
 * the dispatch spawn path injects it alongside {@link INJECTED_COMPILE_CACHE_ENV}.
 *
 * The injection is for Clio's own worker entry, not for the worker's
 * descendants: bash tool commands, middleware hooks, and external runtime
 * subprocesses all copy the worker's process.env, and without consumption
 * every user-launched Node process would silently write bytecode into Clio's
 * cache. The marker records that Clio, not the operator, put
 * NODE_COMPILE_CACHE in this environment; the worker entry calls
 * {@link deleteInjectedCompileCacheFrom} on its own process.env immediately
 * after Node's bootstrap read it, so no child of any kind can inherit the
 * pair. An operator-supplied NODE_COMPILE_CACHE never carries the marker and
 * always passes through.
 *
 * Operator controls win everywhere: NODE_DISABLE_COMPILE_CACHE turns this off
 * entirely, and an existing NODE_COMPILE_CACHE names the directory (Node reads
 * it when enableCompileCache is called with no argument).
 */

import { existsSync } from "node:fs";
import { enableCompileCache } from "node:module";
import { join } from "node:path";
import { resolveClioDirs } from "./xdg.js";

/**
 * Marks a NODE_COMPILE_CACHE value Clio itself injected into a child env. Its
 * value is the injected directory, which is what lets the scrub distinguish
 * Clio's injection from a NODE_COMPILE_CACHE the operator set.
 */
export const INJECTED_COMPILE_CACHE_ENV = "CLIO_CODER_INJECTED_COMPILE_CACHE";

export interface CompileCacheHandle {
	/**
	 * Enable the compile cache for this process. The first call settles the
	 * outcome, directory or null, and every later call returns that settled
	 * value: a run that started disabled or failed must not enable itself on a
	 * retry with a different environment.
	 */
	enable(env?: NodeJS.ProcessEnv): string | null;
	/** The settled directory, or null while unattempted, disabled, or failed. */
	directory(): string | null;
}

/**
 * Testable factory. Production uses the module-level instance below bound to
 * Node's real enableCompileCache and existsSync; tests inject stubs so they
 * exercise the settle semantics without flipping the real process-global
 * cache.
 */
export function createCompileCache(
	enableFn: typeof enableCompileCache = enableCompileCache,
	rootExists: (dir: string) => boolean = existsSync,
): CompileCacheHandle {
	let settled: string | null | undefined;
	return {
		enable(env = process.env) {
			if (settled !== undefined) return settled;
			if (env.NODE_DISABLE_COMPILE_CACHE !== undefined) {
				settled = null;
				return settled;
			}
			try {
				if (env.NODE_COMPILE_CACHE !== undefined) {
					// Presence is the operator speaking, even as an empty string,
					// matching the worker boundary's presence check. No argument:
					// Node interprets the operator's NODE_COMPILE_CACHE itself, and
					// Clio's default must not override it.
					settled = enableFn().directory ?? null;
					return settled;
				}
				// Enabling creates the directory, and diagnostic commands carry a
				// read-only contract: `paths` and `doctor` without --fix must write
				// nothing to a home Clio never set up. Clio's cache root existing is
				// the proof this install was set up, so only then is a write inside
				// it a cache write rather than a first write to a pristine home.
				const root = resolveClioDirs().cache;
				if (!rootExists(root)) {
					settled = null;
					return settled;
				}
				settled = enableFn(join(root, "v8-compile-cache")).directory ?? null;
			} catch {
				settled = null;
			}
			return settled;
		},
		directory: () => settled ?? null,
	};
}

const processCompileCache = createCompileCache();

/**
 * Enable the cache for this process; see {@link CompileCacheHandle.enable}.
 * The boot entrypoints call it for their own module graphs, and the native
 * worker spawn path calls it so children receive a NODE_COMPILE_CACHE they
 * can act on before their module graph resolves.
 */
export function enableClioCompileCache(env?: NodeJS.ProcessEnv): string | null {
	return processCompileCache.enable(env);
}

/**
 * The environment a native worker spawn should hand its child. A preexisting
 * marker never survives: the marker is Clio's own plumbing, and letting one
 * ride into a worker beside operator controls is how a stale or spoofed
 * marker whose value happens to equal the operator's NODE_COMPILE_CACHE
 * would later make the worker-entry scrub delete that operator setting for
 * every descendant. When the operator named or disabled the cache, their
 * controls pass through alone; otherwise, if this process enabled the cache,
 * the bound pair is injected so the worker's module graph compiles from it.
 */
export function workerCompileCacheEnvironment(env: NodeJS.ProcessEnv, directory: string | null): NodeJS.ProcessEnv {
	const operatorControlled = env.NODE_COMPILE_CACHE !== undefined || env.NODE_DISABLE_COMPILE_CACHE !== undefined;
	if (operatorControlled || directory === null) {
		if (env[INJECTED_COMPILE_CACHE_ENV] === undefined) return env;
		const cleaned = { ...env };
		Reflect.deleteProperty(cleaned, INJECTED_COMPILE_CACHE_ENV);
		return cleaned;
	}
	return { ...env, NODE_COMPILE_CACHE: directory, [INJECTED_COMPILE_CACHE_ENV]: directory };
}

/**
 * Consume a Clio-injected compile-cache pair from an env, in place. The
 * marker carries the injected directory as its value, and NODE_COMPILE_CACHE
 * is deleted only when it still equals that value: a stale or spoofed marker
 * sitting next to some other NODE_COMPILE_CACHE removes only itself. The one
 * production caller is the worker entry, on its own process.env, immediately
 * after Node's bootstrap read the pair; by construction that pair came from
 * {@link workerCompileCacheEnvironment}, which never lets a marker travel
 * beside operator controls.
 */
export function deleteInjectedCompileCacheFrom(env: NodeJS.ProcessEnv): void {
	const injected = env[INJECTED_COMPILE_CACHE_ENV];
	if (injected === undefined) return;
	if (env.NODE_COMPILE_CACHE === injected) {
		Reflect.deleteProperty(env, "NODE_COMPILE_CACHE");
	}
	Reflect.deleteProperty(env, INJECTED_COMPILE_CACHE_ENV);
}
