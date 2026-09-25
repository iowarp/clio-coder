import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { classifyCHeaderLanguage, isAmbiguousHeaderPath } from "../../../core/c-header-language.js";
import { enumerateWorkspaceFilesAsync, filterWorkspaceFileCandidates } from "../../../core/workspace-files.js";
import type { ProjectType } from "../../session/workspace/project-type.js";
import { EXCLUDED_DIRS } from "../excluded-dirs.js";
import { extractCMake, isCMakePath } from "./cmake.js";
import { type CooperativeSlicer, createSlicer } from "./cooperative.js";
import { isIndexablePath, languageForPath } from "./paths.js";
import {
	type BuildCodewikiInput,
	CODEWIKI_VERSION,
	type Codewiki,
	type CodewikiEdge,
	type CodewikiExternalEdge,
	type CodewikiFile,
	type CodewikiFileRole,
	type CodewikiInternalEdge,
	type CodewikiLanguage,
	type CodewikiReadFile,
	type CodewikiSymbol,
	type CodewikiSymbolKind,
	type ExtractedSymbol,
	type LanguageExtraction,
	type LanguageExtractor,
} from "./schema.js";
import type { TreeSitterExtractor } from "./tree-sitter.js";

export {
	type BuildCodewikiInput,
	CODEWIKI_VERSION,
	type Codewiki,
	type CodewikiEdge,
	type CodewikiEntry,
	type CodewikiExternalEdge,
	type CodewikiFile,
	type CodewikiFileRole,
	type CodewikiInternalEdge,
	type CodewikiLanguage,
	type CodewikiReadFile,
	type CodewikiSymbol,
	type CodewikiSymbolKind,
	type ExtractedSymbol,
	type LanguageExtraction,
	type LanguageExtractor,
} from "./schema.js";

const CODEWIKI_SYMBOL_KINDS_WITH_SIG = new Set<CodewikiSymbolKind>(["func", "class", "method", "type"]);

export interface CodewikiBuildOptions {
	readFile?: CodewikiReadFile;
	/**
	 * Slice budget shared across a whole index run. Callers that chain several
	 * phases pass one slicer so the budget applies end to end rather than
	 * resetting at each phase boundary. Defaults to a fresh slicer.
	 */
	slicer?: CooperativeSlicer;
}

let treeSitterExtractorPromise: Promise<TreeSitterExtractor> | null = null;

function loadTreeSitterExtractor(): Promise<TreeSitterExtractor> {
	treeSitterExtractorPromise ??= import("./tree-sitter.js").then(({ createTreeSitterExtractor }) =>
		createTreeSitterExtractor(),
	);
	return treeSitterExtractorPromise;
}

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

function normalizeRel(cwd: string, filePath: string): string {
	return relative(cwd, filePath).split("\\").join("/");
}

