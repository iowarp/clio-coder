import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type ProjectType = "typescript" | "python" | "rust" | "go" | "c++" | "polyglot" | "dotfiles" | "unknown";

const FILE_MARKERS: ReadonlyArray<{ file: string; type: Exclude<ProjectType, "dotfiles" | "unknown" | "polyglot"> }> = [
	{ file: "package.json", type: "typescript" },
	{ file: "pyproject.toml", type: "python" },
	{ file: "setup.py", type: "python" },
	{ file: "Cargo.toml", type: "rust" },
	{ file: "go.mod", type: "go" },
	{ file: "CMakeLists.txt", type: "c++" },
	{ file: "compile_commands.json", type: "c++" },
];

function looksLikeDotfiles(cwd: string): boolean {
	let entries: string[];
	try {
		entries = readdirSync(cwd);
	} catch {
		return false;
	}
	let dotDirs = 0;
	for (const name of entries) {
		if (!name.startsWith("dot-")) continue;
		try {
			if (statSync(join(cwd, name)).isDirectory()) dotDirs += 1;
		} catch {
			// ignore unreadable entries
		}
		if (dotDirs >= 2) return true;
	}
	return false;
}

export function detectProjectType(cwd: string): ProjectType {
	const found = new Set<ProjectType>();
	for (const marker of FILE_MARKERS) {
		if (existsSync(join(cwd, marker.file))) found.add(marker.type);
	}
	if (found.size > 1) return "polyglot";
	const first = [...found][0];
	if (first) return first;
	if (looksLikeDotfiles(cwd)) return "dotfiles";
	return "unknown";
}
