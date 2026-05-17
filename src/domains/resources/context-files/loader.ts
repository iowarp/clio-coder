import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
	type InstructionSource,
	type InstructionSourceKind,
	mergeInstructions,
	parseSections,
} from "../../prompts/instruction-merge.js";

export const DEFAULT_CONTEXT_FILE_NAMES = ["CLIO.md", "CLAUDE.md", "AGENTS.md", "CODEX.md", "GEMINI.md"] as const;

const FILENAME_TO_KIND: Record<string, InstructionSourceKind> = {
	"CLIO.md": "clio",
	"CLAUDE.md": "claude",
	"AGENTS.md": "agents",
	"CODEX.md": "codex",
	"GEMINI.md": "gemini",
};

export interface ProjectContextFile {
	path: string;
	name: string;
	content: string;
	kind: InstructionSourceKind;
}

export interface LoadProjectContextFilesInput {
	cwd: string;
	fileNames?: ReadonlyArray<string>;
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
	return FILENAME_TO_KIND[name] ?? "agents";
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

function toInstructionSources(files: ReadonlyArray<ProjectContextFile>): InstructionSource[] {
	return files.map((file) => ({ path: file.path, kind: file.kind, sections: parseSections(file.content) }));
}

export function renderProjectContextFiles(files: ReadonlyArray<ProjectContextFile>, _cwd: string): string {
	if (files.length === 0) return "";
	const merged = mergeInstructions(toInstructionSources(files));
	if (merged.text.length === 0) return "";
	return [
		"Earlier files are broader repository context; later files are more specific.",
		"CLIO.md wins on conflicts.",
		"",
		merged.text,
	].join("\n");
}
