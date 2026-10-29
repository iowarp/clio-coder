import { closeSync, openSync, readdirSync, readSync } from "node:fs";
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

/**
 * Reading and classifying every `.h` took about 50 s at session start in the
 * Linux kernel's 27,291 headers (#441). The C or C++ split needs a sample:
 * at most this many headers, evenly spaced over the sorted list so the result
 * is deterministic, with the rest apportioned by the sampled ratio.
 */
const HEADER_SAMPLE_LIMIT = 256;
/** C++ includes, classes and templates sit near the top of a header (#441). */
const HEADER_READ_BYTES = 64 * 1024;

function classifyHeaders(cwd: string, headers: string[], languageCounts: Record<SourceProjectType, number>): void {
	if (headers.length === 0) return;
	headers.sort();
	const sampled = Math.min(headers.length, HEADER_SAMPLE_LIMIT);
	const buffer = Buffer.alloc(HEADER_READ_BYTES);
	let cpp = 0;
	for (let index = 0; index < sampled; index += 1) {
		const path = headers[Math.floor((index * headers.length) / sampled)] ?? "";
		let fd: number | undefined;
		try {
			fd = openSync(join(cwd, path), "r");
			const bytes = readSync(fd, buffer, 0, HEADER_READ_BYTES, 0);
			if (classifyCHeaderLanguage(buffer.toString("utf8", 0, bytes)) === "c++") cpp += 1;
		} catch {
			// An unreadable header counts as C, as it did before sampling.
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
	const cppTotal = Math.round((cpp * headers.length) / sampled);
	languageCounts["c++"] += cppTotal;
	languageCounts.c += headers.length - cppTotal;
}

function scanFiles(
	cwd: string,
	files: ReadonlyArray<string>,
	languageCounts: Record<SourceProjectType, number>,
	manifestCounts: Partial<Record<SourceProjectType, number>>,
): void {
	const headers: string[] = [];
	for (const path of files) {
		const name = path.split("/").pop() ?? path;
		countManifest(name, manifestCounts);
		if (name.endsWith(".d.ts")) continue;
		const extension = extensionOf(name);
		if (extension === ".h") {
			headers.push(path);
			continue;
		}
		const language = EXTENSION_LANGUAGES.get(extension);
		if (language) languageCounts[language] += 1;
	}
	classifyHeaders(cwd, headers, languageCounts);
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

/** A root-only hint for foreground prompts/startup; never reads or parses source. */
export function detectProjectTypeHint(cwd: string): ProjectType {
	let names: string[];
	try {
		names = readdirSync(cwd, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name);
	} catch {
		return "unknown";
	}
	const manifests: Partial<Record<SourceProjectType, number>> = {};
	for (const name of names) countManifest(name, manifests);
	const declared = SOURCE_LANGUAGES.filter((language) => (manifests[language] ?? 0) > 0);
	if (declared.length > 1) return "polyglot";
	if (declared.length === 1) return declared[0] ?? "unknown";
	const hints = new Set(
		names
			.filter((name) => !name.endsWith(".h") && !name.endsWith(".d.ts"))
			.map((name) => EXTENSION_LANGUAGES.get(extensionOf(name)))
			.filter((language) => language !== undefined),
	);
	return hints.size > 1 ? "polyglot" : ([...hints][0] ?? "unknown");
}
