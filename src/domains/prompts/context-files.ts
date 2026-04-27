/**
 * project context-file loader for the prompts domain.
 *
 * walks from the filesystem root down to `cwd` and reads every matching
 * filename in `DEFAULT_CONTEXT_FILE_NAMES`. each file is classified by
 * filename into an InstructionSourceKind so the merger can apply the
 * conflict policy (CLIO.md wins; CLIO-dev.md overrides CLIO.md; among
 * the rest, child-closest-to-cwd wins).
 *
 * `renderProjectContextFiles` is now a thin wrapper around the merger;
 * callers receive a single deterministic block keyed by canonical
 * section header rather than a per-file concatenation.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
	type InstructionSource,
	type InstructionSourceKind,
	mergeInstructions,
	parseSections,
} from "./instruction-merge.js";

export const DEFAULT_CONTEXT_FILE_NAMES = ["CLIO.md", "CLAUDE.md", "AGENTS.md", "CODEX.md", "GEMINI.md"] as const;

const FILENAME_TO_KIND: Record<string, InstructionSourceKind> = {
	"CLIO.md": "clio",
	"CLAUDE.md": "claude",
	"AGENTS.md": "agents",
	"CODEX.md": "codex",
	"GEMINI.md": "gemini",
};

const DEV_FILE_NAME = "CLIO-dev.md";

export interface ProjectContextFile {
	path: string;
	name: string;
	content: string;
	kind: InstructionSourceKind;
}

export interface LoadProjectContextFilesInput {
	cwd: string;
	fileNames?: ReadonlyArray<string>;
	/** Optional repo root: when set, CLIO-dev.md is loaded from this path or the XDG fallback. */
	devRepoRoot?: string;
}

function candidateDirs(cwd: string): string[] {
	const dirs: string[] = [];
	let current = path.resolve(cwd);
	for (;;) {
		dirs.push(current);
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs.reverse();
}

function readFileIfPresent(filePath: string): string | null {
	try {
		if (!statSync(filePath).isFile()) return null;
		return readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
}

function classifyByName(name: string): InstructionSourceKind {
	const kind = FILENAME_TO_KIND[name];
	if (kind) return kind;
	// Caller passed a custom filename; treat as agents-tier (low priority).
	return "agents";
}

export function loadProjectContextFiles(input: LoadProjectContextFilesInput): ProjectContextFile[] {
	const fileNames = input.fileNames ?? DEFAULT_CONTEXT_FILE_NAMES;
	const seen = new Set<string>();
	const out: ProjectContextFile[] = [];
	for (const dir of candidateDirs(input.cwd)) {
		for (const name of fileNames) {
			const filePath = path.resolve(dir, name);
			if (seen.has(filePath)) continue;
			seen.add(filePath);
			const content = readFileIfPresent(filePath);
			if (content === null) continue;
			out.push({ path: filePath, name, content, kind: classifyByName(name) });
		}
	}
	return out;
}

/**
 * Resolve the dev-mode supplement. Looks first at <repoRoot>/CLIO-dev.md,
 * then falls back to ~/.config/clio/CLIO-dev.md. Returns null when neither
 * exists.
 */
export function loadDevContextFile(repoRoot: string): ProjectContextFile | null {
	const candidates = [path.join(repoRoot, DEV_FILE_NAME), path.join(homedir(), ".config", "clio", DEV_FILE_NAME)];
	for (const filePath of candidates) {
		if (!existsSync(filePath)) continue;
		const content = readFileIfPresent(filePath);
		if (content === null) continue;
		return { path: filePath, name: DEV_FILE_NAME, content, kind: "clio-dev" };
	}
	return null;
}

function toInstructionSources(files: ReadonlyArray<ProjectContextFile>): InstructionSource[] {
	return files.map((file) => ({ path: file.path, kind: file.kind, sections: parseSections(file.content) }));
}

export function renderProjectContextFiles(files: ReadonlyArray<ProjectContextFile>, _cwd: string): string {
	if (files.length === 0) return "";
	const merged = mergeInstructions(toInstructionSources(files));
	if (merged.text.length === 0) return "";
	return [
		"Earlier files are broader repository context; later files are more specific.",
		"CLIO.md wins on conflicts; CLIO-dev.md (when present) overrides CLIO.md.",
		"",
		merged.text,
	].join("\n");
}
