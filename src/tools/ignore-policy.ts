import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { toPosixPath } from "./path-utils.js";

/**
 * One ignore policy for every path-walking OBSERVE tool. grep (rg), find (fd),
 * and the pure-Node fallback walkers all answer "which parts of the tree are
 * visible" from this module so the three surfaces never disagree about
 * gitignored, generated, or clio-internal paths.
 *
 * The policy has three layers:
 *   1. ALWAYS excluded: clio-internal state and .git. Never searchable unless
 *      the search root itself sits inside one of them (pointing a tool at
 *      .clio explicitly means the caller wants those paths).
 *   2. .gitignore: honored natively by rg/fd. Outside a git repo the binaries
 *      get --no-require-git so plain .gitignore/.ignore files still apply;
 *      inside a repo the default git-aware behavior keeps parent ignore rules
 *      from leaking across nested-repo boundaries.
 *   3. GENERATED_DIRS: universal build/dependency noise force-excluded even
 *      when a project forgets to gitignore it.
 *
 * `include_ignored: true` on grep/find disables layers 2 and 3 together;
 * layer 1 always stands.
 */

const ALWAYS_EXCLUDED_DIRS: ReadonlyArray<string> = [".clio", ".fallow", ".git"];

const GENERATED_DIRS: ReadonlyArray<string> = [
	".cache",
	".next",
	".pytest_cache",
	".turbo",
	".venv",
	"build",
	"coverage",
	"dist",
	"node_modules",
	"target",
];

/**
 * Walk up from the search path looking for a `.git` marker (a directory in a
 * normal repo, a file in worktrees/submodules).
 */
function isInsideGitRepo(startPath: string): boolean {
	let current = startPath;
	for (;;) {
		if (existsSync(join(current, ".git"))) return true;
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

/**
 * Directories to force-exclude for a given search root, skipping any dir the
 * root itself sits inside: pointing a tool at node_modules (or .clio) means
 * the caller wants those matches, so the exclude must not suppress them.
 */
function excludedDirsFor(searchPath: string, includeIgnored: boolean): string[] {
	const segments = new Set(
		toPosixPath(searchPath)
			.split("/")
			.filter((segment) => segment.length > 0),
	);
	const dirs = includeIgnored ? ALWAYS_EXCLUDED_DIRS : [...ALWAYS_EXCLUDED_DIRS, ...GENERATED_DIRS];
	return dirs.filter((dir) => !segments.has(dir));
}

/** Ignore-policy argv fragment for ripgrep. */
export function rgIgnoreArgs(searchPath: string, includeIgnored: boolean): string[] {
	const args = ["--hidden"];
	if (includeIgnored) args.push("--no-ignore");
	else if (!isInsideGitRepo(searchPath)) args.push("--no-require-git");
	for (const dir of excludedDirsFor(searchPath, includeIgnored)) args.push("--glob", `!**/${dir}/**`);
	return args;
}

/** Ignore-policy argv fragment for fd. */
export function fdIgnoreArgs(searchPath: string, includeIgnored: boolean): string[] {
	const args = ["--hidden"];
	if (includeIgnored) args.push("--no-ignore");
	else if (!isInsideGitRepo(searchPath)) args.push("--no-require-git");
	for (const dir of excludedDirsFor(searchPath, includeIgnored)) args.push("--exclude", dir);
	return args;
}

/**
 * Directory names the pure-Node fallback walkers skip. The fallbacks cannot
 * read .gitignore, so the generated-dirs layer is their only stand-in for it.
 */
export function fallbackIgnoredDirs(includeIgnored: boolean): ReadonlySet<string> {
	return new Set(includeIgnored ? ALWAYS_EXCLUDED_DIRS : [...ALWAYS_EXCLUDED_DIRS, ...GENERATED_DIRS]);
}

// Glob matching primitives shared by the fallback walkers and code_nav.
// Moved from the deleted glob tool; the pattern dialect (*, **, ?, [abc])
// is unchanged.

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeRegexChar(ch: string): string {
	return /[\\^$+?.()|{}]/.test(ch) ? `\\${ch}` : ch;
}

function escapeClassChar(ch: string): string {
	return /[\\\]^-]/.test(ch) ? `\\${ch}` : ch;
}

export function normalizeGlobInput(input: string): string {
	return input.replace(/\\/g, "/");
}

export function compileGlobRegex(pattern: string): RegExp {
	const normalized = normalizeGlobInput(pattern);
	if (normalized.length === 0) {
		throw new Error("glob: pattern must not be empty");
	}

	let regex = "^";
	for (let i = 0; i < normalized.length; ) {
		const ch = normalized[i];
		if (ch === undefined) break;

		if (ch === "*") {
			if (normalized[i + 1] === "*") {
				if (normalized[i + 2] === "/") {
					regex += "(?:.*\\/)?";
					i += 3;
					continue;
				}
				regex += ".*";
				i += 2;
				continue;
			}
			regex += "[^/]*";
			i += 1;
			continue;
		}

		if (ch === "?") {
			regex += "[^/]";
			i += 1;
			continue;
		}

		if (ch === "[") {
			const end = normalized.indexOf("]", i + 1);
			if (end === -1) {
				throw new Error(`glob: invalid pattern (unclosed character class): ${pattern}`);
			}
			const content = normalized.slice(i + 1, end);
			if (content.length === 0) {
				throw new Error(`glob: invalid pattern (empty character class): ${pattern}`);
			}
			regex += `[${Array.from(content).map(escapeClassChar).join("")}]`;
			i = end + 1;
			continue;
		}

		regex += escapeRegexChar(ch);
		i += 1;
	}

	regex += "$";
	return new RegExp(regex);
}
