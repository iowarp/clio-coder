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
 * The workers dock follows a selection file so the TUI can retarget it without
 * respawning anything. The logs pane follows one run's feed through the same
 * self-invocation (`fleet view <runId> --follow --pane`) on every platform.
 */

import { join } from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";
import type { ClioDirs } from "../../core/xdg.js";

/** Built CLI entry point, matching the `bin` field in `package.json`. */
export function clioCliEntryPath(): string {
	return join(resolvePackageRoot(), "dist/cli/index.js");
}

export interface ViewerCommandOptions {
	/** Override for tests and for a caller that already resolved the entry. */
	entryPath?: string;
	/** Node binary to run it with; defaults to the one running this process. */
	execPath?: string;
	/** Exact parent-process layout; pinned on argv so a new pane cannot re-resolve it. */
	dirs?: Readonly<ClioDirs>;
	/** The file the dashboard reports `q` and Alt+W to; absent, `q` quits it. */
	tapPath?: string;
}

/** The argv the workers dock executes: the dashboard, following a selection file. */
export function watchViewerCommand(selectionPath: string, options: ViewerCommandOptions = {}): ReadonlyArray<string> {
	return viewerCommand("fleet", ["--watch", selectionPath], options);
}

/** The argv the logs pane executes: one run's events, one clipped row each, at the pane's width. */
export function logsViewerCommand(runId: string, options: ViewerCommandOptions = {}): ReadonlyArray<string> {
	return viewerCommand("fleet", [runId, "--follow", "--pane"], options);
}

function viewerCommand(
	command: "fleet" | "extensions",
	target: ReadonlyArray<string>,
	options: ViewerCommandOptions,
): ReadonlyArray<string> {
	const layout =
		options.dirs === undefined
			? []
			: [
					"--config-dir",
					options.dirs.config,
					"--data-dir",
					options.dirs.data,
					"--state-dir",
					options.dirs.state,
					"--cache-dir",
					options.dirs.cache,
				];
	return [
		options.execPath ?? process.execPath,
		options.entryPath ?? clioCliEntryPath(),
		command,
		"view",
		...layout,
		...target,
		...(options.tapPath === undefined ? [] : ["--dock-taps", options.tapPath]),
	];
}

/** The host-rendered extension dock, pinned to this installation and layout. */
export function extensionViewerCommand(frameFile: string, options: ViewerCommandOptions = {}): ReadonlyArray<string> {
	return viewerCommand("extensions", ["--watch", frameFile], options);
}
