import { execFileSync } from "node:child_process";
import { type Dir, lstatSync, opendirSync } from "node:fs";
import { join, sep } from "node:path";
import { performance } from "node:perf_hooks";

const GIT_OUTPUT_LIMIT_BYTES = 128 * 1024 * 1024;

export interface WorkspaceFallbackLimits {
	maxVisitedEntries: number;
	maxDepth: number;
	maxPathBytes: number;
	maxDurationMs: number;
}

export type WorkspaceFallbackLimitKind = "entries" | "depth" | "path-bytes" | "time";

export const DEFAULT_WORKSPACE_FALLBACK_LIMITS: Readonly<WorkspaceFallbackLimits> = Object.freeze({
	maxVisitedEntries: 100_000,
	maxDepth: 64,
	maxPathBytes: 64 * 1024 * 1024,
	maxDurationMs: 5_000,
});

/**
 * Explicit failure for a non-Git scan that cannot prove it saw the whole
 * workspace within its resource contract. Callers must never publish the
 * partial prefix as an authoritative file set.
 */
export class WorkspaceEnumerationLimitError extends Error {
	readonly code = "WORKSPACE_ENUMERATION_LIMIT";

	constructor(
		readonly kind: WorkspaceFallbackLimitKind,
		readonly limit: number,
	) {
		super(`non-Git workspace enumeration exceeded ${kind} limit (${limit})`);
		this.name = "WorkspaceEnumerationLimitError";
	}
}

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

function resolveFallbackLimits(overrides: Partial<WorkspaceFallbackLimits> | undefined): WorkspaceFallbackLimits {
	const limits = { ...DEFAULT_WORKSPACE_FALLBACK_LIMITS, ...overrides };
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
			throw new RangeError(`workspace fallback ${name} must be a non-negative integer`);
		}
	}
	return limits;
}

interface WalkFrame {
	dir: Dir;
	absPath: string;
	prefix: string;
	depth: number;
}

function closeFrame(frame: WalkFrame): void {
	try {
		frame.dir.closeSync();
	} catch {
		// Best-effort cleanup after an unreadable directory or bounded failure.
	}
}

function fallbackFiles(
	cwd: string,
	excludedDirs: ReadonlySet<string>,
	overrides?: Partial<WorkspaceFallbackLimits>,
): string[] {
	const limits = resolveFallbackLimits(overrides);
	const startedAt = performance.now();
	let visitedEntries = 0;
	let pathBytes = 0;
	let root: Dir;
	try {
		root = opendirSync(cwd);
	} catch {
		return [];
	}
	const stack: WalkFrame[] = [{ dir: root, absPath: cwd, prefix: "", depth: 0 }];
	const files: string[] = [];
	try {
		while (stack.length > 0) {
			if (performance.now() - startedAt >= limits.maxDurationMs) {
				throw new WorkspaceEnumerationLimitError("time", limits.maxDurationMs);
			}
			const frame = stack.at(-1);
			if (!frame) break;
			let entry: ReturnType<Dir["readSync"]>;
			try {
				entry = frame.dir.readSync();
			} catch {
				closeFrame(frame);
				stack.pop();
				continue;
			}
			if (!entry) {
				closeFrame(frame);
				stack.pop();
				continue;
			}

			visitedEntries += 1;
			if (visitedEntries > limits.maxVisitedEntries) {
				throw new WorkspaceEnumerationLimitError("entries", limits.maxVisitedEntries);
			}
			const depth = frame.depth + 1;
			if (depth > limits.maxDepth) {
				throw new WorkspaceEnumerationLimitError("depth", limits.maxDepth);
			}
			const relPath = frame.prefix.length > 0 ? `${frame.prefix}/${entry.name}` : entry.name;
			pathBytes += Buffer.byteLength(relPath, "utf8");
			if (pathBytes > limits.maxPathBytes) {
				throw new WorkspaceEnumerationLimitError("path-bytes", limits.maxPathBytes);
			}
			if (entry.isDirectory()) {
				if (excludedDirs.has(entry.name)) continue;
				const absPath = join(frame.absPath, entry.name);
				let child: Dir;
				try {
					child = opendirSync(absPath);
				} catch {
					continue;
				}
				stack.push({ dir: child, absPath, prefix: relPath, depth });
				continue;
			}
			// Dirent#isFile excludes symlinks and special files, matching the Git path.
			if (entry.isFile()) files.push(relPath);
		}
		return files;
	} finally {
		for (const frame of stack) closeFrame(frame);
	}
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
	fallbackLimits?: Partial<WorkspaceFallbackLimits>,
): string[] {
	const gitFiles = gitVisibleFiles(cwd);
	return normalizeVisibleFiles(cwd, gitFiles ?? fallbackFiles(cwd, excludedDirs, fallbackLimits), excludedDirs);
}

/** Apply the same visibility rules to one incremental batch without walking the tree. */
export function filterWorkspaceFileCandidates(
	cwd: string,
	paths: ReadonlyArray<string>,
	excludedDirs: ReadonlySet<string> = WORKSPACE_EXCLUDED_DIRS,
	fallbackLimits?: Partial<WorkspaceFallbackLimits>,
): string[] {
	const candidates = paths
		.map(normalizeRelativePath)
		.filter((path): path is string => path !== null && !isWorkspacePathExcluded(path, excludedDirs));
	if (candidates.length === 0) return [];
	const gitFiles = gitVisibleFiles(cwd, candidates);
	if (gitFiles) return normalizeVisibleFiles(cwd, gitFiles, excludedDirs);
	// Outside Git, incremental candidates must be reconciled against the same
	// complete bounded snapshot as a full build. Otherwise a notification can
	// add a path that a bounded full scan could not authoritatively enumerate.
	const fallbackVisible = new Set(
		normalizeVisibleFiles(cwd, fallbackFiles(cwd, excludedDirs, fallbackLimits), excludedDirs),
	);
	return candidates.filter((path) => fallbackVisible.has(path)).sort(comparePaths);
}
