import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readOnlyMode } from "./read-only-mode.js";
import { safeResourceWrite } from "./safe-resource-write.js";

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

/**
 * What an operator authors under `.clio-coder/`. An allow-list, so a generated
 * path added later stays out of Git by default, and the file ignores itself, so
 * a project with only generated files shows nothing in `git status`. The rule is
 * anchored as `/*` and never `*`: ripgrep and fd apply parent ignore files to the
 * paths below their search root, so `*` would hide `wiki/` from a reader already
 * inside it, which `/*` cannot match.
 */
const PROJECT_IGNORE = `# Written by clio-coder. Generated files stay out of Git; what you author here can be committed.
/*
!/settings.yaml
!/safety.yaml
!/hooks.yaml
!/mcp.yaml
!/verifiers.yaml
!/quality.yaml
!/validation.yaml
!/validation.yml
!/profile.yaml
!/library.yaml
!/rules/
!/agents/
!/skills/
!/prompts/
!/playbooks/
!/extensions/
!/plugins/
!/model-catalog.d/
*.local.yaml
`;

/**
 * The project's generated index and state (`<cwd>/.clio-coder/`) are written only outside read-only mode: a
 * read-only run or worker leaves the workspace as it found it. Their writers and the lease that serializes them
 * call this first.
 */
export function assertProjectIndexWritable(): void {
	if (readOnlyMode()) throw new Error("Read-only mode leaves this project's .clio-coder/ index as it found it");
}

/**
 * Keep generated files under `<cwd>/.clio-coder/` out of Git without touching the
 * project's own `.gitignore`. Every generated writer calls this, and it never
 * replaces a file the operator may have edited. A failure only leaves generated
 * files visible to Git, which is no reason to fail the write that asked.
 */
export function ensureProjectIgnore(cwd: string): void {
	// Read-only mode writes nothing under `.clio-coder/`, so there is nothing to keep out of Git.
	if (readOnlyMode()) return;
	const dir = join(cwd, ".clio-coder");
	const file = join(dir, ".gitignore");
	try {
		if (existsSync(file) || (existsSync(dir) && lstatSync(dir).isSymbolicLink())) return;
		safeResourceWrite(file, PROJECT_IGNORE, { encoding: "utf8" });
	} catch {
		// See the doc comment: this is hygiene, and the caller's write still decides the outcome.
	}
}
