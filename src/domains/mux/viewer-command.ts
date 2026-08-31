/**
 * What a run viewer pane runs.
 *
 * Phase 1 left `createMuxRuntime`'s `viewerCommand` hook unwired, so a viewer
 * pane was a plain shell in the Fleet tab. Phase 2 shipped the viewer as
 * `clio-coder fleet view <runId> [--follow]` (the spec's `clio run view` never
 * existed in this tree), so the hook now has something to run.
 *
 * The argv is `node <this install's dist CLI> fleet view <runId> --follow`
 * rather than the `clio-coder` bin name. Resolving through PATH would run
 * whatever copy of Clio the operator's PATH points at, which in a worktree or a
 * multi-install machine is routinely not the one that opened the pane, and the
 * viewer would then read a different install's state root. This is the same
 * self-invocation shape `worker-spawn.ts:589` uses for the same reason.
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
	follow?: boolean;
}

/** The argv a viewer pane executes for one run. */
export function runViewerCommand(runId: string, options: ViewerCommandOptions = {}): ReadonlyArray<string> {
	const argv = [options.execPath ?? process.execPath, options.entryPath ?? clioCliEntryPath(), "fleet", "view", runId];
	if (options.follow !== false) argv.push("--follow");
	return argv;
}
