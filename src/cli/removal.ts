import { existsSync, rmSync } from "node:fs";

/**
 * Shared deletion accounting for `clio reset` and `clio uninstall`.
 *
 * A recursive delete can fail halfway through: an unwritable parent leaves
 * some children removed and some in place, and `rmSync` reports only the
 * first path it could not unlink. The original code let that error escape to
 * the CLI's top-level catch, which printed one raw errno line and skipped
 * every root the command had not reached yet. The operator was left with a
 * tree that was neither the old state nor the new one, no list of what
 * survived, and no statement of what to do next.
 *
 * Collecting failures instead of throwing gives all three back: the remaining
 * roots still get their attempt, every path that resisted is named with its
 * reason, and the command exits nonzero so no script reads a partial delete as
 * success. Both commands are idempotent, so the stated recovery is always the
 * same one: fix the permission or release the handle, then run the identical
 * command again.
 */
export interface RemovalFailure {
	/** Column label the command used when it announced the path. */
	label: string;
	path: string;
	reason: string;
}

/**
 * Delete one path, returning the failure rather than throwing it. An absent
 * path and a dry run are both no-ops, which keeps `--dry-run` free of any
 * filesystem write while still walking the same list the real run walks.
 */
export function removePath(label: string, path: string, dryRun: boolean): RemovalFailure | null {
	if (!existsSync(path) || dryRun) return null;
	try {
		rmSync(path, { recursive: true, force: true });
		return null;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { label, path, reason };
	}
}

/**
 * Print the per-path failure report. `command` is the exact invocation to
 * rerun, so the operator never has to reconstruct which flags produced this
 * state.
 */
export function reportRemovalFailures(command: string, failures: ReadonlyArray<RemovalFailure>): void {
	process.stderr.write(`\n${failures.length} path(s) could not be removed:\n`);
	for (const failure of failures) {
		process.stderr.write(`  ${failure.label.padEnd(8)} ${failure.path}\n    ${failure.reason}\n`);
	}
	process.stderr.write(
		`\nEverything else was removed. Fix the permissions above, or close the process holding those\npaths, then run \`${command}\` again; it resumes from whatever is left.\n`,
	);
}
