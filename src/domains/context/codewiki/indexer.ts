import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { ProjectType, SourceProjectType } from "../../session/workspace/project-type.js";

export type CodewikiLanguage = SourceProjectType | "config";
export type CodewikiFileRole = "entry" | "test" | "module" | "config";
export type CodewikiSymbolKind = "func" | "class" | "method" | "type" | "const" | "var" | "trait" | "iface";

export interface CodewikiFile {
	id: string;
	path: string;
	lang: CodewikiLanguage;
	loc: number;
	role: CodewikiFileRole;
}

export interface CodewikiSymbol {
	name: string;
	kind: CodewikiSymbolKind;
	fileId: string;
	line: number;
	sig?: string;
}

export interface CodewikiInternalEdge {
	fileId: string;
	toFileId: string;
}

export interface CodewikiExternalEdge {
	fileId: string;
	externalModule: string;
}

export type CodewikiEdge = CodewikiInternalEdge | CodewikiExternalEdge;

export interface Codewiki {
	version: 3;
	language: ProjectType;
	files: CodewikiFile[];
	symbols: CodewikiSymbol[];
	edges: CodewikiEdge[];
}

export interface CodewikiEntry {
	path: string;
	exports: string[];
	imports: string[];
	kind: "entry-point" | "test" | "module";
	summary?: string;
}

export interface BuildCodewikiInput {
	cwd: string;
	language: ProjectType;
	generatedAt?: string;
}

export interface ExtractedSymbol {
	name: string;
	kind: CodewikiSymbolKind;
	line: number;
	sig?: string;
}

export interface LanguageExtraction {
	symbols: ExtractedSymbol[];
	imports: string[];
	exports: string[];
}

export interface LanguageExtractor {
	langs: ReadonlyArray<CodewikiLanguage>;
	extract(path: string, text: string): LanguageExtraction;
}

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

