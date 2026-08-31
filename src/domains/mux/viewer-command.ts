/**
 * What the workers-view watch pane runs.
 *
 * The argv is `node <this install's dist CLI> fleet view --watch <file>`
 * rather than the `clio-coder` bin name. Resolving through PATH would run
 * whatever copy of Clio the operator's PATH points at, which in a worktree or a
 * multi-install machine is routinely not the one that opened the pane, and the
 * viewer would then read a different install's state root. This is the same
 * self-invocation shape `worker-spawn.ts:589` uses for the same reason.
 *
 * A per-run viewer command (`fleet view <runId> --follow`) used to live here
 * for the per-dispatch viewer panes; those panes are gone, and the one pane
 * that renders runs now follows a selection file so the TUI can retarget it
 * without respawning anything.
 */

import { join } from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";

/** Built CLI entry point, matching the `bin` field in `package.json`. */
export function clioCliEntryPath(): string {
	return join(resolvePackageRoot(), "dist/cli/index.js");
}

export interface ViewerCommandOptions {
	/** Override for tests and for a caller that already resolved the entry. */
	entryPath?: string;
	/** Node binary to run it with; defaults to the one running this process. */
	execPath?: string;
}

/** The argv the watch pane executes: one viewer process following a selection file. */
export function watchViewerCommand(selectionPath: string, options: ViewerCommandOptions = {}): ReadonlyArray<string> {
	return [
		options.execPath ?? process.execPath,
		options.entryPath ?? clioCliEntryPath(),
		"fleet",
		"view",
		"--watch",
		selectionPath,
	];
}
