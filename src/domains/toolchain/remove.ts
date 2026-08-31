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
 * is a live installer's staging or retired directory (`.<version>.incomplete-`,
 * `.<version>.replaced-`), and a prune that raced an install and deleted one
 * would corrupt that install. A full remove is different: it takes the whole
 * `<id>` tree because no install of that tool is meant to survive it.
 */

export interface ToolRemoveOptions {
	/** Vendor root override. Defaults to the data root's `tools` directory. */
	root?: string;
}

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
		return { ok: false, id, dir, removed: [], failed: [], message: `unknown tool: ${id}` };
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
	if (keep === null && failed.length === 0) {
		// The tool is gone, so its directory is litter. `rmdir` takes it only when
		// it is empty, so a staging directory a concurrent installer owns makes
		// this fail instead of destroying that install.
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
		message: describeRemoval(id, dir, keep, removed, failed),
	};
}

function describeRemoval(
	id: string,
	dir: string,
	keep: string | null,
	removed: ReadonlyArray<string>,
	failed: ReadonlyArray<{ version: string; error: string }>,
): string {
	const trouble = failed.map((entry) => `${entry.version} (${entry.error})`).join(", ");
	if (failed.length > 0) {
		const done = removed.length > 0 ? `removed ${removed.join(", ")}; ` : "";
		return `${done}could not remove ${id} ${trouble} under ${dir}`;
	}
	if (removed.length === 0) {
		return keep === null
			? `${id} is not installed under ${dir}; nothing to remove`
			: `${id} has no superseded versions under ${dir}`;
	}
	const what = `${id} ${removed.join(", ")}`;
	return keep === null ? `removed ${what} from ${dir}` : `pruned ${what} from ${dir}, keeping ${keep}`;
}

function isDirectory(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}
