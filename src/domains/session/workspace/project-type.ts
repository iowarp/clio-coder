import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type ProjectType = "node" | "python" | "rust" | "go" | "dotfiles" | "unknown";

const FILE_MARKERS: ReadonlyArray<{ file: string; type: ProjectType }> = [
	{ file: "package.json", type: "node" },
	{ file: "pyproject.toml", type: "python" },
	{ file: "setup.py", type: "python" },
	{ file: "Cargo.toml", type: "rust" },
	{ file: "go.mod", type: "go" },
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
	for (const marker of FILE_MARKERS) {
		if (existsSync(join(cwd, marker.file))) return marker.type;
	}
	if (looksLikeDotfiles(cwd)) return "dotfiles";
	return "unknown";
}
