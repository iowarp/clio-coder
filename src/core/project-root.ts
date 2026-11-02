import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function physical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * The directories a project lookup from `cwd` may use, nearest first: `cwd` up
 * to the enclosing repository root (a `.git` directory, or a `.git` file in a
 * worktree or submodule), the boundary the handbook walk also ends at. Outside
 * a repository there is no project above `cwd`, so only `cwd` itself. A home
 * directory that happens to be a repository never serves the folders under it.
 */
function projectLookupDirs(cwd: string): string[] {
	const start = resolve(cwd);
	const home = homedir();
	const homes = new Set([resolve(home), physical(home)]);
	const dirs: string[] = [];
	let dir = start;
	while (true) {
		if (homes.has(dir) && dir !== start) return [start];
		dirs.push(dir);
		if (existsSync(join(dir, ".git"))) return dirs;
		const parent = dirname(dir);
		if (parent === dir) return [start];
		dir = parent;
	}
}

/**
 * The directory whose `.clio-coder/<entry>` applies at `cwd`: the nearest one
 * holding any of `entries`, else the repository root, which is where a new entry
 * belongs, else `cwd`. Each surface asks for its own entries, so a `.clio-coder/`
 * holding only generated files such as `runs/` or `codemap.json` under a
 * subdirectory never hides the configuration at the repository root.
 */
export function clioProjectRoot(cwd: string, ...entries: ReadonlyArray<string>): string {
	const dirs = projectLookupDirs(cwd);
	for (const dir of dirs) {
		if (entries.some((entry) => existsSync(join(dir, ".clio-coder", entry)))) return dir;
	}
	return dirs.at(-1) ?? resolve(cwd);
}
