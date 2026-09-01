import { execFile } from "node:child_process";
import { cp, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { EvalWorkspaceV2 } from "../schema/suite.js";
import type { PreparedEvalWorkspace } from "./local.js";

const execFileAsync = promisify(execFile);
const GIT_FILE_LIST_LIMIT_BYTES = 128 * 1024 * 1024;

export interface EvalWorkspaceCopyOptions {
	recursive: true;
	filter: (source: string, destination: string) => boolean;
}

export type EvalWorkspaceCopy = (
	source: string,
	destination: string,
	options: EvalWorkspaceCopyOptions,
) => Promise<void>;

export interface PrepareTempCopyWorkspaceOptions {
	/** Test/integration seam; production uses node:fs/promises.cp. */
	copy?: EvalWorkspaceCopy;
	/** Parent for both workspace and suite-owned state directories. */
	tempRoot?: string;
}

export async function prepareTempCopyWorkspace(
	baseDir: string,
	workspace: EvalWorkspaceV2,
	options: PrepareTempCopyWorkspaceOptions = {},
): Promise<PreparedEvalWorkspace> {
	const source = resolve(baseDir, workspace.path ?? ".");
	const dest = await mkdtemp(resolve(options.tempRoot ?? tmpdir(), "clio-coder-eval-workspace-"));
	try {
		const selection = await gitCopySelection(source);
		const excludes = workspace.excludes ?? [];
		const copyWorkspace = options.copy ?? defaultCopy;
		await copyWorkspace(source, dest, {
			recursive: true,
			filter: (path) => shouldCopy(relative(source, path), excludes, selection),
		});
		return {
			dir: dest,
			cleanup: async () => {
				await rm(dest, { recursive: true, force: true });
			},
		};
	} catch (error) {
		// `mkdtemp` succeeded before either Git enumeration or the recursive
		// copy could throw. The preparer still owns that incomplete destination.
		await rm(dest, { recursive: true, force: true });
		throw error;
	}
}

function isExcluded(rel: string, excludes: ReadonlyArray<string>): boolean {
	const normalized = rel.replaceAll("\\", "/");
	return excludes.some((entry) => normalized === entry || normalized.startsWith(`${entry.replaceAll("\\", "/")}/`));
}

async function defaultCopy(source: string, destination: string, options: EvalWorkspaceCopyOptions): Promise<void> {
	await cp(source, destination, options);
}

interface GitCopySelection {
	files: ReadonlySet<string>;
	directories: ReadonlySet<string>;
}

function shouldCopy(
	relativePath: string,
	excludes: ReadonlyArray<string>,
	selection: GitCopySelection | null,
): boolean {
	const normalized = relativePath.replaceAll("\\", "/");
	if (normalized.length === 0) return true;
	if (isExcluded(normalized, excludes)) return false;
	if (selection === null) return true;
	return selection.files.has(normalized) || selection.directories.has(normalized);
}

/**
 * A Git checkout supplies the authoritative copy set: tracked files plus
 * untracked files that are not ignored. Outside Git, null preserves the
 * existing recursive-copy behavior.
 */
async function gitCopySelection(source: string): Promise<GitCopySelection | null> {
	let inside: string;
	try {
		inside = await gitOutput(source, ["rev-parse", "--is-inside-work-tree"]);
	} catch (error) {
		// Outside a checkout, Git's refusal selects the legacy recursive path. A
		// checkout whose Git query broke must fail closed: falling back there can
		// silently copy the ignored data this branch exists to exclude.
		if (await hasGitMarker(source)) throw error;
		return null;
	}
	if (inside.trim() !== "true") return null;

	const output = await gitOutput(source, [
		"--literal-pathspecs",
		"ls-files",
		"-z",
		"--cached",
		"--others",
		"--exclude-standard",
		"--",
		".",
	]);
	const files = new Set<string>();
	const directories = new Set<string>();
	for (const path of output.split("\0")) {
		if (path.length === 0) continue;
		const normalized = normalizeGitPath(path);
		if (normalized === null) throw new Error("git ls-files returned a path outside the eval workspace");
		files.add(normalized);
		let separator = normalized.lastIndexOf("/");
		while (separator >= 0) {
			directories.add(normalized.slice(0, separator));
			separator = normalized.lastIndexOf("/", separator - 1);
		}
	}
	return { files, directories };
}

async function gitOutput(cwd: string, args: ReadonlyArray<string>): Promise<string> {
	const { stdout } = await execFileAsync("git", [...args], {
		cwd,
		encoding: "utf8",
		maxBuffer: GIT_FILE_LIST_LIMIT_BYTES,
	});
	return stdout;
}

function normalizeGitPath(path: string): string | null {
	const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
	if (normalized.length === 0 || normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) return null;
	const segments = normalized.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
	return normalized;
}

async function hasGitMarker(source: string): Promise<boolean> {
	let current = resolve(source);
	while (true) {
		try {
			await lstat(resolve(current, ".git"));
			return true;
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
		}
		const parent = resolve(current, "..");
		if (parent === current) return false;
		current = parent;
	}
}
