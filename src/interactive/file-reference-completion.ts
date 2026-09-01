import { execFile } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { enumerateWorkspaceFilesAsync } from "../core/workspace-files.js";
import { fuzzyFilter, stripTerminalSequences } from "../engine/tui.js";
import { isEditorSteerTargetToken } from "./editor-steer.js";

const MAX_COMPLETION_ROWS = 40;
const PREVIEW_BYTES = 2048;
const PREVIEW_CHARS = 120;
const SNAPSHOT_TTL_MS = 2_000;
const GIT_OUTPUT_LIMIT_BYTES = 128 * 1024 * 1024;

export interface FileReferenceCompletionRequest {
	/** Text after the active `@`, decoded when the reference is quoted. */
	query: string;
	signal: AbortSignal;
}

export interface FileReferenceCompletionValue {
	id: string;
	/** Complete inline reference spelling, including `@` and any quotes. */
	value: string;
	/** Workspace/path spelling without the leading `@` or a trailing slash. */
	path: string;
	label: string;
	description: string;
	isDirectory: boolean;
	tracked: boolean;
}

export type FileReferenceCompletionSource = (
	request: FileReferenceCompletionRequest,
) => Promise<ReadonlyArray<FileReferenceCompletionValue>>;

export interface FileReferenceCompletionOptions {
	basePath: string;
	cacheTtlMs?: number;
	/** Test/runtime seam; defaults to the repository's authoritative visible-file enumerator. */
	listWorkspaceFiles?: (basePath: string) => Promise<ReadonlyArray<string>>;
	/** Test/runtime seam; defaults to `git ls-files --cached`. */
	listTrackedFiles?: (basePath: string) => Promise<ReadonlySet<string>>;
}

interface FileCandidate {
	path: string;
	absolutePath: string;
	isDirectory: boolean;
	tracked: boolean;
	descendantFiles: number;
	workspace: boolean;
}

interface WorkspaceSnapshot {
	candidates: FileCandidate[];
	directories: ReadonlySet<string>;
	trackedFiles: ReadonlySet<string>;
}

function posixPath(path: string): string {
	return sep === "\\" ? path.replaceAll("\\", "/") : path;
}