const SOURCE_EXTENSIONS = new Map<string, SourceProjectType>([
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

const CONFIG_FILE_NAMES = new Set([
	"package.json",
	"pyproject.toml",
	"setup.py",
	"Cargo.toml",
	"go.mod",
	"pom.xml",
	"CMakeLists.txt",
	"compile_commands.json",
	"Gemfile",
]);

const RESOLUTION_EXTENSIONS = [
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".c",
	".h",
	".cc",
	".cpp",
	".cxx",
	".hpp",
	".hh",
	".hxx",
	".java",
	".rb",
];

function compareStrings(a: string, b: string): number {
	return a.localeCompare(b);
}

function stableFileId(path: string): string {
	return `f_${createHash("sha256").update(path).digest("hex").slice(0, 16)}`;
}

function extensionOf(name: string): string {
	const index = name.lastIndexOf(".");
	return index === -1 ? "" : name.slice(index);
}

function normalizeRel(cwd: string, filePath: string): string {
	return relative(cwd, filePath).split("\\").join("/");
}

function normalizeInputPath(path: string): string {
	return path.split("\\").join("/").replace(/^\.\//, "");
}

function sourceLanguageForPath(relPath: string): SourceProjectType | null {
	if (relPath.endsWith(".d.ts")) return null;
	return SOURCE_EXTENSIONS.get(extensionOf(relPath)) ?? null;
}

function languageForPath(relPath: string): CodewikiLanguage | null {
	const source = sourceLanguageForPath(relPath);
	if (source) return source;
	const name = relPath.split("/").pop() ?? relPath;
	return CONFIG_FILE_NAMES.has(name) ? "config" : null;
}

function isIndexablePath(relPath: string): boolean {
	if (relPath.split("/").some((segment) => EXCLUDED_DIRS.has(segment))) return false;
	return languageForPath(relPath) !== null;
}

function walkFiles(cwd: string, dir: string, out: string[]): void {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const absPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (EXCLUDED_DIRS.has(entry.name)) continue;
			walkFiles(cwd, absPath, out);
			continue;
		}
		if (!entry.isFile()) continue;
		const relPath = normalizeRel(cwd, absPath);
		if (isIndexablePath(relPath)) out.push(relPath);
	}
}

function lineCount(text: string): number {
	if (text.length === 0) return 0;
	return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

function roleFor(relPath: string, language: CodewikiLanguage): CodewikiFileRole {
	if (language === "config") return "config";
	const lower = relPath.toLowerCase();
	if (
		lower.includes("/test/") ||
		lower.includes("/tests/") ||
		/\.(test|spec)\.[cm]?[jt]sx?$/.test(lower) ||
		/(^|\/)test_.*\.py$/.test(lower) ||
		/(^|\/).*_test\.(go|rs|rb)$/.test(lower)
	) {
		return "test";
	}
	if (/(^|\/)(index|main|cli|orchestrator|bootstrap)\.[^.]+$/.test(lower) || lower.endsWith("/__main__.py")) {
		return "entry";
	}
	return "module";
}

function firstDocSummary(text: string): string | null {
	const jsDoc = /\/\*\*([\s\S]*?)\*\//.exec(text)?.[1];
	const pythonDoc = /^\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/.exec(text);
	const raw = jsDoc ?? pythonDoc?.[1] ?? pythonDoc?.[2];
	if (!raw) return null;
	const cleaned = raw
		.split("\n")
		.map((line) => line.replace(/^\s*\*\s?/, "").trim())
		.filter((line) => line.length > 0 && !line.startsWith("@"))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > 0 ? cleaned.slice(0, 160) : null;
}

function sanitizeSymbolName(value: string): string {
	return value
		.trim()
		.replace(/^self\./, "")
		.replace(/^this\./, "")
		.slice(0, 160);
}

function addSymbol(
	target: ExtractedSymbol[],
	seen: Set<string>,
	name: string | undefined,
	kind: CodewikiSymbolKind,
	line: number,
	sig?: string,
): void {
	if (!name) return;
	const clean = sanitizeSymbolName(name);
	if (clean.length === 0) return;
	const key = `${clean}\0${kind}\0${line}`;
	if (seen.has(key)) return;
	seen.add(key);
	target.push({
		name: clean,
		kind,
		line,
		...(sig && sig.trim().length > 0 ? { sig: sig.trim().slice(0, 240) } : {}),
	});
}

function uniqueSorted(values: Iterable<string>): string[] {
	return [...new Set([...values].filter((item) => item.length > 0))].sort(compareStrings);
}

function extractWithLineRegex(
	text: string,
	patterns: ReadonlyArray<{ regex: RegExp; kind: CodewikiSymbolKind; nameIndex?: number }>,
): ExtractedSymbol[] {
	const symbols: ExtractedSymbol[] = [];
	const seen = new Set<string>();
	const lines = text.split(/\r?\n/);
	for (const [index, line] of lines.entries()) {
		for (const pattern of patterns) {
			const match = pattern.regex.exec(line);
			if (!match) continue;
			const name = match[pattern.nameIndex ?? 1];
			addSymbol(symbols, seen, name, pattern.kind, index + 1, line.trim());
		}
	}
	return symbols.sort(compareSymbols);
}

function compareSymbols(
	a: Pick<CodewikiSymbol, "name" | "kind" | "line">,
	b: Pick<CodewikiSymbol, "name" | "kind" | "line">,
): number {
	return a.line - b.line || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind);
}

function extractMatches(text: string, regex: RegExp, group = 1): string[] {
	const out: string[] = [];
	for (const match of text.matchAll(regex)) {
		const value = match[group];
		if (value) out.push(value);
	}
	return out;
}

const tsJsExtractor: LanguageExtractor = {
	langs: ["typescript", "javascript"],
	extract(_path, text) {
		const symbols = extractWithLineRegex(text, [
			{ regex: /^\s*export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)?/, kind: "func" },
			{ regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/, kind: "func" },
			{ regex: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/, kind: "class" },
			{ regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/, kind: "iface" },
			{ regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/, kind: "type" },
			{ regex: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/, kind: "type" },
			{ regex: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\b/, kind: "const" },
			{ regex: /^\s*(?:export\s+)?(?:let|var)\s+([A-Za-z_$][\w$]*)\b/, kind: "var" },
			{
				regex: /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{?$/,
				kind: "method",
			},
		]);
		const imports = uniqueSorted([
			...extractMatches(text, /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g),
			...extractMatches(text, /\bexport\s+[^'"]*?\s+from\s+["']([^"']+)["']/g),
			...extractMatches(text, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
			...extractMatches(text, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
		]);
		const exports = uniqueSorted([
			...extractMatches(
				text,
				/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
			),
			...extractMatches(text, /^\s*export\s*\{\s*([^}]+)\s*\}/gm).flatMap((clause) =>
				clause
					.split(",")
					.map(
						(part) =>
							part
								.trim()
								.split(/\s+as\s+/i)
								.pop() ?? "",
					)
					.filter(Boolean),
			),
			...(text.includes("export default") ? ["default"] : []),
		]);
		return { symbols, imports, exports };
	},
};

const pythonExtractor: LanguageExtractor = {
	langs: ["python"],
	extract(_path, text) {
		const rawSymbols = extractWithLineRegex(text, [
			{ regex: /^(\s*)def\s+([A-Za-z_]\w*)\s*\(/, kind: "func", nameIndex: 2 },
			{ regex: /^(\s*)async\s+def\s+([A-Za-z_]\w*)\s*\(/, kind: "func", nameIndex: 2 },
			{ regex: /^\s*class\s+([A-Za-z_]\w*)\b/, kind: "class" },
			{ regex: /^([A-Z][A-Z0-9_]*)\s*=/, kind: "const" },
			{ regex: /^([A-Za-z_]\w*)\s*=/, kind: "var" },
		]);
		const symbols: ExtractedSymbol[] = rawSymbols.map((symbol) => {
			if ((symbol.kind === "func" || symbol.kind === "var") && /^\s+/.test(symbol.sig ?? "")) {
				return { ...symbol, kind: symbol.kind === "func" ? "method" : symbol.kind };
			}
			return symbol;
		});
		const imports = uniqueSorted([
			...extractMatches(text, /^\s*import\s+([A-Za-z_][\w.]*)(?:\s+as\s+\w+)?/gm),
			...extractMatches(text, /^\s*from\s+([.\w]+)\s+import\s+/gm),
		]);
		const exports = uniqueSorted([
			...extractMatches(text, /__all__\s*=\s*\[([^\]]*)\]/g).flatMap((clause) =>
				extractMatches(clause, /["']([^"']+)["']/g),
			),
			...symbols.filter((symbol) => !symbol.name.startsWith("_")).map((symbol) => symbol.name),
		]);
		return { symbols: symbols.sort(compareSymbols), imports, exports };
	},
};

const goExtractor: LanguageExtractor = {
	langs: ["go"],
	extract(_path, text) {
		const rawSymbols = extractWithLineRegex(text, [
			{ regex: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/, kind: "func" },
			{ regex: /^\s*type\s+([A-Za-z_]\w*)\s+interface\b/, kind: "iface" },
			{ regex: /^\s*type\s+([A-Za-z_]\w*)\s+struct\b/, kind: "type" },
			{ regex: /^\s*type\s+([A-Za-z_]\w*)\b/, kind: "type" },
			{ regex: /^\s*const\s+([A-Za-z_]\w*)\b/, kind: "const" },
			{ regex: /^\s*var\s+([A-Za-z_]\w*)\b/, kind: "var" },
		]);
		const symbols: ExtractedSymbol[] = rawSymbols.map((symbol) => {
			if (symbol.kind === "func" && /^\s*func\s+\(/.test(symbol.sig ?? "")) return { ...symbol, kind: "method" };
			return symbol;
		});
		const imports = uniqueSorted([
			...extractMatches(text, /^\s*import\s+"([^"]+)"/gm),
			...extractMatches(text, /^\s*"([^"]+)"\s*$/gm),
		]);
		const exports = uniqueSorted(symbols.filter((symbol) => /^[A-Z]/.test(symbol.name)).map((symbol) => symbol.name));
		return { symbols: symbols.sort(compareSymbols), imports, exports };
	},
};

const rustExtractor: LanguageExtractor = {
	langs: ["rust"],
	extract(_path, text) {
		const symbols = extractWithLineRegex(text, [
			{ regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?fn\s+([A-Za-z_]\w*)\s*[<(]/, kind: "func" },
			{ regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)\b/, kind: "type" },
			{ regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)\b/, kind: "type" },
			{ regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)\b/, kind: "trait" },
			{ regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)\b/, kind: "type" },
			{ regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?const\s+([A-Za-z_]\w*)\b/, kind: "const" },
			{ regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?static\s+([A-Za-z_]\w*)\b/, kind: "var" },
		]);
		const imports = uniqueSorted([
			...extractMatches(text, /^\s*use\s+([^;]+);/gm).map((item) => item.trim()),
			...extractMatches(text, /^\s*extern\s+crate\s+([A-Za-z_]\w*)/gm),
		]);
		const exports = uniqueSorted([
			...extractMatches(text, /^\s*pub(?:\([^)]*\))?\s+(?:fn|struct|enum|trait|type|const|static)\s+([A-Za-z_]\w*)/gm),
		]);
		return { symbols, imports, exports };
	},
};

const cFamilyExtractor: LanguageExtractor = {
	langs: ["c", "c++"],
	extract(_path, text) {
		const symbols = extractWithLineRegex(text, [
			{ regex: /^\s*(?:class|struct)\s+([A-Za-z_]\w*)\b/, kind: "class" },
			{ regex: /^\s*(?:typedef\s+)?(?:struct|enum)\s+([A-Za-z_]\w*)\b/, kind: "type" },
			{
				regex: /^\s*(?:template\s*<[^>]+>\s*)?(?:[A-Za-z_][\w:<>,*&\s]+\s+)+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{?$/,
				kind: "func",
			},
			{ regex: /^\s*(?:const\s+)?[A-Za-z_][\w:<>,*&\s]+\s+([A-Z][A-Z0-9_]*)\s*=/, kind: "const" },
		]);
		const imports = uniqueSorted(extractMatches(text, /^\s*#\s*include\s+[<"]([^>"]+)[>"]/gm));
		const exports = uniqueSorted(symbols.map((symbol) => symbol.name));
		return { symbols, imports, exports };
	},
};

const javaExtractor: LanguageExtractor = {
	langs: ["java"],
	extract(_path, text) {
		const symbols = extractWithLineRegex(text, [
			{ regex: /^\s*(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+)*class\s+([A-Za-z_]\w*)\b/, kind: "class" },
			{
				regex: /^\s*(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+)*interface\s+([A-Za-z_]\w*)\b/,
				kind: "iface",
			},
			{ regex: /^\s*(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+)*enum\s+([A-Za-z_]\w*)\b/, kind: "type" },
			{
				regex:
					/^\s*(?:public\s+|private\s+|protected\s+|static\s+|final\s+|synchronized\s+)*[A-Za-z_][\w<>,[\]\s]*\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\{?$/,
				kind: "method",
			},
			{
				regex:
					/^\s*(?:public\s+|private\s+|protected\s+|static\s+|final\s+)*[A-Za-z_][\w<>,[\]\s]*\s+([A-Z][A-Z0-9_]*)\s*=/,
				kind: "const",
			},
		]);
		const imports = uniqueSorted(extractMatches(text, /^\s*import\s+(?:static\s+)?([A-Za-z_][\w.*]*);/gm));
		const exports = uniqueSorted(
			symbols.filter((symbol) => ["class", "iface", "type"].includes(symbol.kind)).map((symbol) => symbol.name),
		);
		return { symbols, imports, exports };
	},
};

const rubyExtractor: LanguageExtractor = {
	langs: ["ruby"],
	extract(_path, text) {
		const symbols = extractWithLineRegex(text, [
			{ regex: /^\s*class\s+([A-Z]\w*(?:::[A-Z]\w*)*)\b/, kind: "class" },
			{ regex: /^\s*module\s+([A-Z]\w*(?:::[A-Z]\w*)*)\b/, kind: "type" },
			{ regex: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)\b/, kind: "func" },
			{ regex: /^\s*([A-Z][A-Z0-9_]*)\s*=/, kind: "const" },
		]);
		const imports = uniqueSorted([
			...extractMatches(text, /^\s*require\s+["']([^"']+)["']/gm),
			...extractMatches(text, /^\s*require_relative\s+["']([^"']+)["']/gm).map((item) => `./${item}`),
		]);
		const exports = uniqueSorted(symbols.filter((symbol) => /^[A-Z]/.test(symbol.name)).map((symbol) => symbol.name));
		return { symbols, imports, exports };
	},
};

const fallbackExtractors: ReadonlyArray<LanguageExtractor> = [
	tsJsExtractor,
	pythonExtractor,
	goExtractor,
	rustExtractor,
	cFamilyExtractor,
	javaExtractor,
	rubyExtractor,
];

function extractorFor(language: CodewikiLanguage): LanguageExtractor | null {
	return fallbackExtractors.find((extractor) => extractor.langs.includes(language)) ?? null;
}

interface BuiltFile {
	file: CodewikiFile;
	symbols: CodewikiSymbol[];
	imports: string[];
	exports: string[];
	summary?: string;
}

function buildFile(cwd: string, relPath: string): BuiltFile | null {
	const language = languageForPath(relPath);
	if (!language) return null;
	let text: string;
	try {
		text = readFileSync(join(cwd, relPath), "utf8");
	} catch {
		return null;
	}
	const file: CodewikiFile = {
		id: stableFileId(relPath),
		path: relPath,
		lang: language,
		loc: lineCount(text),
		role: roleFor(relPath, language),
	};
	const isSource = language !== "config";
	if (!isSource || text.trim().length === 0) return { file, symbols: [], imports: [], exports: [] };
	const extracted = extractorFor(language)?.extract(relPath, text) ?? { symbols: [], imports: [], exports: [] };
	const symbols = extracted.symbols.map((symbol) => ({
		name: symbol.name,
		kind: symbol.kind,
		fileId: file.id,
		line: symbol.line,
		...(symbol.sig ? { sig: symbol.sig } : {}),
	}));
	const summary = firstDocSummary(text);
	return {
		file,
		symbols,
		imports: extracted.imports,
		exports: extracted.exports,
		...(summary ? { summary } : {}),
	};
}

function candidatePathsForImport(cwd: string, fromRel: string, specifier: string): string[] {
	const fromDir = dirname(join(cwd, fromRel));
	const cleaned = specifier.replace(/\\/g, "/");
	const base =
		cleaned.startsWith(".") || cleaned.startsWith("/")
			? resolve(fromDir, cleaned)
			: cleaned.includes("/") && !cleaned.includes("://")
				? resolve(fromDir, cleaned)
				: "";
	if (!base) return [];
	const candidates = [base];
	for (const ext of RESOLUTION_EXTENSIONS) candidates.push(`${base}${ext}`);
	for (const ext of RESOLUTION_EXTENSIONS) candidates.push(join(base, `index${ext}`));
	if (cleaned.endsWith(".js")) {
		const stripped = base.replace(/\.js$/, "");
		for (const ext of [".ts", ".tsx", ".mts", ".cts"]) candidates.push(`${stripped}${ext}`);
	}
	if (/^[.]+[A-Za-z_]/.test(cleaned)) {
		const pythonModule = cleaned.replace(/^\.+/, "").replace(/\./g, "/");
		const pythonBase = resolve(fromDir, pythonModule);
		candidates.push(`${pythonBase}.py`, join(pythonBase, "__init__.py"));
	}
	return uniqueSorted(
		candidates.map((candidate) => normalizeRel(cwd, candidate)).filter((candidate) => !candidate.startsWith("..")),
	);
}

function resolveImport(
	cwd: string,
	fromRel: string,
	specifier: string,
	pathToId: ReadonlyMap<string, string>,
): string | null {
	for (const candidate of candidatePathsForImport(cwd, fromRel, specifier)) {
		if (pathToId.has(candidate)) return pathToId.get(candidate) ?? null;
		try {
			if (statSync(join(cwd, candidate)).isFile()) return pathToId.get(candidate) ?? null;
		} catch {
			// keep trying candidates already known to the index
		}
	}
	return null;
}

function buildEdges(cwd: string, builtFiles: ReadonlyArray<BuiltFile>): CodewikiEdge[] {
	const pathToId = new Map(builtFiles.map((item) => [item.file.path, item.file.id] as const));
	const edges: CodewikiEdge[] = [];
	const seen = new Set<string>();
	for (const item of builtFiles) {
		for (const specifier of item.imports) {
			const target = resolveImport(cwd, item.file.path, specifier, pathToId);
			const edge = target
				? ({ fileId: item.file.id, toFileId: target } satisfies CodewikiInternalEdge)
				: ({ fileId: item.file.id, externalModule: specifier } satisfies CodewikiExternalEdge);
			const key = "toFileId" in edge ? `${edge.fileId}\0${edge.toFileId}` : `${edge.fileId}\0${edge.externalModule}`;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push(edge);
		}
	}
	return edges.sort(compareEdges);
}

function compareFiles(a: CodewikiFile, b: CodewikiFile): number {
	return a.path.localeCompare(b.path);
}

function compareCodewikiSymbols(a: CodewikiSymbol, b: CodewikiSymbol): number {
	const pathCmp = a.fileId.localeCompare(b.fileId);
	return pathCmp || a.line - b.line || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind);
}

function compareEdges(a: CodewikiEdge, b: CodewikiEdge): number {
	const fileCmp = a.fileId.localeCompare(b.fileId);
	if (fileCmp !== 0) return fileCmp;
	const aTarget = "toFileId" in a ? a.toFileId : `~${a.externalModule}`;
	const bTarget = "toFileId" in b ? b.toFileId : `~${b.externalModule}`;
	return aTarget.localeCompare(bTarget);
}

function promoteSingleSourceEntry(files: CodewikiFile[]): CodewikiFile[] {
	const sourceFiles = files.filter((file) => file.lang !== "config");
	if (sourceFiles.length !== 1) return files;
	const only = sourceFiles[0];
	if (!only || only.role !== "module") return files;
	return files.map((file) => (file.id === only.id ? { ...file, role: "entry" } : file));
}

function buildFromPaths(cwd: string, language: ProjectType, relPaths: ReadonlyArray<string>): Codewiki {
	const builtFiles: BuiltFile[] = [];
	for (const relPath of [...relPaths].sort(compareStrings)) {
		const built = buildFile(cwd, relPath);
		if (built) builtFiles.push(built);
	}
	const files = promoteSingleSourceEntry(builtFiles.map((item) => item.file).sort(compareFiles));
	const roleById = new Map(files.map((file) => [file.id, file.role] as const));
	const normalizedBuilt = builtFiles.map((item) => {
		const role = roleById.get(item.file.id);
		return role && role !== item.file.role ? { ...item, file: { ...item.file, role } } : item;
	});
	return {
		version: 3,
		language,
		files,
		symbols: normalizedBuilt.flatMap((item) => item.symbols).sort(compareCodewikiSymbols),
		edges: buildEdges(cwd, normalizedBuilt),
	};
}

export function buildCodewiki(input: BuildCodewikiInput): Codewiki {
	const files: string[] = [];
	walkFiles(input.cwd, input.cwd, files);
	return buildFromPaths(input.cwd, input.language, files);
}

/**
 * Apply an incremental update for a set of changed paths. The changed file
 * records and symbols are replaced in-place, and edges are rebuilt from the
 * current source tree so imports stay normalized after adds/removes.
 */
export function updateCodewikiPaths(cwd: string, codewiki: Codewiki, paths: ReadonlyArray<string>): Codewiki {
	const normalizedPaths = paths.map(normalizeInputPath).filter((path) => path.length > 0 && !path.startsWith(".."));
	if (normalizedPaths.length === 0) return codewiki;
	const existingPaths = new Set(codewiki.files.map((file) => file.path));
	let changed = false;
	for (const relPath of normalizedPaths) {
		if (existingPaths.has(relPath) || isIndexablePath(relPath)) {
			changed = true;
			break;
		}
	}
	if (!changed) return codewiki;
	const allPaths = new Set(codewiki.files.map((file) => file.path));
	for (const relPath of normalizedPaths) {
		allPaths.delete(relPath);
		if (!isIndexablePath(relPath)) continue;
		try {
			if (statSync(join(cwd, relPath)).isFile()) allPaths.add(relPath);
		} catch {
			// deleted file: already removed from the set
		}
	}
	return buildFromPaths(cwd, codewiki.language, [...allPaths]);
}

export function codewikiPath(cwd: string): string {
	return join(cwd, ".clio", "codewiki.json");
}

export function writeCodewiki(cwd: string, codewiki: Codewiki): void {
	const filePath = codewikiPath(cwd);
	mkdirSync(dirname(filePath), { recursive: true });
	const tmpPath = join(dirname(filePath), `.codewiki-${process.pid}-${randomUUID()}.tmp`);
	writeFileSync(tmpPath, `${JSON.stringify(normalizeCodewiki(codewiki), null, 2)}\n`, "utf8");
	renameSync(tmpPath, filePath);
}

export function readCodewiki(cwd: string): Codewiki | null {
	const filePath = codewikiPath(cwd);
	if (!existsSync(filePath)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
	return upgradeCodewiki(parsed);
}

export function isCodewiki(value: unknown): value is Codewiki {
	return upgradeCodewiki(value) !== null;
}

export function codewikiEntries(codewiki: Codewiki): CodewikiEntry[] {
	const fileById = new Map(codewiki.files.map((file) => [file.id, file] as const));
	const exportsByFile = new Map<string, string[]>();
	for (const symbol of codewiki.symbols) {
		const list = exportsByFile.get(symbol.fileId) ?? [];
		list.push(symbol.name);
		exportsByFile.set(symbol.fileId, list);
	}
	const importsByFile = new Map<string, string[]>();
	for (const edge of codewiki.edges) {
		const list = importsByFile.get(edge.fileId) ?? [];
		if ("toFileId" in edge) {
			const target = fileById.get(edge.toFileId);
			if (target) list.push(target.path);
		} else {
			list.push(edge.externalModule);
		}
		importsByFile.set(edge.fileId, list);
	}
	return codewiki.files
		.filter((file) => file.lang !== "config")
		.map<CodewikiEntry>((file) => ({
			path: file.path,
			exports: uniqueSorted(exportsByFile.get(file.id) ?? []),
			imports: uniqueSorted(importsByFile.get(file.id) ?? []),
			kind: file.role === "entry" ? "entry-point" : file.role === "test" ? "test" : "module",
		}))
		.sort((a, b) => a.path.localeCompare(b.path));
}

export function structuralCodewikiHash(codewiki: Codewiki): string {
	return createHash("sha256")
		.update(JSON.stringify(normalizeCodewiki(codewiki)))
		.digest("hex");
}

function normalizeCodewiki(codewiki: Codewiki): Codewiki {
	return {
		version: 3,
		language: codewiki.language,
		files: [...codewiki.files].sort(compareFiles),
		symbols: [...codewiki.symbols].sort(compareCodewikiSymbols),
		edges: [...codewiki.edges].sort(compareEdges),
	};
}

function upgradeCodewiki(value: unknown): Codewiki | null {
	if (isCodewikiV3(value)) return normalizeCodewiki(value);
	if (isCodewikiV2(value)) return upgradeV2Codewiki(value);
	return null;
}

interface CodewikiV2 {
	version: 2;
	generatedAt: string;
	language: ProjectType;
	entries: CodewikiEntry[];
}

function upgradeV2Codewiki(value: CodewikiV2): Codewiki {
	const files: CodewikiFile[] = value.entries.map((entry) => {
		const lang =
			languageForPath(entry.path) ??
			(value.language === "unknown" || value.language === "polyglot" || value.language === "dotfiles"
				? "config"
				: value.language);
		return {
			id: stableFileId(entry.path),
			path: entry.path,
			lang,
			loc: 0,
			role: entry.kind === "entry-point" ? "entry" : entry.kind === "test" ? "test" : "module",
		};
	});
	const pathToId = new Map(files.map((file) => [file.path, file.id] as const));
	const symbols: CodewikiSymbol[] = [];
	for (const entry of value.entries) {
		const fileId = pathToId.get(entry.path);
		if (!fileId) continue;
		for (const name of entry.exports) symbols.push({ name, kind: "const", fileId, line: 1 });
	}
	const edges: CodewikiEdge[] = [];
	for (const entry of value.entries) {
		const fileId = pathToId.get(entry.path);
		if (!fileId) continue;
		for (const item of entry.imports) {
			const toFileId = pathToId.get(item);
			edges.push(toFileId ? { fileId, toFileId } : { fileId, externalModule: item });
		}
	}
	return normalizeCodewiki({
		version: 3,
		language: value.language,
		files,
		symbols,
		edges,
	});
}

function isCodewikiV3(value: unknown): value is Codewiki {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	if (obj.version !== 3 || typeof obj.language !== "string") return false;
	if (!Array.isArray(obj.files) || !Array.isArray(obj.symbols) || !Array.isArray(obj.edges)) return false;
	return obj.files.every(isCodewikiFile) && obj.symbols.every(isCodewikiSymbol) && obj.edges.every(isCodewikiEdge);
}

function isCodewikiV2(value: unknown): value is CodewikiV2 {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	if (obj.version !== 2 || typeof obj.generatedAt !== "string" || typeof obj.language !== "string") return false;
	if (!Array.isArray(obj.entries)) return false;
	return obj.entries.every(isCodewikiEntry);
}

const CODEWIKI_LANGUAGES = new Set<CodewikiLanguage>([
	"typescript",
	"javascript",
	"python",
	"rust",
	"go",
	"c",
	"c++",
	"java",
	"ruby",
	"config",
]);
const FILE_ROLES = new Set<CodewikiFileRole>(["entry", "test", "module", "config"]);
const SYMBOL_KINDS = new Set<CodewikiSymbolKind>(["func", "class", "method", "type", "const", "var", "trait", "iface"]);

function isCodewikiFile(value: unknown): value is CodewikiFile {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	return (
		typeof obj.id === "string" &&
		typeof obj.path === "string" &&
		typeof obj.lang === "string" &&
		CODEWIKI_LANGUAGES.has(obj.lang as CodewikiLanguage) &&
		typeof obj.loc === "number" &&
		Number.isInteger(obj.loc) &&
		obj.loc >= 0 &&
		typeof obj.role === "string" &&
		FILE_ROLES.has(obj.role as CodewikiFileRole)
	);
}

function isCodewikiSymbol(value: unknown): value is CodewikiSymbol {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	return (
		typeof obj.name === "string" &&
		typeof obj.kind === "string" &&
		SYMBOL_KINDS.has(obj.kind as CodewikiSymbolKind) &&
		typeof obj.fileId === "string" &&
		typeof obj.line === "number" &&
		Number.isInteger(obj.line) &&
		obj.line >= 1 &&
		(!("sig" in obj) || typeof obj.sig === "string")
	);
}

function isCodewikiEdge(value: unknown): value is CodewikiEdge {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	if (typeof obj.fileId !== "string") return false;
	const hasToFile = typeof obj.toFileId === "string";
	const hasExternal = typeof obj.externalModule === "string";
	return hasToFile !== hasExternal;
}

function isCodewikiEntry(value: unknown): value is CodewikiEntry {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	if (typeof obj.path !== "string") return false;
	if (!Array.isArray(obj.exports) || obj.exports.some((item) => typeof item !== "string")) return false;
	if (!Array.isArray(obj.imports) || obj.imports.some((item) => typeof item !== "string")) return false;
	if (obj.kind !== "entry-point" && obj.kind !== "test" && obj.kind !== "module") return false;
	if ("summary" in obj && typeof obj.summary !== "string") return false;
	return true;
}
