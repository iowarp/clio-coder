import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { classifyCHeaderLanguage, isAmbiguousHeaderPath } from "../../../core/c-header-language.js";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { enumerateWorkspaceFiles, filterWorkspaceFileCandidates } from "../../../core/workspace-files.js";
import type { ProjectType, SourceProjectType } from "../../session/workspace/project-type.js";
import { EXCLUDED_DIRS } from "../excluded-dirs.js";
import { extractCMake, isCMakePath } from "./cmake.js";
import { createTreeSitterExtractor, type TreeSitterExtractor } from "./tree-sitter.js";

export type CodewikiLanguage = SourceProjectType | "config";
export type CodewikiFileRole = "entry" | "test" | "module" | "config";
export type CodewikiSymbolKind = "func" | "class" | "method" | "type" | "const" | "var" | "trait" | "iface";
const CODEWIKI_SYMBOL_KINDS_WITH_SIG = new Set<CodewikiSymbolKind>(["func", "class", "method", "type"]);

export interface CodewikiFile {
	id: string;
	path: string;
	lang: CodewikiLanguage;
	loc: number;
	role: CodewikiFileRole;
	hash: string;
	imports: string[];
	summary?: string;
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

export const CODEWIKI_VERSION = 5 as const;

export interface Codewiki {
	version: typeof CODEWIKI_VERSION;
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

export type CodewikiReadFile = (path: string) => string | null;

export interface CodewikiBuildOptions {
	readFile?: CodewikiReadFile;
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
}

export interface LanguageExtractor {
	langs: ReadonlyArray<CodewikiLanguage>;
	extractImports?(path: string, text: string): string[];
	extract(path: string, text: string): LanguageExtraction;
}

let treeSitterExtractorPromise: Promise<TreeSitterExtractor> | null = null;

function loadTreeSitterExtractor(): Promise<TreeSitterExtractor> {
	treeSitterExtractorPromise ??= createTreeSitterExtractor();
	return treeSitterExtractorPromise;
}

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
	[".cu", "c++"],
	[".cuh", "c++"],
	[".java", "java"],
	[".rb", "ruby"],
	[".cs", "c#"],
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
	".cu",
	".cuh",
	".java",
	".rb",
	".cs",
];

function compareStrings(a: string, b: string): number {
	return a.localeCompare(b);
}

function stableFileId(path: string): string {
	return `f_${createHash("sha256").update(path).digest("hex").slice(0, 16)}`;
}

function contentHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function defaultReadFile(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
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
	return CONFIG_FILE_NAMES.has(name) || name.endsWith(".csproj") || name.toLowerCase().endsWith(".cmake")
		? "config"
		: null;
}

export function isIndexablePath(relPath: string): boolean {
	if (relPath.split("/").some((segment) => EXCLUDED_DIRS.has(segment))) return false;
	return languageForPath(relPath) !== null;
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
	if (/(^|\/)(index|main|server|cli|orchestrator|bootstrap)\.[^.]+$/.test(lower) || lower.endsWith("/__main__.py")) {
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

interface CFamilyAliasStatement {
	text: string;
	masked: string;
	line: number;
}

function maskCFamilyCommentsAndStrings(text: string): string {
	// split("") preserves UTF-16 offsets so slices of the masked text line up
	// exactly with slices of the original source, including astral characters.
	const chars = text.split("");
	let state: "code" | "line-comment" | "block-comment" | "single-quote" | "double-quote" = "code";
	for (let index = 0; index < chars.length; index += 1) {
		const current = chars[index] ?? "";
		const next = chars[index + 1] ?? "";
		if (state === "code") {
			if (current === "/" && next === "/") {
				chars[index] = " ";
				chars[index + 1] = " ";
				state = "line-comment";
				index += 1;
			} else if (current === "/" && next === "*") {
				chars[index] = " ";
				chars[index + 1] = " ";
				state = "block-comment";
				index += 1;
			} else if (current === "'") {
				chars[index] = " ";
				state = "single-quote";
			} else if (current === '"') {
				chars[index] = " ";
				state = "double-quote";
			}
			continue;
		}
		if (current === "\n") {
			if (state === "line-comment") state = "code";
			continue;
		}
		chars[index] = " ";
		if (state === "block-comment" && current === "*" && next === "/") {
			chars[index + 1] = " ";
			state = "code";
			index += 1;
			continue;
		}
		if ((state === "single-quote" || state === "double-quote") && current === "\\") {
			if (index + 1 < chars.length && chars[index + 1] !== "\n") {
				chars[index + 1] = " ";
				index += 1;
			}
			continue;
		}
		if (state === "single-quote" && current === "'") state = "code";
		if (state === "double-quote" && current === '"') state = "code";
	}
	return chars.join("");
}

function cFamilyAliasStatements(text: string): CFamilyAliasStatement[] {
	const masked = maskCFamilyCommentsAndStrings(text);
	const statements: CFamilyAliasStatement[] = [];
	const token = /\b(?:typedef|using)\b/g;
	for (let match = token.exec(masked); match; match = token.exec(masked)) {
		const start = match.index;
		const lineStart = masked.lastIndexOf("\n", start - 1) + 1;
		if (masked.slice(lineStart, start).trimStart().startsWith("#")) continue;
		let braces = 0;
		let parentheses = 0;
		let brackets = 0;
		let end = -1;
		for (let index = token.lastIndex; index < masked.length; index += 1) {
			const current = masked[index];
			if (current === "{") braces += 1;
			else if (current === "}") braces = Math.max(0, braces - 1);
			else if (current === "(") parentheses += 1;
			else if (current === ")") parentheses = Math.max(0, parentheses - 1);
			else if (current === "[") brackets += 1;
			else if (current === "]") brackets = Math.max(0, brackets - 1);
			else if (current === ";" && braces === 0 && parentheses === 0 && brackets === 0) {
				end = index + 1;
				break;
			}
		}
		if (end === -1) continue;
		statements.push({
			text: text.slice(start, end),
			masked: masked.slice(start, end),
			line: 1 + Array.from(masked.slice(0, start).matchAll(/\n/g)).length,
		});
		token.lastIndex = end;
	}
	return statements;
}

function stripCFamilyBraceBodies(statement: string): string {
	let depth = 0;
	let result = "";
	for (const current of statement) {
		if (current === "{") {
			depth += 1;
			result += " ";
			continue;
		}
		if (current === "}") {
			depth = Math.max(0, depth - 1);
			result += " ";
			continue;
		}
		result += depth === 0 || current === "\n" ? current : " ";
	}
	return result;
}

function splitCFamilyDeclarators(value: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let parentheses = 0;
	let brackets = 0;
	let angles = 0;
	for (let index = 0; index < value.length; index += 1) {
		const current = value[index];
		if (current === "(") parentheses += 1;
		else if (current === ")") parentheses = Math.max(0, parentheses - 1);
		else if (current === "[") brackets += 1;
		else if (current === "]") brackets = Math.max(0, brackets - 1);
		else if (current === "<") angles += 1;
		else if (current === ">") angles = Math.max(0, angles - 1);
		else if (current === "," && parentheses === 0 && brackets === 0 && angles === 0) {
			parts.push(value.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(value.slice(start));
	return parts;
}

const C_FAMILY_TYPE_WORDS = new Set([
	"typedef",
	"const",
	"volatile",
	"restrict",
	"signed",
	"unsigned",
	"short",
	"long",
	"void",
	"char",
	"int",
	"float",
	"double",
	"struct",
	"union",
	"enum",
	"class",
	"typename",
	"auto",
]);

function stripTrailingCFamilyDeclaratorSuffixes(value: string): string {
	let end = value.length;
	while (end > 0) {
		while (end > 0 && /\s/.test(value[end - 1] ?? "")) end -= 1;
		const close = value[end - 1];
		if (close !== ")" && close !== "]") break;
		const open = close === ")" ? "(" : "[";
		let depth = 1;
		let start = end - 1;
		for (start -= 1; start >= 0; start -= 1) {
			const current = value[start];
			if (current === close) depth += 1;
			else if (current === open) {
				depth -= 1;
				if (depth === 0) break;
			}
		}
		if (start < 0) break;
		// A suffix follows an identifier, another completed declarator group, or
		// an array. A standalone `(Alias)` is a wrapper around the name itself and
		// must remain available to the identifier search below. Requiring direct
		// adjacency is what distinguishes `callable_t(...)` from `int (Wrapped)`.
		if (start === 0 || !/[A-Za-z_0-9)\]]/.test(value[start - 1] ?? "")) break;
		end = start;
	}
	return value.slice(0, end);
}

function cFamilyTypedefNames(maskedStatement: string): string[] {
	const withoutBodies = stripCFamilyBraceBodies(maskedStatement)
		.replace(/^\s*typedef\b/, "")
		.replace(/;\s*$/, "");
	const names: string[] = [];
	for (const declarator of splitCFamilyDeclarators(withoutBodies)) {
		const functionPointerNames = Array.from(
			declarator.matchAll(
				/\(\s*(?:[A-Za-z_]\w*\s+)*[*&]+\s*(?:(?:const|volatile|restrict)\s+)*([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*\)(?=\s*\()/g,
			),
			(match) => match[1] ?? "",
		).filter((name) => name.length > 0);
		if (functionPointerNames.length > 0) {
			names.push(...functionPointerNames);
			continue;
		}
		const declaratorWithoutSuffixes = stripTrailingCFamilyDeclaratorSuffixes(declarator);
		const identifiers = Array.from(declaratorWithoutSuffixes.matchAll(/\b[A-Za-z_]\w*\b/g), (match) => match[0]).filter(
			(name) => !C_FAMILY_TYPE_WORDS.has(name),
		);
		const name = identifiers.at(-1);
		if (name) names.push(name);
	}
	return uniqueSorted(names);
}

function extractCFamilyAliasSymbols(text: string): ExtractedSymbol[] {
	const symbols: ExtractedSymbol[] = [];
	const seen = new Set<string>();
	for (const statement of cFamilyAliasStatements(text)) {
		const usingName = /^\s*using\s+([A-Za-z_]\w*)\s*=/.exec(statement.masked)?.[1];
		const names = usingName
			? [usingName]
			: /^\s*typedef\b/.test(statement.masked)
				? cFamilyTypedefNames(statement.masked)
				: [];
		const signature = statement.text.replace(/\s+/g, " ").trim();
		for (const name of names) addSymbol(symbols, seen, name, "type", statement.line, signature);
	}
	return symbols;
}

const tsJsExtractor: LanguageExtractor = {
	langs: ["typescript", "javascript"],
	extractImports(_path, text) {
		return uniqueSorted([
			...extractMatches(text, /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g),
			...extractMatches(text, /\bexport\s+[^'"]*?\s+from\s+["']([^"']+)["']/g),
			...extractMatches(text, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
			...extractMatches(text, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
		]);
	},
	extract(_path, text) {
		const symbols = extractWithLineRegex(text, [
			{ regex: /^\s*export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)?/, kind: "func" },
			{ regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/, kind: "func" },
			{ regex: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/, kind: "class" },
			{ regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/, kind: "iface" },
			{ regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/, kind: "type" },
			{ regex: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/, kind: "type" },
			{ regex: /^(?:\s*export\s+)?const\s+([A-Za-z_$][\w$]*)\b/, kind: "const" },
			{ regex: /^(?:\s*export\s+)?(?:let|var)\s+([A-Za-z_$][\w$]*)\b/, kind: "var" },
			{
				regex:
					/^(?: {2,}|\t+)(?:public\s+|private\s+|protected\s+|static\s+|override\s+|abstract\s+|async\s+|get\s+|set\s+)*(?!(?:if|for|while|switch|catch|return|typeof|else|do|new|await|yield)\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{?$/,
				kind: "method",
			},
		]);
		return { symbols, imports: tsJsExtractor.extractImports?.(_path, text) ?? [] };
	},
};

const pythonExtractor: LanguageExtractor = {
	langs: ["python"],
	extractImports(_path, text) {
		return uniqueSorted([
			...extractMatches(text, /^\s*import\s+([A-Za-z_][\w.]*)(?:\s+as\s+\w+)?/gm),
			...extractMatches(text, /^\s*from\s+([.\w]+)\s+import\s+/gm),
		]);
	},
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
		return { symbols: symbols.sort(compareSymbols), imports: pythonExtractor.extractImports?.(_path, text) ?? [] };
	},
};

const goExtractor: LanguageExtractor = {
	langs: ["go"],
	extractImports(_path, text) {
		return uniqueSorted([
			...extractMatches(text, /^\s*import\s+"([^"]+)"/gm),
			...extractMatches(text, /^\s*"([^"]+)"\s*$/gm),
		]);
	},
	extract(_path, text) {
		const rawSymbols = extractWithLineRegex(text, [
			{ regex: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/, kind: "func" },
			{ regex: /^\s*type\s+([A-Za-z_]\w*)\s+interface\b/, kind: "iface" },
			{ regex: /^\s*type\s+([A-Za-z_]\w*)\s+struct\b/, kind: "type" },
			{ regex: /^\s*type\s+([A-Za-z_]\w*)\b/, kind: "type" },
			{ regex: /^const\s+([A-Za-z_]\w*)\b/, kind: "const" },
			{ regex: /^var\s+([A-Za-z_]\w*)\b/, kind: "var" },
		]);
		const symbols: ExtractedSymbol[] = rawSymbols.map((symbol) => {
			if (symbol.kind === "func" && /^\s*func\s+\(/.test(symbol.sig ?? "")) return { ...symbol, kind: "method" };
			return symbol;
		});
		return { symbols: symbols.sort(compareSymbols), imports: goExtractor.extractImports?.(_path, text) ?? [] };
	},
};

const rustExtractor: LanguageExtractor = {
	langs: ["rust"],
	extractImports(_path, text) {
		return uniqueSorted([
			...extractMatches(text, /^\s*use\s+([^;]+);/gm).map((item) => item.trim()),
			...extractMatches(text, /^\s*extern\s+crate\s+([A-Za-z_]\w*)/gm),
		]);
	},
	extract(_path, text) {
		const symbols = extractWithLineRegex(text, [
			{ regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?fn\s+([A-Za-z_]\w*)\s*[<(]/, kind: "func" },
			{ regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)\b/, kind: "type" },
			{ regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)\b/, kind: "type" },
			{ regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)\b/, kind: "trait" },
			{ regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)\b/, kind: "type" },
			{ regex: /^(?:\s*pub(?:\([^)]*\))?\s+)?const\s+([A-Za-z_]\w*)\b/, kind: "const" },
			{ regex: /^(?:\s*pub(?:\([^)]*\))?\s+)?static\s+([A-Za-z_]\w*)\b/, kind: "var" },
		]);
		return { symbols, imports: rustExtractor.extractImports?.(_path, text) ?? [] };
	},
};

const cFamilyExtractor: LanguageExtractor = {
	langs: ["c", "c++"],
	extractImports(_path, text) {
		const imports: string[] = [];
		for (const match of text.matchAll(/^\s*#\s*include\s*(?:"([^"]+)"|<([^>]+)>)/gm)) {
			const quoted = match[1];
			const system = match[2];
			if (quoted) imports.push(quoted.startsWith(".") || quoted.startsWith("/") ? quoted : `./${quoted}`);
			else if (system) imports.push(system);
		}
		return uniqueSorted(imports);
	},
	extract(_path, text) {
		const regexSymbols = extractWithLineRegex(text, [
			{ regex: /^\s*class\s+([A-Za-z_]\w*)\b/, kind: "class" },
			{
				regex: /^\s*(?:typedef\s+)?(?:struct\s+|union\s+|enum\s+(?:(?:class|struct)\s+)?)([A-Za-z_]\w*)\b/,
				kind: "type",
			},
			{
				regex:
					/^\s*(?!(?:typedef|using)\b)(?:template\s*<[^>]+>\s*)?(?:[A-Za-z_][\w:<>,*&\s]+\s+)+(?:(?:[A-Za-z_]\w*)::)*([~A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:;|\{)?$/,
				kind: "func",
			},
			{ regex: /^(?:const\s+)?[A-Za-z_][\w:<>,*&\s]+\s+([A-Z][A-Z0-9_]*)\s*=/, kind: "const" },
		]);
		const symbolsByKey = new Map<string, ExtractedSymbol>();
		for (const symbol of [...regexSymbols, ...extractCFamilyAliasSymbols(text)]) {
			const key = `${symbol.name}\0${symbol.kind}\0${symbol.line}`;
			if (!symbolsByKey.has(key)) symbolsByKey.set(key, symbol);
		}
		const symbols = [...symbolsByKey.values()].sort(compareSymbols);
		return { symbols, imports: cFamilyExtractor.extractImports?.(_path, text) ?? [] };
	},
};

const javaExtractor: LanguageExtractor = {
	langs: ["java"],
	extractImports(_path, text) {
		return uniqueSorted(extractMatches(text, /^\s*import\s+(?:static\s+)?([A-Za-z_][\w.*]*);/gm));
	},
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
				regex: /^\s*public\s+(?:static\s+|final\s+)*[A-Za-z_][\w<>,[\]\s]*\s+([A-Z][A-Z0-9_]*)\s*=/,
				kind: "const",
			},
		]);
		return { symbols, imports: javaExtractor.extractImports?.(_path, text) ?? [] };
	},
};

const rubyExtractor: LanguageExtractor = {
	langs: ["ruby"],
	extractImports(_path, text) {
		return uniqueSorted([
			...extractMatches(text, /^\s*require\s+["']([^"']+)["']/gm),
			...extractMatches(text, /^\s*require_relative\s+["']([^"']+)["']/gm).map((item) => `./${item}`),
		]);
	},
	extract(_path, text) {
		const symbols = extractWithLineRegex(text, [
			{ regex: /^\s*class\s+([A-Z]\w*(?:::[A-Z]\w*)*)\b/, kind: "class" },
			{ regex: /^\s*module\s+([A-Z]\w*(?:::[A-Z]\w*)*)\b/, kind: "type" },
			{ regex: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)\b/, kind: "func" },
			{ regex: /^([A-Z][A-Z0-9_]*)\s*=/, kind: "const" },
		]);
		return { symbols, imports: rubyExtractor.extractImports?.(_path, text) ?? [] };
	},
};

const csharpExtractor: LanguageExtractor = {
	langs: ["c#"],
	extractImports(_path, text) {
		// Mirrors the tree-sitter using-directive handling: static prefixes are
		// stripped and alias directives resolve to their right-hand side.
		return uniqueSorted(
			extractMatches(text, /^\s*using\s+(?:static\s+)?(?:[A-Za-z_]\w*\s*=\s*)?([A-Za-z_][\w.]*)\s*;/gm),
		);
	},
	extract(_path, text) {
		const symbols = extractWithLineRegex(text, [
			{
				regex:
					/^\s*(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|sealed\s+|abstract\s+|partial\s+)*class\s+([A-Za-z_]\w*)\b/,
				kind: "class",
			},
			{
				regex: /^\s*(?:public\s+|private\s+|protected\s+|internal\s+|partial\s+)*interface\s+([A-Za-z_]\w*)\b/,
				kind: "iface",
			},
			{
				regex:
					/^\s*(?:public\s+|private\s+|protected\s+|internal\s+|readonly\s+|partial\s+)*(?:enum|struct|record)\s+([A-Za-z_]\w*)\b/,
				kind: "type",
			},
			{
				regex:
					/^\s*(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|virtual\s+|override\s+|abstract\s+|sealed\s+|async\s+|partial\s+|new\s+)*(?!(?:if|for|foreach|while|switch|catch|return|using|else|do|new|class|interface|enum|struct|record|namespace|lock|throw)\b)[A-Za-z_][\w<>,[\].?\s]*\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\{?$/,
				kind: "method",
			},
			{
				regex:
					/^\s*(?:public\s+|private\s+|protected\s+|internal\s+|static\s+)*const\s+[A-Za-z_][\w<>,[\]\s]*\s+([A-Za-z_]\w*)\s*=/,
				kind: "const",
			},
		]);
		return { symbols, imports: csharpExtractor.extractImports?.(_path, text) ?? [] };
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
	csharpExtractor,
];

function extractWithExtractors(
	extractors: ReadonlyArray<LanguageExtractor>,
	language: CodewikiLanguage,
	relPath: string,
	text: string,
): LanguageExtraction {
	const symbols = new Map<string, ExtractedSymbol>();
	const imports: string[] = [];
	for (const extractor of extractors) {
		if (!extractor.langs.includes(language)) continue;
		const extracted = extractor.extract(relPath, text);
		for (const symbol of extracted.symbols) {
			const key = `${symbol.name}\0${symbol.kind}\0${symbol.line}`;
			if (!symbols.has(key)) symbols.set(key, symbol);
		}
		imports.push(...extracted.imports);
	}
	return {
		symbols: [...symbols.values()].sort(compareSymbols),
		imports: uniqueSorted(imports),
	};
}

function extractImportsWithExtractors(
	extractors: ReadonlyArray<LanguageExtractor>,
	language: CodewikiLanguage,
	relPath: string,
	text: string,
): string[] {
	const imports: string[] = [];
	for (const extractor of extractors) {
		if (!extractor.langs.includes(language) || !extractor.extractImports) continue;
		imports.push(...extractor.extractImports(relPath, text));
	}
	return uniqueSorted(imports);
}

interface BuiltFile {
	file: CodewikiFile;
	symbols: CodewikiSymbol[];
}

function mergeTreeSitterWithRegexImports(
	language: CodewikiLanguage,
	relPath: string,
	text: string,
	extracted: LanguageExtraction,
): LanguageExtraction {
	const regexImports = extractImportsWithExtractors(fallbackExtractors, language, relPath, text);
	return {
		symbols: extracted.symbols.sort(compareSymbols),
		imports: uniqueSorted([...extracted.imports, ...regexImports]),
	};
}

export function fallbackExtraction(language: CodewikiLanguage, relPath: string, text: string): LanguageExtraction {
	return extractWithExtractors(fallbackExtractors, language, relPath, text);
}

function extractSourceFile(
	language: CodewikiLanguage,
	relPath: string,
	text: string,
	treeSitterExtractor: LanguageExtractor,
): LanguageExtraction {
	if (!treeSitterExtractor.langs.includes(language)) return fallbackExtraction(language, relPath, text);
	try {
		return mergeTreeSitterWithRegexImports(language, relPath, text, treeSitterExtractor.extract(relPath, text));
	} catch {
		return fallbackExtraction(language, relPath, text);
	}
}

function buildFile(
	cwd: string,
	relPath: string,
	treeSitterExtractor: LanguageExtractor,
	readFile: CodewikiReadFile,
): BuiltFile | null {
	const pathLanguage = languageForPath(relPath);
	if (!pathLanguage) return null;
	let text: string | null;
	try {
		text = readFile(join(cwd, relPath));
	} catch {
		return null;
	}
	if (text === null) return null;
	// Ambiguous `.h` headers classify from content so both full builds and
	// incremental updates land on the same C/C++ decision.
	const language = pathLanguage === "c" && isAmbiguousHeaderPath(relPath) ? classifyCHeaderLanguage(text) : pathLanguage;
	const file: CodewikiFile = {
		id: stableFileId(relPath),
		path: relPath,
		lang: language,
		loc: lineCount(text),
		role: roleFor(relPath, language),
		hash: contentHash(text),
		imports: [],
	};
	if (text.trim().length === 0) return { file, symbols: [] };
	const extracted = isCMakePath(relPath)
		? extractCMake(text)
		: language !== "config"
			? extractSourceFile(language, relPath, text, treeSitterExtractor)
			: null;
	if (!extracted) return { file, symbols: [] };
	const summary = firstDocSummary(text);
	const sourceFile: CodewikiFile = {
		...file,
		imports: extracted.imports,
		...(summary ? { summary } : {}),
	};
	const symbols = extracted.symbols.map((symbol) => ({
		name: symbol.name,
		kind: symbol.kind,
		fileId: sourceFile.id,
		line: symbol.line,
		...symbolSigFields(symbol.kind, symbol.sig),
	}));
	return {
		file: sourceFile,
		symbols,
	};
}

function candidatePathsForImport(cwd: string, fromRel: string, specifier: string): string[] {
	const fromDir = dirname(join(cwd, fromRel));
	const cleaned = specifier.replace(/\\/g, "/");
	const base = cleaned.startsWith(".") || cleaned.startsWith("/") ? resolve(fromDir, cleaned) : "";
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

function buildEdges(cwd: string, files: ReadonlyArray<CodewikiFile>): CodewikiEdge[] {
	const pathToId = new Map(files.map((file) => [file.path, file.id] as const));
	const edges: CodewikiEdge[] = [];
	const seen = new Set<string>();
	for (const file of files) {
		for (const specifier of file.imports) {
			const target = resolveImport(cwd, file.path, specifier, pathToId);
			const edge = target
				? ({ fileId: file.id, toFileId: target } satisfies CodewikiInternalEdge)
				: ({ fileId: file.id, externalModule: specifier } satisfies CodewikiExternalEdge);
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
	if (only?.role !== "module") return files;
	return files.map((file) => (file.id === only.id ? { ...file, role: "entry" } : file));
}

function codewikiFromBuiltFiles(cwd: string, language: ProjectType, builtFiles: ReadonlyArray<BuiltFile>): Codewiki {
	const baseBuiltFiles = builtFiles.map((item) => ({
		...item,
		file: { ...item.file, role: roleFor(item.file.path, item.file.lang) },
	}));
	const files = promoteSingleSourceEntry(baseBuiltFiles.map((item) => item.file).sort(compareFiles));
	const roleById = new Map(files.map((file) => [file.id, file.role] as const));
	const normalizedBuilt = baseBuiltFiles.map((item) => {
		const role = roleById.get(item.file.id);
		return role && role !== item.file.role ? { ...item, file: { ...item.file, role } } : item;
	});
	const normalizedFiles = normalizedBuilt.map((item) => item.file).sort(compareFiles);
	return {
		version: CODEWIKI_VERSION,
		language,
		files: normalizedFiles,
		symbols: normalizedBuilt.flatMap((item) => item.symbols).sort(compareCodewikiSymbols),
		edges: buildEdges(cwd, normalizedFiles),
	};
}

async function buildFromPaths(
	cwd: string,
	language: ProjectType,
	relPaths: ReadonlyArray<string>,
	options: CodewikiBuildOptions = {},
): Promise<Codewiki> {
	const sortedPaths = [...relPaths].sort(compareStrings);
	const treeSitterExtractor = await loadTreeSitterExtractor();
	await treeSitterExtractor.ensureGrammarsForPaths(sortedPaths);
	const readFile = options.readFile ?? defaultReadFile;
	const builtFiles: BuiltFile[] = [];
	for (const relPath of sortedPaths) {
		const built = buildFile(cwd, relPath, treeSitterExtractor, readFile);
		if (built) builtFiles.push(built);
	}
	return codewikiFromBuiltFiles(cwd, language, builtFiles);
}

export async function buildCodewiki(input: BuildCodewikiInput, options: CodewikiBuildOptions = {}): Promise<Codewiki> {
	const files = enumerateWorkspaceFiles(input.cwd, EXCLUDED_DIRS).filter(isIndexablePath);
	return buildFromPaths(input.cwd, input.language, files, options);
}

/**
 * Apply an incremental update for a set of changed paths. The changed file
 * records and symbols are replaced in-place, and edges are rebuilt from stored
 * imports across the merged file set.
 */
export async function updateCodewikiPaths(
	cwd: string,
	codewiki: Codewiki,
	paths: ReadonlyArray<string>,
	options: CodewikiBuildOptions = {},
): Promise<Codewiki> {
	const normalizedPaths = uniqueSorted(
		paths.map(normalizeInputPath).filter((path) => path.length > 0 && !path.startsWith("..")),
	);
	if (normalizedPaths.length === 0) return codewiki;
	if (
		normalizedPaths.some(
			(path) =>
				path === ".gitignore" ||
				path.endsWith("/.gitignore") ||
				path === ".git/info/exclude" ||
				path === ".git/index" ||
				path === ".gitmodules",
		)
	) {
		// Ignore and index metadata can add or remove paths that are not present in
		// the mutation batch itself. Re-enumerate once so incremental visibility
		// remains byte-equivalent to a full build.
		return buildCodewiki({ cwd, language: codewiki.language }, options);
	}
	const existingPaths = new Set(codewiki.files.map((file) => file.path));
	const visiblePaths = new Set(filterWorkspaceFileCandidates(cwd, normalizedPaths, EXCLUDED_DIRS));
	const readFile = options.readFile ?? defaultReadFile;
	const changedPathSet = new Set(normalizedPaths);
	const rebuildPaths: string[] = [];
	let hasIndexChange = false;
	for (const relPath of normalizedPaths) {
		const wasIndexed = existingPaths.has(relPath);
		const isCurrentIndexableFile = isIndexablePath(relPath) && visiblePaths.has(relPath);
		if (!wasIndexed && !isCurrentIndexableFile) continue;
		hasIndexChange = true;
		if (isCurrentIndexableFile) rebuildPaths.push(relPath);
	}
	if (!hasIndexChange) return codewiki;
	const rebuiltFiles: BuiltFile[] = [];
	if (rebuildPaths.length > 0) {
		const treeSitterExtractor = await loadTreeSitterExtractor();
		await treeSitterExtractor.ensureGrammarsForPaths(rebuildPaths);
		for (const relPath of rebuildPaths) {
			const built = buildFile(cwd, relPath, treeSitterExtractor, readFile);
			if (built) rebuiltFiles.push(built);
		}
	}
	const removedFileIds = new Set(codewiki.files.filter((file) => changedPathSet.has(file.path)).map((file) => file.id));
	const symbolsByFileId = new Map<string, CodewikiSymbol[]>();
	for (const symbol of codewiki.symbols) {
		if (removedFileIds.has(symbol.fileId)) continue;
		const symbols = symbolsByFileId.get(symbol.fileId) ?? [];
		symbols.push(symbol);
		symbolsByFileId.set(symbol.fileId, symbols);
	}
	const keptFiles: BuiltFile[] = codewiki.files
		.filter((file) => !changedPathSet.has(file.path))
		.map((file) => ({ file, symbols: symbolsByFileId.get(file.id) ?? [] }));
	return codewikiFromBuiltFiles(cwd, codewiki.language, [...keptFiles, ...rebuiltFiles]);
}

/**
 * Reconcile an existing index with the current workspace without parsing
 * unchanged files. The scan reads and hashes candidate files, then delegates
 * extraction to the incremental updater only for additions, removals, and
 * content changes. Callers can still use buildCodewiki when the artifact is
 * missing or structurally incompatible.
 */
export async function syncCodewiki(
	cwd: string,
	codewiki: Codewiki,
	options: CodewikiBuildOptions = {},
): Promise<Codewiki> {
	const readFile = options.readFile ?? defaultReadFile;
	const currentPaths = enumerateWorkspaceFiles(cwd, EXCLUDED_DIRS).filter(isIndexablePath);
	const currentFiles = new Map<string, string>();
	for (const relPath of currentPaths) {
		const text = readFile(join(cwd, relPath));
		if (text !== null) currentFiles.set(relPath, contentHash(text));
	}
	const indexedFiles = new Map(codewiki.files.map((file) => [file.path, file] as const));
	const changedPaths = new Set<string>();
	for (const [relPath, hash] of currentFiles) {
		if (indexedFiles.get(relPath)?.hash !== hash) changedPaths.add(relPath);
	}
	for (const relPath of indexedFiles.keys()) {
		if (!currentFiles.has(relPath)) changedPaths.add(relPath);
	}
	if (changedPaths.size === 0) return codewiki;
	return updateCodewikiPaths(cwd, codewiki, [...changedPaths], options);
}

export function codewikiPath(cwd: string): string {
	return join(cwd, ".clio", "codewiki.json");
}

export function serializeCodewiki(codewiki: Codewiki): string {
	return `${JSON.stringify(normalizeCodewiki(codewiki))}\n`;
}

export function writeCodewiki(cwd: string, codewiki: Codewiki): string {
	const serialized = serializeCodewiki(codewiki);
	safeResourceWrite(codewikiPath(cwd), serialized, {
		encoding: "utf8",
	});
	return serialized;
}

export function parseCodewikiRaw(raw: string): Codewiki | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	return upgradeCodewiki(parsed);
}

export function readCodewikiRaw(cwd: string): { raw: string; codewiki: Codewiki } | null {
	const filePath = codewikiPath(cwd);
	if (!existsSync(filePath)) return null;
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
	const codewiki = parseCodewikiRaw(raw);
	return codewiki ? { raw, codewiki } : null;
}

export function readCodewiki(cwd: string): Codewiki | null {
	return readCodewikiRaw(cwd)?.codewiki ?? null;
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
			...(file.summary ? { summary: file.summary } : {}),
		}))
		.sort((a, b) => a.path.localeCompare(b.path));
}

export function codewikiNeedsBackfill(codewiki: Codewiki): boolean {
	return codewiki.files.some((file) => file.lang !== "config" && file.hash.length === 0);
}

export function structuralCodewikiHash(codewiki: Codewiki): string {
	return createHash("sha256")
		.update(JSON.stringify(normalizeCodewiki(codewiki)))
		.digest("hex");
}

function normalizeCodewikiFile(file: CodewikiFile): CodewikiFile {
	return {
		id: file.id,
		path: file.path,
		lang: file.lang,
		loc: file.loc,
		role: file.role,
		hash: file.hash,
		imports: uniqueSorted(file.imports),
		...(file.summary ? { summary: file.summary } : {}),
	};
}

function symbolSigFields(kind: CodewikiSymbolKind, sig: string | undefined): Pick<CodewikiSymbol, "sig"> {
	if (!CODEWIKI_SYMBOL_KINDS_WITH_SIG.has(kind)) return {};
	const clean = sig?.trim().slice(0, 240);
	return clean && clean.length > 0 ? { sig: clean } : {};
}

function normalizeCodewikiSymbol(symbol: CodewikiSymbol): CodewikiSymbol {
	return {
		name: symbol.name,
		kind: symbol.kind,
		fileId: symbol.fileId,
		line: symbol.line,
		...symbolSigFields(symbol.kind, symbol.sig),
	};
}

function normalizeCodewiki(codewiki: Codewiki): Codewiki {
	return {
		version: CODEWIKI_VERSION,
		language: codewiki.language,
		files: codewiki.files.map(normalizeCodewikiFile).sort(compareFiles),
		symbols: codewiki.symbols.map(normalizeCodewikiSymbol).sort(compareCodewikiSymbols),
		edges: [...codewiki.edges].sort(compareEdges),
	};
}

function upgradeCodewiki(value: unknown): Codewiki | null {
	if (isCodewikiV5(value)) return normalizeCodewiki(value);
	if (isCodewikiV4(value)) return upgradeV4Codewiki(value);
	if (isCodewikiV3(value)) return upgradeV3Codewiki(value);
	if (isCodewikiV2(value)) return upgradeV2Codewiki(value);
	return null;
}

interface CodewikiFileV3 {
	id: string;
	path: string;
	lang: CodewikiLanguage;
	loc: number;
	role: CodewikiFileRole;
}

interface CodewikiV3 {
	version: 3;
	language: ProjectType;
	files: CodewikiFileV3[];
	symbols: CodewikiSymbol[];
	edges: CodewikiEdge[];
}

interface CodewikiV4 {
	version: 4;
	language: ProjectType;
	files: CodewikiFile[];
	symbols: CodewikiSymbol[];
	edges: CodewikiEdge[];
}

interface CodewikiV2 {
	version: 2;
	generatedAt: string;
	language: ProjectType;
	entries: CodewikiEntry[];
}

function upgradeV3Codewiki(value: CodewikiV3): Codewiki {
	return normalizeCodewiki({
		version: CODEWIKI_VERSION,
		language: value.language,
		files: value.files.map((file) => ({
			...file,
			hash: "",
			imports: [],
		})),
		symbols: value.symbols,
		edges: value.edges,
	});
}

function upgradeV4Codewiki(value: CodewikiV4): Codewiki {
	return normalizeCodewiki({
		version: CODEWIKI_VERSION,
		language: value.language,
		// v5 changes C-family extraction and adds CUDA paths. Blank hashes force
		// one complete rebuild instead of treating a structurally obsolete v4
		// artifact as fresh.
		files: value.files.map((file) => ({ ...file, hash: "" })),
		symbols: value.symbols,
		edges: value.edges,
	});
}

function upgradeV2Codewiki(value: CodewikiV2): Codewiki {
	const files: CodewikiFileV3[] = value.entries.map((entry) => {
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
	return upgradeV3Codewiki({
		version: 3,
		language: value.language,
		files,
		symbols,
		edges,
	});
}

function isNormalizedRelativeCodewikiPath(path: string): boolean {
	if (path.length === 0 || path.includes("\0") || path.includes("\\") || path.startsWith("/")) return false;
	if (/^[A-Za-z]:\//.test(path)) return false;
	const segments = path.split("/");
	return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function hasValidNativeV5Semantics(value: Codewiki): boolean {
	const fileIds = new Set<string>();
	const filePaths = new Set<string>();
	const locByFileId = new Map<string, number>();
	for (const file of value.files) {
		if (fileIds.has(file.id) || filePaths.has(file.path)) return false;
		if (!isNormalizedRelativeCodewikiPath(file.path) || !/^[0-9a-f]{16}$/.test(file.hash)) return false;
		fileIds.add(file.id);
		filePaths.add(file.path);
		locByFileId.set(file.id, file.loc);
	}
	for (const symbol of value.symbols) {
		const loc = locByFileId.get(symbol.fileId);
		if (loc === undefined || symbol.line > loc) return false;
	}
	for (const edge of value.edges) {
		if (!fileIds.has(edge.fileId)) return false;
		if ("toFileId" in edge && !fileIds.has(edge.toFileId)) return false;
	}
	return true;
}

function isCodewikiV5(value: unknown): value is Codewiki {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	if (obj.version !== CODEWIKI_VERSION || typeof obj.language !== "string") return false;
	if (!Array.isArray(obj.files) || !Array.isArray(obj.symbols) || !Array.isArray(obj.edges)) return false;
	if (!obj.files.every(isCodewikiFile) || !obj.symbols.every(isCodewikiSymbol) || !obj.edges.every(isCodewikiEdge)) {
		return false;
	}
	return hasValidNativeV5Semantics(obj as unknown as Codewiki);
}

function isCodewikiV4(value: unknown): value is CodewikiV4 {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	if (obj.version !== 4 || typeof obj.language !== "string") return false;
	if (!Array.isArray(obj.files) || !Array.isArray(obj.symbols) || !Array.isArray(obj.edges)) return false;
	return obj.files.every(isCodewikiFile) && obj.symbols.every(isCodewikiSymbol) && obj.edges.every(isCodewikiEdge);
}

function isCodewikiV3(value: unknown): value is CodewikiV3 {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	if (obj.version !== 3 || typeof obj.language !== "string") return false;
	if (!Array.isArray(obj.files) || !Array.isArray(obj.symbols) || !Array.isArray(obj.edges)) return false;
	return obj.files.every(isCodewikiFileV3) && obj.symbols.every(isCodewikiSymbol) && obj.edges.every(isCodewikiEdge);
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
	"c#",
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
		FILE_ROLES.has(obj.role as CodewikiFileRole) &&
		typeof obj.hash === "string" &&
		Array.isArray(obj.imports) &&
		obj.imports.every((item) => typeof item === "string") &&
		(!("summary" in obj) || typeof obj.summary === "string")
	);
}

function isCodewikiFileV3(value: unknown): value is CodewikiFileV3 {
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