function safeRelativePath(path: string): string | null {
	const normalized = posixPath(path).replace(/^\.\//u, "").replace(/\/$/u, "");
	if (normalized.length === 0 || normalized.startsWith("/") || normalized.includes("\0") || /[\r\n]/u.test(normalized)) {
		return null;
	}
	const segments = normalized.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
	return segments.join("/");
}

function gitTrackedFiles(basePath: string): Promise<ReadonlySet<string>> {
	return new Promise((resolveTracked) => {
		execFile(
			"git",
			["--literal-pathspecs", "ls-files", "-z", "--cached"],
			{ cwd: basePath, encoding: "utf8", maxBuffer: GIT_OUTPUT_LIMIT_BYTES },
			(error, stdout) => {
				if (error) {
					resolveTracked(new Set());
					return;
				}
				const tracked = new Set<string>();
				for (const raw of stdout.split("\0")) {
					const normalized = safeRelativePath(raw);
					if (normalized) tracked.add(normalized);
				}
				resolveTracked(tracked);
			},
		);
	});
}

function buildWorkspaceSnapshot(
	basePath: string,
	visibleFiles: ReadonlyArray<string>,
	trackedFiles: ReadonlySet<string>,
): WorkspaceSnapshot {
	const files: FileCandidate[] = [];
	const directoryFacts = new Map<string, { tracked: boolean; descendantFiles: number }>();
	for (const raw of visibleFiles) {
		const path = safeRelativePath(raw);
		if (!path) continue;
		const tracked = trackedFiles.has(path);
		files.push({
			path,
			absolutePath: join(basePath, path),
			isDirectory: false,
			tracked,
			descendantFiles: 0,
			workspace: true,
		});
		const segments = path.split("/");
		for (let index = 1; index < segments.length; index += 1) {
			const directory = segments.slice(0, index).join("/");
			const facts = directoryFacts.get(directory) ?? { tracked: false, descendantFiles: 0 };
			facts.tracked ||= tracked;
			facts.descendantFiles += 1;
			directoryFacts.set(directory, facts);
		}
	}
	const directories = [...directoryFacts].map(
		([path, facts]): FileCandidate => ({
			path,
			absolutePath: join(basePath, path),
			isDirectory: true,
			tracked: facts.tracked,
			descendantFiles: facts.descendantFiles,
			workspace: true,
		}),
	);
	return {
		candidates: [...directories, ...files],
		directories: new Set(directoryFacts.keys()),
		trackedFiles,
	};
}

function candidateParent(path: string): string {
	const parent = posixPath(dirname(path));
	return parent === "." ? "" : parent;
}

function fuzzyOrdered(candidates: ReadonlyArray<FileCandidate>, query: string): FileCandidate[] {
	const buckets: FileCandidate[][] = [[], [], [], []];
	for (const candidate of candidates) {
		const bucket = candidate.tracked ? (candidate.isDirectory ? 0 : 1) : candidate.isDirectory ? 2 : 3;
		buckets[bucket]?.push(candidate);
	}
	return buckets.flatMap((bucket) =>
		fuzzyFilter(bucket, query, (candidate) => `${basename(candidate.path)} ${candidate.path}`),
	);
}

function workspaceCandidates(snapshot: WorkspaceSnapshot, rawQuery: string): FileCandidate[] {
	const explicitDot = rawQuery.startsWith("./");
	const query = explicitDot ? rawQuery.slice(2) : rawQuery;
	const slash = query.lastIndexOf("/");
	if (query.length === 0) {
		return fuzzyOrdered(
			snapshot.candidates
				.filter((candidate) => candidateParent(candidate.path) === "")
				.map((candidate) => (explicitDot ? { ...candidate, path: `./${candidate.path}` } : candidate)),
			"",
		);
	}
	if (slash >= 0) {
		const parent = query.slice(0, slash);
		const fragment = query.slice(slash + 1);
		if (parent.length === 0 || snapshot.directories.has(parent)) {
			const displayPrefix = explicitDot ? "./" : "";
			return fuzzyOrdered(
				snapshot.candidates
					.filter((candidate) => candidateParent(candidate.path) === parent)
					.map((candidate) => ({ ...candidate, path: `${displayPrefix}${candidate.path}` })),
				fragment,
			);
		}
	}
	return fuzzyOrdered(
		snapshot.candidates.map((candidate) => (explicitDot ? { ...candidate, path: `./${candidate.path}` } : candidate)),
		query,
	);
}

function explicitPathQuery(query: string): boolean {
	return query.startsWith("../") || query.startsWith("~/") || query.startsWith("/");
}

function resolveDisplayBase(basePath: string, displayBase: string): string {
	if (displayBase.startsWith("~/")) return resolve(homedir(), displayBase.slice(2));
	if (displayBase.startsWith("/")) return resolve(displayBase);
	return resolve(basePath, displayBase);
}

function workspaceRelative(basePath: string, absolutePath: string): string | null {
	const candidate = posixPath(relative(basePath, absolutePath));
	if (candidate.length === 0 || candidate === ".." || candidate.startsWith("../")) return null;
	return safeRelativePath(candidate);
}

async function explicitCandidates(
	basePath: string,
	query: string,
	trackedFiles: ReadonlySet<string>,
): Promise<FileCandidate[]> {
	const slash = query.lastIndexOf("/");
	if (slash < 0) return [];
	const displayBase = query.slice(0, slash + 1);
	const fragment = query.slice(slash + 1);
	const directory = resolveDisplayBase(basePath, displayBase);
	const candidates: FileCandidate[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.name === ".git" || /[\r\n\0]/u.test(entry.name)) continue;
		const absolutePath = join(directory, entry.name);
		let isDirectory = entry.isDirectory();
		let isFile = entry.isFile();
		if (!isDirectory && !isFile && entry.isSymbolicLink()) {
			try {
				const facts = await stat(absolutePath);
				isDirectory = facts.isDirectory();
				isFile = facts.isFile();
			} catch {
				continue;
			}
		}
		if (!isDirectory && !isFile) continue;
		const relativePath = workspaceRelative(basePath, absolutePath);
		candidates.push({
			path: `${displayBase}${entry.name}`,
			absolutePath,
			isDirectory,
			tracked: relativePath !== null && trackedFiles.has(relativePath),
			descendantFiles: 0,
			workspace: relativePath !== null,
		});
	}
	return fuzzyOrdered(candidates, fragment);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}

