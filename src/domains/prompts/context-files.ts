/**
 * project context-file loader for the prompts domain.
 *
 * walks from the filesystem root down to `cwd` and reads every matching
 * filename in `DEFAULT_CONTEXT_FILE_NAMES` (`["AGENTS.md", "CLAUDE.md",
 * "CODEX.md"]`). order matters: broader scope first, more specific later, so
 * `renderProjectContextFiles` can let later files override earlier ones.
 *
 * deliberate divergence from pi-coding-agent's `loadContextFileFromDir`, which
 * picks the first matching filename per directory. clio loads ALL matching
 * files in each directory so AGENTS.md, CLAUDE.md, and CODEX.md can coexist.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export const DEFAULT_CONTEXT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md", "CODEX.md"] as const;

export interface ProjectContextFile {
	path: string;
	name: string;
	content: string;
}

export interface LoadProjectContextFilesInput {
	cwd: string;
	fileNames?: ReadonlyArray<string>;
}

function normalizePath(filePath: string): string {
	return filePath.split(path.sep).join("/");
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
			out.push({ path: filePath, name, content });
		}
	}
	return out;
}

export function renderProjectContextFiles(files: ReadonlyArray<ProjectContextFile>, cwd: string): string {
	const parts: string[] = [];
	for (const file of files) {
		const relPath = normalizePath(path.relative(path.resolve(cwd), file.path)) || file.name;
		const content = file.content.trim();
		if (content.length === 0) continue;
		parts.push([`## ${relPath}`, "", content].join("\n"));
	}
	if (parts.length === 0) return "";
	return [
		"Earlier files are broader repository context; later files are more specific.",
		"When files conflict, follow the later file unless higher-priority Clio instructions say otherwise.",
		"",
		...parts,
	].join("\n\n");
}
