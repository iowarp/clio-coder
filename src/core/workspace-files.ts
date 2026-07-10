import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

const GIT_OUTPUT_LIMIT_BYTES = 128 * 1024 * 1024;

/**
 * Directories omitted even when Git tracks files beneath them. Git ignore
 * rules complement this policy; they do not override it.
 */
export const WORKSPACE_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
	".git",
	".hg",
	".svn",
	".clio",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".venv",
	"venv",
	"__pycache__",
	"target",
	"vendor",
	".superpowers",
	".codex",
	".claude",
	".clio-benchmark",
]);

function comparePaths(a: string, b: string): number {
	return a === b ? 0 : a < b ? -1 : 1;
}

function normalizeRelativePath(path: string): string | null {
	const posixPath = sep === "\\" ? path.replaceAll("\\", "/") : path;
	const normalized = posixPath.replace(/^\.\//, "");
	if (normalized.length === 0 || normalized.includes("\0") || normalized.startsWith("/")) return null;
	if (/^[A-Za-z]:\//.test(normalized)) return null;
	const segments = normalized.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
	return segments.join("/");
}

export function isWorkspacePathExcluded(
	relPath: string,
	excludedDirs: ReadonlySet<string> = WORKSPACE_EXCLUDED_DIRS,
): boolean {
	return relPath.split("/").some((segment) => excludedDirs.has(segment));
}

function isRegularWorkspaceFile(cwd: string, relPath: string): boolean {
	try {
		// lstat deliberately excludes symlinks. Gitlinks resolve to directories,
		// so full scans do not enter submodules either.
		return lstatSync(join(cwd, relPath)).isFile();
	} catch {
		return false;
	}
}

function gitVisibleFiles(cwd: string, candidates?: ReadonlyArray<string>): string[] | null {
	const args = ["--literal-pathspecs", "ls-files", "-z", "--cached", "--others", "--exclude-standard"];
	if (candidates) args.push("--", ...candidates);
	let output: Buffer;
	try {
		output = execFileSync("git", args, {
			cwd,
			maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
	return output
		.toString("utf8")
		.split("\0")
		.filter((path) => path.length > 0);
}

function fallbackFiles(cwd: string, excludedDirs: ReadonlySet<string>): string[] {
	const files: string[] = [];
	const walk = (dir: string, prefix: string): void => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const relPath = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (excludedDirs.has(entry.name)) continue;
				walk(join(dir, entry.name), relPath);
				continue;
			}
			// Dirent#isFile excludes symlinks and special files, matching the Git path.
			if (entry.isFile()) files.push(relPath);
		}
	};
	walk(cwd, "");
	return files;
}

function normalizeVisibleFiles(cwd: string, paths: ReadonlyArray<string>, excludedDirs: ReadonlySet<string>): string[] {
	const visible = new Set<string>();
	for (const path of paths) {
		const normalized = normalizeRelativePath(path);
		if (!normalized || isWorkspacePathExcluded(normalized, excludedDirs)) continue;
		if (isRegularWorkspaceFile(cwd, normalized)) visible.add(normalized);
	}
	return [...visible].sort(comparePaths);
}

/**
 * List tracked files plus untracked, nonignored work in progress. Non-Git
 * workspaces (and hosts without a usable Git binary) retain the filesystem
 * walker behavior.
 */
export function enumerateWorkspaceFiles(
	cwd: string,
	excludedDirs: ReadonlySet<string> = WORKSPACE_EXCLUDED_DIRS,
): string[] {
	const gitFiles = gitVisibleFiles(cwd);
	return normalizeVisibleFiles(cwd, gitFiles ?? fallbackFiles(cwd, excludedDirs), excludedDirs);
}

/** Apply the same visibility rules to one incremental batch without walking the tree. */
export function filterWorkspaceFileCandidates(
	cwd: string,
	paths: ReadonlyArray<string>,
	excludedDirs: ReadonlySet<string> = WORKSPACE_EXCLUDED_DIRS,
): string[] {
	const candidates = paths
		.map(normalizeRelativePath)
		.filter((path): path is string => path !== null && !isWorkspacePathExcluded(path, excludedDirs));
	if (candidates.length === 0) return [];
	const gitFiles = gitVisibleFiles(cwd, candidates);
	return normalizeVisibleFiles(cwd, gitFiles ?? candidates, excludedDirs);
}
