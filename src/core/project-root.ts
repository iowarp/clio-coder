import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalizeExistingPath } from "./path-canonical.js";
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
 * The repository that owns `path`: its nearest ancestor holding a `.git` entry,
 * the same boundary the handbook walk ends at, or null outside any repository.
 * The path need not exist, so a declared output resolves to the repository it
 * would land in. A home directory that is a repository owns only itself.
 */
export function repositoryRoot(path: string): string | null {
	const start = physicalAncestor(resolve(path));
	const homes = new Set([resolve(homedir()), physical(homedir())]);
	let dir = start;
	while (true) {
		if (existsSync(join(dir, ".git"))) return homes.has(dir) && dir !== start ? null : dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** The nearest existing ancestor of `path`, with its links resolved. */
function physicalAncestor(path: string): string {
	let dir = path;
	while (!existsSync(dir)) {
		const parent = dirname(dir);
		if (parent === dir) return path;
		dir = parent;
	}
	return join(physical(dir), path.slice(dir.length));
}

/**
 * Which repository a root belongs to: its common Git directory, so a linked
 * worktree and its main checkout are one repository while a submodule or a
 * nested clone is another.
 */
export function repositoryIdentity(root: string): string {
	const dotGit = join(root, ".git");
	try {
		if (statSync(dotGit).isDirectory()) return physical(dotGit);
		const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
		if (gitdir === undefined) return physical(dotGit);
		const dir = resolve(root, gitdir);
		const common = existsSync(join(dir, "commondir")) ? readFileSync(join(dir, "commondir"), "utf8").trim() : null;
		return physical(common === null || common.length === 0 ? dir : resolve(dir, common));
	} catch {
		return physical(dotGit);
	}
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
 * Keep generated files under `<cwd>/.clio-coder/` out of Git without touching the
 * project's own `.gitignore`. Every generated writer calls this, and it never
 * replaces a file the operator may have edited. A failure only leaves generated
 * files visible to Git, which is no reason to fail the write that asked.
 */
export function ensureProjectIgnore(cwd: string): void {
	const dir = join(cwd, ".clio-coder");
	const file = join(dir, ".gitignore");
	try {
		if (existsSync(file) || (existsSync(dir) && lstatSync(dir).isSymbolicLink())) return;
		safeResourceWrite(file, PROJECT_IGNORE, { encoding: "utf8" });
	} catch {
		// See the doc comment: this is hygiene, and the caller's write still decides the outcome.
	}
}

/**
 * The main checkout a linked worktree belongs to, or null when `root` is not a
 * linked worktree the main repository vouches for. `git worktree add` writes
 * `<commonDir>/worktrees/<name>/gitdir` naming the worktree's `.git` file; a
 * directory that only forges its own `.git` pointer cannot write there, so it
 * never folds into another checkout's project (#406). `root` must already be
 * canonical (`canonicalizeExistingPath`).
 */
export function linkedWorktreeMainRoot(root: string): string | null {
	return checkoutLink(root).main;
}

/**
 * How a checkout root relates to its repository: `main` (a `.git` directory, or
 * no repository at all), `linked` (a worktree the main repository vouches for),
 * `own` (a `.git` file naming a git dir that is not a linked worktree, such as a
 * submodule), or `forged` (a `.git` file claiming a linked worktree whose main
 * repository does not record it back, or that cannot be read).
 */
function checkoutLink(root: string): { kind: "main" | "linked" | "own" | "forged"; main: string | null } {
	let pointer: string;
	try {
		if (!lstatSync(join(root, ".git")).isFile()) return { kind: "main", main: null };
		pointer = readFileSync(join(root, ".git"), "utf8");
	} catch {
		// No `.git` at all: not a repository, so the directory is its own project.
		return { kind: "main", main: null };
	}
	try {
		const gitDir = /^gitdir:\s*(.+?)\s*$/mu.exec(pointer)?.[1];
		if (gitDir === undefined) return { kind: "forged", main: null };
		const absoluteGitDir = resolve(root, gitDir);
		if (!existsSync(join(absoluteGitDir, "commondir"))) return { kind: "own", main: null };
		const commonDir = resolve(absoluteGitDir, readFileSync(join(absoluteGitDir, "commondir"), "utf8").trim());
		if (basename(commonDir) !== ".git") return { kind: "forged", main: null };
		const backLink = readFileSync(join(commonDir, "worktrees", basename(absoluteGitDir), "gitdir"), "utf8").trim();
		const backRoot = canonicalizeExistingPath(dirname(resolve(commonDir, backLink.replaceAll("\\", "/"))));
		if (basename(backLink) !== ".git" || backRoot !== root) return { kind: "forged", main: null };
		const mainRoot = canonicalizeExistingPath(dirname(commonDir));
		if (!isAbsolute(mainRoot) || mainRoot === root) return { kind: "forged", main: null };
		return { kind: "linked", main: mainRoot };
	} catch {
		// An unreadable pointer, git dir or back link vouches for nothing.
		return { kind: "forged", main: null };
	}
}

/**
 * The checkout `cwd` sits in and the one project key it shares (#406): the
 * realpath of the enclosing repository root, with a linked worktree folded into
 * its main checkout, so a lane worktree, its main checkout and every
 * subdirectory or symlinked path to them name one project. `trusted` is false
 * only for a forged worktree pointer: such a checkout keys on itself and records
 * nothing into a shared project log. Claims and memory both key on this.
 */
export interface CanonicalCheckout {
	/** The project key: the main checkout's root. */
	project: string;
	/** The checkout's own root: the linked worktree's root, else `project`. */
	checkout: string;
	/** Set when `checkout` is a vouched-for linked worktree of `project`. */
	linked: boolean;
	trusted: boolean;
}

export function canonicalCheckout(cwd: string): CanonicalCheckout {
	const root = canonicalizeExistingPath(clioProjectRoot(canonicalizeExistingPath(resolve(cwd))));
	const link = checkoutLink(root);
	if (link.kind === "linked" && link.main !== null)
		return { project: link.main, checkout: root, linked: true, trusted: true };
	return { project: root, checkout: root, linked: false, trusted: link.kind !== "forged" };
}

export function canonicalProjectRoot(cwd: string): string {
	return canonicalCheckout(cwd).project;
}

/**
 * HEAD of the checkout at `root`, read from Git's files with no subprocess, or null when it cannot be read (not a
 * repository, an unborn branch, a ref Git keeps elsewhere). The prompt-delivery path calls it per hook point, where a
 * `git rev-parse` fork per turn would be the cost (#406).
 */
export function checkoutHead(root: string): string | null {
	try {
		const dotGit = join(root, ".git");
		let gitDir = dotGit;
		if (lstatSync(dotGit).isFile()) {
			const pointer = /^gitdir:\s*(.+?)\s*$/mu.exec(readFileSync(dotGit, "utf8"))?.[1];
			if (pointer === undefined) return null;
			gitDir = resolve(root, pointer);
		}
		const commonDir = existsSync(join(gitDir, "commondir"))
			? resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim())
			: gitDir;
		const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
		const ref = /^ref:\s*(\S+)$/u.exec(head)?.[1];
		if (ref === undefined) return /^[0-9a-f]{40,64}$/u.test(head) ? head : null;
		if (!/^refs\/[A-Za-z0-9._/-]+$/u.test(ref) || ref.includes("..")) return null;
		for (const dir of [gitDir, commonDir]) {
			try {
				const value = readFileSync(join(dir, ref), "utf8").trim();
				if (/^[0-9a-f]{40,64}$/u.test(value)) return value;
			} catch {
				// Not a loose ref here; try the next place Git keeps it.
			}
		}
		const packed = readFileSync(join(commonDir, "packed-refs"), "utf8");
		for (const line of packed.split("\n")) {
			const [sha, name] = line.trim().split(" ");
			if (name === ref && sha !== undefined && /^[0-9a-f]{40,64}$/u.test(sha)) return sha;
		}
		return null;
	} catch {
		// No repository, or one this reader cannot follow: no HEAD to compare against.
		return null;
	}
}
