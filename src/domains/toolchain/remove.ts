import { readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { toolchainRoot } from "./paths.js";
import { findPinnedTool } from "./registry.js";

/**
 * Deleting vendored installs, and pruning the versions a pin bump superseded.
 *
 * Everything here only ever unlinks inside `<data>/tools/<id>/`, a directory
 * Clio created by downloading it, so nothing an operator wrote is reachable
 * from this file. That is what makes removal safe without a confirmation
 * prompt: the worst outcome is a re-download of bytes the registry pins by
 * checksum anyway.
 *
 * Version directories are the only thing considered. A name starting with `.`
 * is an installer's staging or retired directory (`.<version>.incomplete-`,
 * `.<version>.replaced-`), and a prune that raced an install and deleted one
 * would corrupt that install. A full remove is different: it takes the whole
 * `<id>` tree because no install of that tool is meant to survive it.
 *
 * A staging directory old enough to be dead is swept anyway. A killed install
 * used to leave one behind permanently, invisible to every verb and reachable
 * only by an operator who went reading under the data root.
 */

export interface ToolRemoveOptions {
	/** Vendor root override. Defaults to the data root's `tools` directory. */
	root?: string;
	/**
	 * How old a staging directory must be before it counts as abandoned.
	 * Defaults to `STALE_STAGING_MS`. Tests set it; nothing else should need to.
	 */
	staleStagingMs?: number;
}

/**
 * How long a staging directory may sit before a sweep treats it as dead.
 *
 * The window is far shorter than it looks. `installPinnedTool` downloads every
 * asset and verifies every checksum *before* it creates the staging directory,
 * so that directory's whole life is a handful of local file writes and two
 * renames: sub-second normally, seconds on a struggling disk. An hour is twelve
 * times the installer's own per-asset download timeout and orders of magnitude
 * past the writes, which leaves no plausible live install inside it.
 *
 * The pid in the name is deliberately not consulted. Pids are reused, a pid
 * belonging to another user answers a liveness probe with EPERM rather than an
 * honest yes or no, and a data root shared over a network filesystem makes the
 * number meaningless. Age is the one signal that means the same thing
 * everywhere.
 */
export const STALE_STAGING_MS = 3_600_000;

/** What one sweep of a tool's directory deleted, and what it could not. */
export interface ToolRemoveResult {
	ok: boolean;
	id: string;
	/** `<root>/<id>`, whether or not it exists. */
	dir: string;
	/** Version directories this sweep deleted, oldest name first. */
	removed: string[];
	/** Version directories that survived a delete attempt, with the reason. */
	failed: ReadonlyArray<{ version: string; error: string }>;
	/** Abandoned staging directories this sweep collected, by name. */
	staleStaging: string[];
	message: string;
}

/** Version directories currently installed for a tool, sorted. */
export function installedToolVersions(id: string, options: ToolRemoveOptions = {}): string[] {
	const dir = join(options.root ?? toolchainRoot(), id);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		// A tool nobody ever installed has no directory, which is not an error:
		// the answer to "which versions are installed" is none.
		return [];
	}
	return names
		.filter((name) => !name.startsWith(".") && isDirectory(join(dir, name)))
		.sort((a, b) => a.localeCompare(b));
}

/**
 * Delete every vendored version of a tool, then the tool's own directory.
 *
 * A tool with nothing installed is a no-op that reports success: the operator
 * asked for a state ("this tool is not vendored") that already holds, and
 * failing them for it would make the verb unusable in a script.
 */
export function removeTool(id: string, options: ToolRemoveOptions = {}): ToolRemoveResult {
	if (findPinnedTool(id) === null) {
		const dir = join(options.root ?? toolchainRoot(), id);
		return { ok: false, id, dir, removed: [], failed: [], staleStaging: [], message: `unknown tool: ${id}` };
	}
	return removeVersions(id, null, options);
}

/**
 * Delete every vendored version of a tool except `keep`.
 *
 * Called by the installer once a version is in place, so a pin bump leaves one
 * version directory behind rather than one per version the machine ever ran.
 * The kept version is not required to exist: pruning to a version that is not
 * installed empties the tool, which is what `--force` recovery wants.
 */
