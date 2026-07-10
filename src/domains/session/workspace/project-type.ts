import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyCHeaderLanguage } from "../../../core/c-header-language.js";
import { enumerateWorkspaceFiles } from "../../../core/workspace-files.js";

export type SourceProjectType =
	| "typescript"
	| "javascript"
	| "python"
	| "rust"
	| "go"
	| "c"
	| "c++"
	| "java"
	| "ruby"
	| "c#";

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
	"c#",
];

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
	[".cu", "c++"],
	[".cuh", "c++"],
	[".java", "java"],
	[".rb", "ruby"],
	[".cs", "c#"],
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
	{ name: "*.csproj", type: "c#" },
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
		"c#": 0,
	};
}

function extensionOf(name: string): string {
	const index = name.lastIndexOf(".");
	return index === -1 ? "" : name.slice(index);
}

function countManifest(name: string, manifestCounts: Partial<Record<SourceProjectType, number>>): void {
	for (const marker of MANIFEST_LANGUAGES) {
		if (marker.name.startsWith("*.")) {
			const ext = marker.name.slice(1);
			if (name.endsWith(ext)) {
				manifestCounts[marker.type] = (manifestCounts[marker.type] ?? 0) + 1;
			}
		} else {
			if (name !== marker.name) continue;
			manifestCounts[marker.type] = (manifestCounts[marker.type] ?? 0) + 1;
		}
	}
}

function scanFiles(
	cwd: string,
	files: ReadonlyArray<string>,
	languageCounts: Record<SourceProjectType, number>,
	manifestCounts: Partial<Record<SourceProjectType, number>>,
): void {
	for (const path of files) {
		const name = path.split("/").pop() ?? path;
		countManifest(name, manifestCounts);
		if (name.endsWith(".d.ts")) continue;
		const extension = extensionOf(name);
		let language = EXTENSION_LANGUAGES.get(extension);
		if (extension === ".h") {
			try {
				language = classifyCHeaderLanguage(readFileSync(join(cwd, path), "utf8"));
			} catch {
				language = "c";
			}
		}
		if (language) languageCounts[language] += 1;
	}
}

function looksLikeDotfiles(files: ReadonlyArray<string>): boolean {
	const dotDirs = new Set<string>();
	for (const path of files) {
		const [root, child] = path.split("/", 2);
		if (child && root?.startsWith("dot-")) dotDirs.add(root);
	}
	return dotDirs.size >= 2;
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
	const files = enumerateWorkspaceFiles(cwd);
	scanFiles(cwd, files, languageCounts, manifestCounts);
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
		projectType: looksLikeDotfiles(files) ? "dotfiles" : "unknown",
		sourceFiles,
		languageCounts,
		manifestCounts,
		polyglot: false,
	};
}

export function detectProjectType(cwd: string): ProjectType {
	return detectProjectProfile(cwd).projectType;
}
