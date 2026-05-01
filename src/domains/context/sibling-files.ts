import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SiblingContextFile {
	source: string;
	path: string;
	content: string;
}

const LOCAL_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", "CODEX.md"] as const;
const LOCAL_NESTED_FILES = [join(".claude", "CLAUDE.md")] as const;

function readFileIfPresent(source: string, filePath: string): SiblingContextFile | null {
	try {
		if (!statSync(filePath).isFile()) return null;
		return { source, path: filePath, content: readFileSync(filePath, "utf8") };
	} catch {
		return null;
	}
}

function markdownFilesInDir(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((name) => name.endsWith(".md"))
			.sort((a, b) => a.localeCompare(b))
			.map((name) => join(dir, name));
	} catch {
		return [];
	}
}

export function loadSiblingContextFiles(cwd: string): SiblingContextFile[] {
	const files: SiblingContextFile[] = [];
	for (const name of LOCAL_FILES) {
		const found = readFileIfPresent("project", join(cwd, name));
		if (found) files.push(found);
	}
	for (const relPath of LOCAL_NESTED_FILES) {
		const found = readFileIfPresent("project", join(cwd, relPath));
		if (found) files.push(found);
	}
	for (const filePath of markdownFilesInDir(join(cwd, ".cursor", "rules"))) {
		const found = readFileIfPresent("project", filePath);
		if (found) files.push(found);
	}

	const home = homedir();
	const globalCandidates = [join(home, ".claude", "CLAUDE.md"), join(home, ".gemini", "GEMINI.md")];
	for (const filePath of globalCandidates) {
		const found = readFileIfPresent("global", filePath);
		if (found) files.push(found);
	}
	const agentsDir = join(home, ".config", "agents");
	if (existsSync(agentsDir)) {
		for (const filePath of markdownFilesInDir(agentsDir)) {
			const found = readFileIfPresent("global", filePath);
			if (found) files.push(found);
		}
	}
	return files;
}