function normalizeInputPath(path: string): string {
	return path.split("\\").join("/").replace(/^\.\//, "");
}

export { isIndexablePath } from "./paths.js";

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

function fallbackExtraction(language: CodewikiLanguage, relPath: string, text: string): LanguageExtraction {
	return extractWithExtractors(fallbackExtractors, language, relPath, text);
}

/**
 * Largest source text handed to tree-sitter. The cooperative slicer yields
 * between files, never inside one, so a single parse is the longest stretch the
 * event loop can be held for; measured on this machine that is roughly 0.5 ms
 * per KiB of ordinary source and 2 to 3 ms per KiB of a minified bundle, which
 * made one 9 MiB vendored bundle a 25 s freeze that no shutdown budget could
 * interrupt (issue #99). Nothing hand-written is this big; anything above the
 * cap is generated or vendored, and the regex extractor covers it in tens of
 * milliseconds. Under the cap one parse of ordinary source is a few hundred
 * milliseconds at most; a minified file right at the cap can still take about a
 * second, which is bounded, and the loop gets its turn at the next file.
 */
export const MAX_TREE_SITTER_SOURCE_CHARS = 512 * 1024;

function extractSourceFile(
	language: CodewikiLanguage,
	relPath: string,
	text: string,
	treeSitterExtractor: LanguageExtractor,
): LanguageExtraction {
	if (!treeSitterExtractor.langs.includes(language)) return fallbackExtraction(language, relPath, text);
	if (text.length > MAX_TREE_SITTER_SOURCE_CHARS) return fallbackExtraction(language, relPath, text);
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
	return uniqueSorted(
		candidates.map((candidate) => normalizeRel(cwd, candidate)).filter((candidate) => !candidate.startsWith("..")),
	);
}

/**
 * Per-run memo for import resolution.
 *
 * A candidate list depends only on the importing file's directory and the
 * specifier, and a candidate's on-disk status cannot change while a single edge
 * rebuild is in flight, so both collapse to a map lookup after the first miss.
 * Uncached, one rebuild of a 1100-file TypeScript repo issued roughly 80 000
 * `statSync` calls, most of them for paths that do not exist, and spent about
 * four seconds doing it.
 */
function createImportResolver(cwd: string): {
	resolve(fromRel: string, specifier: string, pathToId: ReadonlyMap<string, string>): string | null;
} {
	const candidatesByOrigin = new Map<string, string[]>();
	const onDisk = new Map<string, boolean>();
	const candidatesFor = (fromRel: string, specifier: string): string[] => {
		// The candidate set is a function of the directory, not the file: every
		// sibling importing the same specifier resolves through the same list.
		const python = /\.pyw?$/.test(fromRel);
		const key = `${python}\0${dirname(fromRel)}\0${specifier}`;
		let candidates = candidatesByOrigin.get(key);
		if (!candidates) {
			if (python) {
				const fromDir = dirname(fromRel);
				let packageRoot = fromDir;
				while (packageRoot !== "." && isFile(join(packageRoot, "__init__.py"))) {
					packageRoot = dirname(packageRoot);
				}
				const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
				const modulePath = specifier.slice(dots).replace(/\./g, "/");
				let bases: string[];
				if (dots > 0) {
					const parent = resolve(cwd, fromDir, ...Array<string>(dots - 1).fill(".."));
					// A relative import must stay inside its package tree. Without
					// __init__.py evidence, the workspace bounds namespace packages.
					const root = resolve(cwd, packageRoot === fromDir ? "." : packageRoot);
					const insidePackage = parent !== root || (root === resolve(cwd) && isFile("__init__.py"));
					bases = insidePackage && !relative(root, parent).startsWith("..") ? [join(parent, modulePath)] : [];
				} else {
					bases = [resolve(cwd, modulePath)];
					if (packageRoot !== fromDir && packageRoot !== ".") bases.push(resolve(cwd, packageRoot, modulePath));
				}
				candidates = [...new Set(bases.flatMap((base) => [join(base, "__init__.py"), `${base}.py`]))].map((candidate) =>
					normalizeRel(cwd, candidate),
				);
			} else {
				candidates = candidatePathsForImport(cwd, fromRel, specifier);
			}
			candidatesByOrigin.set(key, candidates);
		}
		return candidates;
	};
	const isFile = (candidate: string): boolean => {
		const cached = onDisk.get(candidate);
		if (cached !== undefined) return cached;
		let exists: boolean;
		try {
			exists = statSync(join(cwd, candidate)).isFile();
		} catch {
			exists = false;
		}
		onDisk.set(candidate, exists);
		return exists;
	};
	return {
		resolve(fromRel, specifier, pathToId): string | null {
			for (const candidate of candidatesFor(fromRel, specifier)) {
				if (pathToId.has(candidate)) return pathToId.get(candidate) ?? null;
				// An unindexed file that exists still claims the specifier: it shadows
				// any later candidate, and having no id makes the edge external.
				if (isFile(candidate)) return null;
			}
			return null;
		},
	};
}

async function buildEdges(
	cwd: string,
	files: ReadonlyArray<CodewikiFile>,
	slicer: CooperativeSlicer,
): Promise<CodewikiEdge[]> {
	const pathToId = new Map(files.map((file) => [file.path, file.id] as const));
	const resolver = createImportResolver(cwd);
	const edges: CodewikiEdge[] = [];
	const seen = new Set<string>();
	for (const file of files) {
		for (const specifier of file.imports) {
			await slicer.tick();
			const target = resolver.resolve(file.path, specifier, pathToId);
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

async function codewikiFromBuiltFiles(
	cwd: string,
	language: ProjectType,
	builtFiles: ReadonlyArray<BuiltFile>,
	slicer: CooperativeSlicer,
): Promise<Codewiki> {
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
		edges: await buildEdges(cwd, normalizedFiles, slicer),
	};
}

async function buildFromPaths(
	cwd: string,
	language: ProjectType,
	relPaths: ReadonlyArray<string>,
	options: CodewikiBuildOptions = {},
): Promise<Codewiki> {
	const slicer = options.slicer ?? createSlicer();
	const sortedPaths = [...relPaths].sort(compareStrings);
	const treeSitterExtractor = await loadTreeSitterExtractor();
	await treeSitterExtractor.ensureGrammarsForPaths(sortedPaths);
	const readFile = options.readFile ?? defaultReadFile;
	const builtFiles: BuiltFile[] = [];
	for (const relPath of sortedPaths) {
		// One read plus one tree-sitter parse per file; a full build of a large
		// repo is thousands of them and must not land as a single turn.
		await slicer.tick();
		const built = buildFile(cwd, relPath, treeSitterExtractor, readFile);
		if (built) builtFiles.push(built);
	}
	return codewikiFromBuiltFiles(cwd, language, builtFiles, slicer);
}

export async function buildCodewiki(input: BuildCodewikiInput, options: CodewikiBuildOptions = {}): Promise<Codewiki> {
	const slicer = options.slicer ?? createSlicer();
	const files = (await enumerateWorkspaceFilesAsync(input.cwd, EXCLUDED_DIRS, undefined, slicer)).filter(
		isIndexablePath,
	);
	return buildFromPaths(input.cwd, input.language, files, { ...options, slicer });
}

/**
 * Apply an incremental update for a set of changed paths. The changed file
 * records and symbols are replaced in-place, and edges are rebuilt from stored
 * imports across the merged file set. Unchanged content retains its records;
 * a batch with no index changes returns the original artifact without parsing.
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
		return syncCodewiki(cwd, codewiki, options);
	}
	const slicer = options.slicer ?? createSlicer();
	const existingFiles = new Map(codewiki.files.map((file) => [file.path, file]));
	const visiblePaths = new Set(filterWorkspaceFileCandidates(cwd, normalizedPaths, EXCLUDED_DIRS));
	const readFile = options.readFile ?? defaultReadFile;
	const currentTexts = new Map<string, string>();
	const changedPathSet = new Set<string>();
	const rebuildPaths: string[] = [];
	for (const relPath of normalizedPaths) {
		const existing = existingFiles.get(relPath);
		const isCurrentIndexableFile = isIndexablePath(relPath) && visiblePaths.has(relPath);
		if (!existing && !isCurrentIndexableFile) continue;
		if (isCurrentIndexableFile) {
			const text = readFile(join(cwd, relPath));
			if (text !== null) {
				if (existing?.hash === contentHash(text)) continue;
				currentTexts.set(relPath, text);
				rebuildPaths.push(relPath);
			}
		}
		changedPathSet.add(relPath);
	}
	if (changedPathSet.size === 0) return codewiki;
	const rebuiltFiles: BuiltFile[] = [];
	if (rebuildPaths.length > 0) {
		const treeSitterExtractor = await loadTreeSitterExtractor();
		await treeSitterExtractor.ensureGrammarsForPaths(rebuildPaths);
		for (const relPath of rebuildPaths) {
			await slicer.tick();
			const built = buildFile(
				cwd,
				relPath,
				treeSitterExtractor,
				(path) => currentTexts.get(normalizeRel(cwd, path)) ?? null,
			);
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
	return codewikiFromBuiltFiles(cwd, codewiki.language, [...keptFiles, ...rebuiltFiles], slicer);
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
	const slicer = options.slicer ?? createSlicer();
	const readFile = options.readFile ?? defaultReadFile;
	const currentPaths = (await enumerateWorkspaceFilesAsync(cwd, EXCLUDED_DIRS, undefined, slicer)).filter(
		isIndexablePath,
	);
	const currentFiles = new Map<string, string>();
	const currentTexts = new Map<string, string>();
	for (const relPath of currentPaths) {
		// Reads and hashes every visible file in the workspace. Cheap per file,
		// seconds in aggregate on a large repo.
		await slicer.tick();
		const text = readFile(join(cwd, relPath));
		if (text !== null) {
			currentFiles.set(relPath, contentHash(text));
			currentTexts.set(relPath, text);
		}
	}
	const indexedFiles = new Map(codewiki.files.map((file) => [file.path, file] as const));
	const changedPaths = new Set<string>();
	for (const [relPath, hash] of currentFiles) {
		if (indexedFiles.get(relPath)?.hash !== hash) changedPaths.add(relPath);
	}
	for (const relPath of indexedFiles.keys()) {
		if (!currentFiles.has(relPath)) changedPaths.add(relPath);
	}
	if (changedPaths.size === 0) {
		// A fingerprint-domain upgrade also reconciles resolver changes even
		// when source hashes still match the old artifact.
		if (!codewiki.files.some((file) => file.lang === "python")) return codewiki;
		const edges = await buildEdges(cwd, codewiki.files, slicer);
		return JSON.stringify(edges) === JSON.stringify(codewiki.edges) ? codewiki : { ...codewiki, edges };
	}
	const syncOptions: CodewikiBuildOptions = {
		...options,
		slicer,
		readFile: (path) => currentTexts.get(normalizeRel(cwd, path)) ?? readFile(path),
	};
	return updateCodewikiPaths(cwd, codewiki, [...changedPaths], syncOptions);
}

function symbolSigFields(kind: CodewikiSymbolKind, sig: string | undefined): Pick<CodewikiSymbol, "sig"> {
	if (!CODEWIKI_SYMBOL_KINDS_WITH_SIG.has(kind)) return {};
	const clean = sig?.trim().slice(0, 240);
	return clean && clean.length > 0 ? { sig: clean } : {};
}