export function pruneSupersededVersions(id: string, keep: string, options: ToolRemoveOptions = {}): ToolRemoveResult {
	return removeVersions(id, keep, options);
}

function removeVersions(id: string, keep: string | null, options: ToolRemoveOptions): ToolRemoveResult {
	const root = options.root ?? toolchainRoot();
	const dir = join(root, id);
	const versions = installedToolVersions(id, { root }).filter((version) => version !== keep);
	const removed: string[] = [];
	const failed: { version: string; error: string }[] = [];
	for (const version of versions) {
		try {
			rmSync(join(dir, version), { recursive: true, force: true });
			removed.push(version);
		} catch (error) {
			failed.push({ version, error: error instanceof Error ? error.message : String(error) });
		}
	}
	// Before the rmdir below, so an install killed weeks ago cannot keep the tool
	// directory alive after every version of it is gone.
	const staleStaging = sweepStaleStaging(dir, options.staleStagingMs ?? STALE_STAGING_MS);
	if (keep === null && failed.length === 0) {
		// The tool is gone, so its directory is litter. `rmdir` takes it only when
		// it is empty, so a staging directory young enough to belong to a running
		// installer makes this fail instead of destroying that install.
		try {
			rmdirSync(dir);
		} catch {
			// Either it was never there or something still lives in it. Neither
			// changes what this call promised: no version of the tool remains.
		}
	}
	return {
		ok: failed.length === 0,
		id,
		dir,
		removed,
		failed,
		staleStaging,
		message: describeRemoval(id, dir, keep, removed, failed, staleStaging),
	};
}

/**
 * Delete the abandoned staging directories under one tool.
 *
 * Only names the installer produces are considered, so an operator who parked
 * something of their own under `<data>/tools/<id>` with a leading dot keeps it.
 * A directory whose age cannot be read is left alone: an unreadable stat is not
 * evidence of death.
 */
function sweepStaleStaging(dir: string, staleMs: number): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const cutoff = Date.now() - staleMs;
	const swept: string[] = [];
	for (const name of names.sort((a, b) => a.localeCompare(b))) {
		if (!STAGING_NAME.test(name)) continue;
		const stat = statSync(join(dir, name), { throwIfNoEntry: false });
		if (stat === undefined || !stat.isDirectory() || stat.mtimeMs > cutoff) continue;
		try {
			rmSync(join(dir, name), { recursive: true, force: true });
			swept.push(name);
		} catch {
			// A staging directory that resists deletion is litter, not a failure:
			// nothing resolves it, and reporting it would turn a successful install
			// into a failed one over a directory the ladder never looks at.
		}
	}
	return swept;
}

/** `.<version>.incomplete-<pid>-<t>` and `.<version>.replaced-<pid>-<t>`. */
const STAGING_NAME = /^\.[^/]+\.(?:incomplete|replaced)-\d+-[a-z0-9]+$/;

function describeRemoval(
	id: string,
	dir: string,
	keep: string | null,
	removed: ReadonlyArray<string>,
	failed: ReadonlyArray<{ version: string; error: string }>,
	staleStaging: ReadonlyArray<string>,
): string {
	// Reported as a suffix rather than as the headline: an abandoned staging
	// directory is housekeeping, and the operator asked about versions.
	const swept =
		staleStaging.length === 0
			? ""
			: `; swept ${staleStaging.length} abandoned install ${staleStaging.length === 1 ? "directory" : "directories"}`;
	const trouble = failed.map((entry) => `${entry.version} (${entry.error})`).join(", ");
	if (failed.length > 0) {
		const done = removed.length > 0 ? `removed ${removed.join(", ")}; ` : "";
		return `${done}could not remove ${id} ${trouble} under ${dir}${swept}`;
	}
	if (removed.length === 0) {
		return keep === null
			? `${id} is not installed under ${dir}; nothing to remove${swept}`
			: `${id} has no superseded versions under ${dir}${swept}`;
	}
	const what = `${id} ${removed.join(", ")}`;
	const headline = keep === null ? `removed ${what} from ${dir}` : `pruned ${what} from ${dir}, keeping ${keep}`;
	return `${headline}${swept}`;
}

function isDirectory(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}
