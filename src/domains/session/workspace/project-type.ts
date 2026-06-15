import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type SourceProjectType = "typescript" | "javascript" | "python" | "rust" | "go" | "c" | "c++" | "java" | "ruby";

export type ProjectType = SourceProjectType | "polyglot" | "dotfiles" | "unknown";

export interface ProjectTypeProfile {
	projectType: ProjectType;
	sourceFiles: number;
	languageCounts: Record<SourceProjectType, number>;
	manifestCounts: Partial<Record<SourceProjectType, number>>;
	dominantLanguage?: SourceProjectType;
	polyglot: boolean;
}

const SOURCE_LANGUAGES: ReadonlyArray<SourceProjectType> = [
	"typescript",
	"javascript",
	"python",
	"rust",
	"go",
	"c",
	"c++",
	"java",
	"ruby",
];

const EXCLUDED_DIRS = new Set([
	".git",
	".clio",
	".hg",
	".svn",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".venv",
	"venv",
	"__pycache__",
	"target",
	"vendor",
]);

const EXTENSION_LANGUAGES = new Map<string, SourceProjectType>([
	[".ts", "typescript"],
	[".tsx", "typescript"],
	[".mts", "typescript"],
	[".cts", "typescript"],
	[".js", "javascript"],
	[".jsx", "javascript"],
	[".mjs", "javascript"],
	[".cjs", "javascript"],
	[".py", "python"],
	[".pyw", "python"],
	[".rs", "rust"],
	[".go", "go"],
	[".c", "c"],
	[".h", "c"],
	[".cc", "c++"],
	[".cpp", "c++"],
	[".cxx", "c++"],
	[".hpp", "c++"],
	[".hh", "c++"],
	[".hxx", "c++"],
	[".java", "java"],
	[".rb", "ruby"],
]);

const MANIFEST_LANGUAGES: ReadonlyArray<{ name: string; type: SourceProjectType }> = [
	{ name: "package.json", type: "typescript" },
	{ name: "pyproject.toml", type: "python" },
	{ name: "setup.py", type: "python" },
	{ name: "Cargo.toml", type: "rust" },
	{ name: "go.mod", type: "go" },
	{ name: "pom.xml", type: "java" },
	{ name: "CMakeLists.txt", type: "c++" },
	{ name: "compile_commands.json", type: "c++" },
	{ name: "Gemfile", type: "ruby" },
];

function emptyLanguageCounts(): Record<SourceProjectType, number> {
	return {
		typescript: 0,
		javascript: 0,
		python: 0,
		rust: 0,
		go: 0,
		c: 0,
		"c++": 0,
		java: 0,
		ruby: 0,
	};
}

function extensionOf(name: string): string {
	const index = name.lastIndexOf(".");
	return index === -1 ? "" : name.slice(index);
}

function countManifest(name: string, manifestCounts: Partial<Record<SourceProjectType, number>>): void {
	for (const marker of MANIFEST_LANGUAGES) {
		if (name !== marker.name) continue;
		manifestCounts[marker.type] = (manifestCounts[marker.type] ?? 0) + 1;
	}
}

function scanTree(
	dir: string,
	languageCounts: Record<SourceProjectType, number>,
	manifestCounts: Partial<Record<SourceProjectType, number>>,
): void {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (EXCLUDED_DIRS.has(entry.name)) continue;
			scanTree(join(dir, entry.name), languageCounts, manifestCounts);
			continue;
		}
		if (!entry.isFile()) continue;
		countManifest(entry.name, manifestCounts);
		if (entry.name.endsWith(".d.ts")) continue;
		const language = EXTENSION_LANGUAGES.get(extensionOf(entry.name));
		if (language) languageCounts[language] += 1;
	}
}

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

function dominantFromCounts(
	counts: Readonly<Partial<Record<SourceProjectType, number>>>,
): SourceProjectType | undefined {
	let best: SourceProjectType | undefined;
	let bestCount = 0;
	for (const language of SOURCE_LANGUAGES) {
		const count = counts[language] ?? 0;
		if (count > bestCount) {
			best = language;
			bestCount = count;
		} else if (count === bestCount && count > 0) {
			best = undefined;
		}
	}
	return best;
}

export function detectProjectProfile(cwd: string): ProjectTypeProfile {
	const languageCounts = emptyLanguageCounts();
	const manifestCounts: Partial<Record<SourceProjectType, number>> = {};
	scanTree(cwd, languageCounts, manifestCounts);
	const sourceFiles = SOURCE_LANGUAGES.reduce((sum, language) => sum + languageCounts[language], 0);
	const dominantSource = dominantFromCounts(languageCounts);
	const dominantCount = dominantSource ? languageCounts[dominantSource] : 0;
	const polyglot = sourceFiles > 0 && dominantCount / sourceFiles <= 0.7;
	if (sourceFiles > 0) {
		return {
			projectType: polyglot ? "polyglot" : (dominantSource ?? "polyglot"),
			sourceFiles,
			languageCounts,
			manifestCounts,
			...(dominantSource ? { dominantLanguage: dominantSource } : {}),
			polyglot,
		};
	}
	const manifestDominant = dominantFromCounts(manifestCounts);
	if (manifestDominant) {
		return {
			projectType: manifestDominant,
			sourceFiles,
			languageCounts,
			manifestCounts,
			dominantLanguage: manifestDominant,
			polyglot: false,
		};
	}
	const manifestTotal = SOURCE_LANGUAGES.reduce((sum, language) => sum + (manifestCounts[language] ?? 0), 0);
	if (manifestTotal > 0) {
		return {
			projectType: "polyglot",
			sourceFiles,
			languageCounts,
			manifestCounts,
			polyglot: true,
		};
	}
	return {
		projectType: looksLikeDotfiles(cwd) ? "dotfiles" : "unknown",
		sourceFiles,
		languageCounts,
		manifestCounts,
		polyglot: false,
	};
}

export function detectProjectType(cwd: string): ProjectType {
	return detectProjectProfile(cwd).projectType;
}
