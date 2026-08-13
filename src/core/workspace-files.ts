import { execFileSync } from "node:child_process";
import fs, { type Dir } from "node:fs";
import { join, sep } from "node:path";
import { performance } from "node:perf_hooks";

const GIT_OUTPUT_LIMIT_BYTES = 128 * 1024 * 1024;
const MAX_ENUMERATION_DIAGNOSTIC_PATH_CHARS = 200;

export interface WorkspaceFallbackLimits {
	maxVisitedEntries: number;
	maxDepth: number;
	maxPathBytes: number;
	maxDurationMs: number;
}

export type WorkspaceFallbackLimitKind = "entries" | "depth" | "path-bytes" | "time";
export type WorkspaceEnumerationOperation = "open-root" | "read-directory" | "open-directory" | "inspect-entry";

const DEFAULT_WORKSPACE_FALLBACK_LIMITS: Readonly<WorkspaceFallbackLimits> = Object.freeze({
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

function boundedDiagnosticPath(path: string): string {
	const printable = Array.from(path.length > 0 ? path : ".", (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? "?" : character;
	});
	if (printable.length <= MAX_ENUMERATION_DIAGNOSTIC_PATH_CHARS) return printable.join("");
	const side = Math.floor((MAX_ENUMERATION_DIAGNOSTIC_PATH_CHARS - 1) / 2);
	return `${printable.slice(0, side).join("")}\u2026${printable.slice(-side).join("")}`;
}

function boundedSystemErrorCode(cause: unknown): string {
	if (typeof cause !== "object" || cause === null || !("code" in cause)) return "UNKNOWN";
	const code = (cause as { code?: unknown }).code;
	return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : "UNKNOWN";
}

const ENUMERATION_OPERATION_LABELS: Readonly<Record<WorkspaceEnumerationOperation, string>> = Object.freeze({
	"open-root": "open the workspace root",
	"read-directory": "read a workspace directory",
	"open-directory": "open a workspace directory",
	"inspect-entry": "inspect a workspace entry",
});

/**
 * Explicit failure for a non-Git scan whose filesystem view became incomplete.
 * Only a bounded workspace-relative path and a validated system error code are
 * retained; arbitrary filesystem error text is deliberately not propagated.
 */
export class WorkspaceEnumerationIncompleteError extends Error {
	readonly code = "WORKSPACE_ENUMERATION_INCOMPLETE";
	readonly operation: WorkspaceEnumerationOperation;
	readonly path: string;
	readonly causeCode: string;

	constructor(operation: WorkspaceEnumerationOperation, path: string, cause: unknown) {
		const diagnosticPath = boundedDiagnosticPath(path);
		const causeCode = boundedSystemErrorCode(cause);
		super(
			`non-Git workspace enumeration could not ${ENUMERATION_OPERATION_LABELS[operation]} at '${diagnosticPath}' (${causeCode})`,
		);
		this.name = "WorkspaceEnumerationIncompleteError";
		this.operation = operation;
		this.path = diagnosticPath;
		this.causeCode = causeCode;
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

function isWorkspacePathExcluded(
	relPath: string,
	excludedDirs: ReadonlySet<string> = WORKSPACE_EXCLUDED_DIRS,
): boolean {
	return relPath.split("/").some((segment) => excludedDirs.has(segment));
}

function isDisappearedWorkspaceEntry(cause: unknown): boolean {
	if (typeof cause !== "object" || cause === null || !("code" in cause)) return false;
	const code = (cause as { code?: unknown }).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function isRegularWorkspaceFile(cwd: string, relPath: string, requireCompleteSnapshot: boolean): boolean {
	try {
		// lstat deliberately excludes symlinks. Gitlinks resolve to directories,
		// so full scans do not enter submodules either.
		const stat = fs.lstatSync(join(cwd, relPath));
		if (stat.isFile()) return true;
		if (requireCompleteSnapshot && stat.isDirectory()) {
			// The fallback walker observed this path as a file. If it became a
			// directory before validation, that directory may contain entries the
			// completed walk never visited, so the snapshot is no longer complete.
			throw new WorkspaceEnumerationIncompleteError("inspect-entry", relPath, { code: "ENTRY_TYPE_CHANGED" });
		}
		return false;
	} catch (cause) {
		if (cause instanceof WorkspaceEnumerationIncompleteError) throw cause;
		if (requireCompleteSnapshot) {
			// A vanished file (or an ancestor replaced by a non-directory) is no
			// longer part of the workspace at validation time and may be omitted.
			// Permission, I/O, and stale-handle errors leave its visibility unknown
			// and must invalidate the complete non-Git snapshot.
			if (isDisappearedWorkspaceEntry(cause)) return false;
			throw new WorkspaceEnumerationIncompleteError("inspect-entry", relPath, cause);
		}
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

type FallbackEntryKind = "directory" | "file" | "other" | "disappeared";

function fallbackEntryKind(absPath: string, relPath: string, entry: ReturnType<Dir["readSync"]>): FallbackEntryKind {
	if (!entry) return "disappeared";
	if (entry.isDirectory()) return "directory";
	if (entry.isFile()) return "file";
	try {
		// Some network and facility filesystems report DT_UNKNOWN. Inspect those
		// entries rather than treating a potentially populated directory as a
		// special file and silently omitting its subtree.
		const stat = fs.lstatSync(absPath);
		if (stat.isDirectory()) return "directory";
		if (stat.isFile()) return "file";
		return "other";
	} catch (cause) {
		if (isDisappearedWorkspaceEntry(cause)) return "disappeared";
		throw new WorkspaceEnumerationIncompleteError("inspect-entry", relPath, cause);
	}
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
		root = fs.opendirSync(cwd);
	} catch (cause) {
		throw new WorkspaceEnumerationIncompleteError("open-root", ".", cause);
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
			} catch (cause) {
				throw new WorkspaceEnumerationIncompleteError("read-directory", frame.prefix || ".", cause);
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
			const absPath = join(frame.absPath, entry.name);
			const kind = fallbackEntryKind(absPath, relPath, entry);
			if (kind === "disappeared" || kind === "other") continue;
			if (kind === "directory") {
				if (excludedDirs.has(entry.name)) continue;
				let child: Dir;
				try {
					child = fs.opendirSync(absPath);
				} catch (cause) {
					if (isDisappearedWorkspaceEntry(cause)) continue;
					throw new WorkspaceEnumerationIncompleteError("open-directory", relPath, cause);
				}
				stack.push({ dir: child, absPath, prefix: relPath, depth });
				continue;
			}
			// Only direct or lstat-confirmed regular files reach this branch;
			// symlinks and special files remain excluded, matching the Git path.
			files.push(relPath);
		}
		return files;
	} finally {
		for (const frame of stack) closeFrame(frame);
	}
}

function normalizeVisibleFiles(
	cwd: string,
	paths: ReadonlyArray<string>,
	excludedDirs: ReadonlySet<string>,
	requireCompleteSnapshot = false,
): string[] {
	const visible = new Set<string>();
	for (const path of paths) {
		const normalized = normalizeRelativePath(path);
		if (!normalized) {
			if (requireCompleteSnapshot) {
				throw new WorkspaceEnumerationIncompleteError("inspect-entry", path, { code: "INVALID_RELATIVE_PATH" });
			}
			continue;
		}
		if (isWorkspacePathExcluded(normalized, excludedDirs)) continue;
		if (isRegularWorkspaceFile(cwd, normalized, requireCompleteSnapshot)) visible.add(normalized);
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
	if (gitFiles) return normalizeVisibleFiles(cwd, gitFiles, excludedDirs);
	return normalizeVisibleFiles(cwd, fallbackFiles(cwd, excludedDirs, fallbackLimits), excludedDirs, true);
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
		normalizeVisibleFiles(cwd, fallbackFiles(cwd, excludedDirs, fallbackLimits), excludedDirs, true),
	);
	return candidates.filter((path) => fallbackVisible.has(path)).sort(comparePaths);
}
