/**
 * The one choke point for "read-only writes nothing to the Clio home" (0.7.0).
 *
 * While `readOnlyMode()` is on, the atomic resource write refuses any path
 * inside the operator's config, data, state or cache dir with
 * `ClioHomeReadOnlyError`, and the state file lock runs its section without
 * creating a lock file. A writer that should keep working asks
 * `clioHomeWriteRefused` (or `stateWritesWithheld`) first and keeps its state
 * in memory instead: the session engine, the telemetry journals and objects,
 * the run ledger, assignments and capacity leases. One that reaches the write
 * helper anyway fails loudly rather than leaving a file behind.
 *
 * A writer decides when it opens, so a session or journal opened inside a
 * scoped read-only section (the terminal's `/doctor`) stays in memory for its
 * life.
 *
 * The operator's dirs are the ones named before any move this process made: a
 * read-only run on a never-set-up home works in a private home under the temp
 * dir, which stays writable because it is removed at exit, while the home it
 * replaced stays refused.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { readOnlyMode } from "./read-only-mode.js";
import { clioStatePath, operatorClioDirs, stateRootRemoved } from "./xdg.js";

export class ClioHomeReadOnlyError extends Error {
	readonly code = "CLIO_CODER_READ_ONLY_HOME";
	constructor(readonly path: string) {
		super(`read-only mode: refusing to write ${path} inside the Clio home`);
		this.name = "ClioHomeReadOnlyError";
	}
}

function within(root: string, path: string): boolean {
	const rel = relative(resolve(root), resolve(path));
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** True when the current work is read-only and `path` lies in one of the operator's Clio dirs. */
export function clioHomeWriteRefused(path: string): boolean {
	if (!readOnlyMode()) return false;
	const dirs = operatorClioDirs();
	return [dirs.config, dirs.data, dirs.state, dirs.cache].some((root) => within(root, path));
}

/** Throws `ClioHomeReadOnlyError` when `clioHomeWriteRefused(path)`. */
export function assertClioHomeWritable(path: string): void {
	if (clioHomeWriteRefused(path)) throw new ClioHomeReadOnlyError(path);
}

/**
 * True when a writer under the state root must keep what it holds in memory:
 * the root was removed (`stateRootRemoved`) or read-only mode refuses it. The
 * writers that already skipped a removed root skip a read-only one the same way.
 */
export function stateWritesWithheld(): boolean {
	return stateRootRemoved() || clioHomeWriteRefused(clioStatePath());
}