function cleanPreview(bytes: Buffer): string | null {
	if (bytes.includes(0)) return "binary file";
	const text = stripTerminalSequences(bytes.toString("utf8"));
	const line = text
		.split(/\r?\n/u)
		.map((candidate) =>
			Array.from(candidate, (character) => {
				const code = character.codePointAt(0) ?? 0;
				return code < 32 || code === 127 ? " " : character;
			})
				.join("")
				.trim(),
		)
		.find((candidate) => candidate.length > 0);
	if (!line) return null;
	return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line;
}

async function candidateDescription(candidate: FileCandidate): Promise<string> {
	const provenance = candidate.tracked ? "git tracked" : candidate.workspace ? "untracked" : "filesystem";
	if (candidate.isDirectory) {
		const count = candidate.descendantFiles > 0 ? ` · ${candidate.descendantFiles} files` : "";
		return `${provenance} directory${count} · Tab/Enter opens`;
	}
	try {
		const facts = await stat(candidate.absolutePath);
		const handle = await open(candidate.absolutePath, "r");
		let preview: string | null = null;
		try {
			const buffer = Buffer.alloc(Math.min(PREVIEW_BYTES, Math.max(0, facts.size)));
			if (buffer.length > 0) {
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
				preview = cleanPreview(buffer.subarray(0, bytesRead));
			}
		} finally {
			await handle.close();
		}
		return `${provenance} · ${formatBytes(facts.size)}${preview ? ` · ${preview}` : ""}`;
	} catch {
		return `${provenance} · preview unavailable`;
	}
}

/** Quote a completion exactly the way the inline-reference scanner accepts. */
export function formatInlineFileReference(path: string, isDirectory: boolean): string {
	const completionPath = isDirectory ? `${path.replace(/\/$/u, "")}/` : path;
	if (!/[\s"'\\]/u.test(completionPath) && !isEditorSteerTargetToken(completionPath)) return `@${completionPath}`;
	return `@"${completionPath.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function completionId(candidate: FileCandidate): string {
	return `file-reference:${candidate.isDirectory ? "directory" : "file"}:${candidate.absolutePath}`;
}

/**
 * Workspace-aware `@` source for Clio's one grammar-aware composer provider.
 * A bare `@` is a top-level tree; text without a slash fuzzes the whole
 * workspace; a real directory prefix becomes its child submenu. Explicit
 * `../`, `~/`, and absolute prefixes stay scoped filesystem navigation.
 */
export function createFileReferenceCompletionSource(
	options: FileReferenceCompletionOptions,
): FileReferenceCompletionSource {
	const basePath = resolve(options.basePath);
	const listWorkspaceFiles = options.listWorkspaceFiles ?? ((cwd: string) => enumerateWorkspaceFilesAsync(cwd));
	const listTrackedFiles = options.listTrackedFiles ?? gitTrackedFiles;
	const cacheTtlMs = options.cacheTtlMs ?? SNAPSHOT_TTL_MS;
	let cached: { expiresAt: number; snapshot: WorkspaceSnapshot } | null = null;
	let loading: Promise<WorkspaceSnapshot> | null = null;

	const snapshot = async (): Promise<WorkspaceSnapshot> => {
		const now = Date.now();
		if (cached && cached.expiresAt > now) return cached.snapshot;
		loading ??= Promise.all([listWorkspaceFiles(basePath), listTrackedFiles(basePath)]).then(([visible, tracked]) =>
			buildWorkspaceSnapshot(basePath, visible, tracked),
		);
		try {
			const next = await loading;
			cached = { expiresAt: now + cacheTtlMs, snapshot: next };
			return next;
		} finally {
			loading = null;
		}
	};

	return async (request) => {
		if (request.signal.aborted) return [];
		try {
			const workspace = await snapshot();
			if (request.signal.aborted) return [];
			const candidates = explicitPathQuery(request.query)
				? await explicitCandidates(basePath, request.query, workspace.trackedFiles)
				: workspaceCandidates(workspace, request.query);
			if (request.signal.aborted) return [];
			const top = candidates.slice(0, MAX_COMPLETION_ROWS);
			const descriptions = await Promise.all(top.map(candidateDescription));
			if (request.signal.aborted) return [];
			return top.map((candidate, index) => ({
				id: completionId(candidate),
				value: formatInlineFileReference(candidate.path, candidate.isDirectory),
				path: candidate.path,
				label: `${candidate.path}${candidate.isDirectory ? "/" : ""}`,
				description: descriptions[index] ?? "preview unavailable",
				isDirectory: candidate.isDirectory,
				tracked: candidate.tracked,
			}));
		} catch {
			return [];
		}
	};
}
