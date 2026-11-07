/**
 * Whether work may refresh Clio's shared disposable state: the caches and
 * probe-learned priors every later process reads (parsed skill frontmatter,
 * per-target model snapshots, endpoint slot counts, first-use assets and their
 * failure records, semantic indexes, MCP catalogs, Copilot session records;
 * a codewiki build worker thread receives the mode at spawn), and the project's
 * own `.clio-coder/` (its index, state, ignore file and one-time layout
 * conversion), so the workspace is left as found too. Doctor, `run --read-only`
 * and a read-only worker promise to change nothing, yet they load skills and
 * probe targets like any other run. In read-only mode they still read that
 * state, but every cache and prior is left as it was found, and nothing else
 * is written to the Clio home either: a run keeps its session, run records and
 * telemetry in memory (`home-write-guard.ts`). The writers consult this, so no caller has to know
 * which of its loads or probes would have written. Each consults it at the
 * write itself, after the last await before it, so work already pending when
 * the mode begins writes nothing either.
 *
 * A process whose whole job is read-only enters the mode for good. Work inside
 * a process that writes, such as the terminal's `/doctor`, runs in a scope that
 * holds across awaits.
 */

import { AsyncLocalStorage } from "node:async_hooks";

let readOnlyForGood = false;
const readOnlyScope = new AsyncLocalStorage<true>();

/** One-way: this process reads Clio's caches and priors from now on but refreshes none of them. */
export function enterReadOnlyMode(): void {
	readOnlyForGood = true;
}

/** Run `work` in read-only mode, including whatever it awaits, inside a process that may write. */
export function withReadOnlyMode<T>(work: () => T): T {
	return readOnlyScope.run(true, work);
}

/** True when the current work must leave Clio's shared caches and priors as it found them. */
export function readOnlyMode(): boolean {
	return readOnlyForGood || readOnlyScope.getStore() === true;
}

/** True once the process entered read-only mode for good, so nothing it holds in memory is ever persisted. */
export function readOnlyProcess(): boolean {
	return readOnlyForGood;
}
