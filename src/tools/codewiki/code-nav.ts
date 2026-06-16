import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import type { Codewiki, CodewikiFile, CodewikiSymbol } from "../../domains/context/codewiki/indexer.js";
import { compileGlobRegex } from "../glob.js";
import type { ToolResult, ToolSpec } from "../registry.js";
import { stringEnum } from "../string-enum.js";
import { loadCodewikiForTool, renderJson } from "./shared.js";

const REGEX_SYNTAX_HINTS = /\.\*|\.\+|\^|\$|\\[dDwWsSbB]|\(\?:|\(\?=|\(\?!/;
const DEFAULT_ENTRY_LIMIT = 25;
const MAX_ENTRY_LIMIT = 200;

interface NavIndex {
	filesById: Map<string, CodewikiFile>;
	filesByPath: Map<string, CodewikiFile>;
	paths: string[];
	symbolToFileIds: Map<string, string[]>;
	symbolsByFileId: Map<string, CodewikiSymbol[]>;
	depsByFileId: Map<string, { internal: string[]; external: string[] }>;
	dependentsByFileId: Map<string, string[]>;
}

function regexFromPattern(pattern: string): RegExp | null {
	if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
		const last = pattern.lastIndexOf("/");
		const body = pattern.slice(1, last);
		const flags = pattern.slice(last + 1);
		try {
			return new RegExp(body, flags);
		} catch {
			return null;
		}
	}
	if (REGEX_SYNTAX_HINTS.test(pattern)) {
		try {
			return new RegExp(pattern);
		} catch {
			// fall through to glob or substring
		}
	}
	if (/[*?[\]]/.test(pattern)) {
		try {
			return compileGlobRegex(pattern);
		} catch {
			return null;
		}
	}
	return null;
}

function readPackageEntryPaths(cwd: string): Set<string> {
	const out = new Set<string>();
	const pkgPath = join(cwd, "package.json");
	if (!existsSync(pkgPath)) return out;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(pkgPath, "utf8"));
	} catch {
		return out;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
	const pkg = parsed as Record<string, unknown>;
	if (typeof pkg.main === "string") out.add(normalizeEntryPath(pkg.main));
	if (typeof pkg.bin === "string") out.add(normalizeEntryPath(pkg.bin));
	if (typeof pkg.bin === "object" && pkg.bin !== null && !Array.isArray(pkg.bin)) {
		for (const value of Object.values(pkg.bin)) {
			if (typeof value === "string") out.add(normalizeEntryPath(value));
		}
	}
	return out;
}

function normalizeEntryPath(value: string): string {
	return normalize(value)
		.split("\\")
		.join("/")
		.replace(/^\.\/+/, "");
}

function comparePath(a: { path: string }, b: { path: string }): number {
	return a.path.localeCompare(b.path);
}

function fileSummary(file: CodewikiFile): Record<string, unknown> {
	return {
		id: file.id,
		path: file.path,
		lang: file.lang,
		loc: file.loc,
		role: file.role,
	};
}

function symbolSummary(symbol: CodewikiSymbol): Record<string, unknown> {
	return {
		name: symbol.name,
		kind: symbol.kind,
		fileId: symbol.fileId,
		line: symbol.line,
		...(symbol.sig ? { sig: symbol.sig } : {}),
	};
}

function buildNavIndex(codewiki: Codewiki): NavIndex {
	const filesById = new Map(codewiki.files.map((file) => [file.id, file] as const));
	const filesByPath = new Map(codewiki.files.map((file) => [file.path, file] as const));
	const paths = codewiki.files.map((file) => file.path).sort((a, b) => a.localeCompare(b));
	const symbolToFileIds = new Map<string, string[]>();
	const symbolsByFileId = new Map<string, CodewikiSymbol[]>();
	for (const symbol of codewiki.symbols) {
		const fileIds = symbolToFileIds.get(symbol.name) ?? [];
		if (!fileIds.includes(symbol.fileId)) fileIds.push(symbol.fileId);
		symbolToFileIds.set(symbol.name, fileIds);
		const symbols = symbolsByFileId.get(symbol.fileId) ?? [];
		symbols.push(symbol);
		symbolsByFileId.set(symbol.fileId, symbols);
	}
	for (const [name, fileIds] of symbolToFileIds) {
		symbolToFileIds.set(
			name,
			fileIds.sort((a, b) => a.localeCompare(b)),
		);
	}
	for (const [fileId, symbols] of symbolsByFileId) {
		symbolsByFileId.set(
			fileId,
			symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind)),
		);
	}
	const depsByFileId = new Map<string, { internal: string[]; external: string[] }>();
	const dependentsByFileId = new Map<string, string[]>();
	for (const edge of codewiki.edges) {
		const deps = depsByFileId.get(edge.fileId) ?? { internal: [], external: [] };
		if ("toFileId" in edge) {
			const target = filesById.get(edge.toFileId);
			if (target && !deps.internal.includes(target.path)) deps.internal.push(target.path);
			const importers = dependentsByFileId.get(edge.toFileId) ?? [];
			const source = filesById.get(edge.fileId);
			if (source && !importers.includes(source.path)) importers.push(source.path);
			dependentsByFileId.set(edge.toFileId, importers);
		} else if (!deps.external.includes(edge.externalModule)) {
			deps.external.push(edge.externalModule);
		}
		depsByFileId.set(edge.fileId, deps);
	}
	for (const [fileId, deps] of depsByFileId) {
		depsByFileId.set(fileId, {
			internal: deps.internal.sort((a, b) => a.localeCompare(b)),
			external: deps.external.sort((a, b) => a.localeCompare(b)),
		});
	}
	for (const [fileId, importers] of dependentsByFileId) {
		dependentsByFileId.set(
			fileId,
			importers.sort((a, b) => a.localeCompare(b)),
		);
	}
	return { filesById, filesByPath, paths, symbolToFileIds, symbolsByFileId, depsByFileId, dependentsByFileId };
}

function runSymbol(index: NavIndex, query: string): ToolResult {
	const ids = index.symbolToFileIds.get(query) ?? [];
	const files = ids.map((id) => index.filesById.get(id)).filter((file): file is CodewikiFile => Boolean(file));
	// Return the matching symbol records with their path, line, and signature so the model
	// gets the exact definition site (file:line) from the index instead of grepping for it.
	const matched: Array<{ file: CodewikiFile; symbol: CodewikiSymbol }> = [];
	for (const file of files) {
		for (const symbol of index.symbolsByFileId.get(file.id) ?? []) {
			if (symbol.name === query) matched.push({ file, symbol });
		}
	}
	matched.sort(
		(a, b) =>
			a.file.path.localeCompare(b.file.path) ||
			a.symbol.line - b.symbol.line ||
			a.symbol.kind.localeCompare(b.symbol.kind),
	);
	const symbols = matched.map(({ file, symbol }) => ({ ...symbolSummary(symbol), path: file.path }));
	return { kind: "ok", output: renderJson({ symbols, files: files.sort(comparePath).map(fileSummary) }) };
}

function runPath(index: NavIndex, query: string): ToolResult {
	const regex = regexFromPattern(query);
	const matches = index.paths
		.filter((path) => (regex ? regex.test(path) : path.includes(query)))
		.map((path) => index.filesByPath.get(path))
		.filter((file): file is CodewikiFile => Boolean(file));
	const output = renderJson({ files: matches.map(fileSummary) });
	return matches.length === 0 ? { kind: "ok", output: `${output}\n[no matches]` } : { kind: "ok", output };
}

function runEntries(index: NavIndex, limitArg: unknown): ToolResult {
	const cwd = process.cwd();
	const packageEntries = readPackageEntryPaths(cwd);
	const candidates = [...index.filesByPath.values()].filter(
		(file) => file.lang !== "config" && (file.role === "entry" || packageEntries.has(file.path)),
	);
	const limit =
		typeof limitArg === "number" && Number.isFinite(limitArg) && limitArg > 0
			? Math.min(Math.floor(limitArg), MAX_ENTRY_LIMIT)
			: DEFAULT_ENTRY_LIMIT;
	const ranked = [...candidates].sort((a, b) => {
		const aPkg = packageEntries.has(a.path) ? 0 : 1;
		const bPkg = packageEntries.has(b.path) ? 0 : 1;
		return aPkg === bPkg ? a.path.localeCompare(b.path) : aPkg - bPkg;
	});
	const limited = ranked.slice(0, limit);
	const omitted = ranked.length - limited.length;
	const output = renderJson({ files: limited.map(fileSummary), omitted });
	return { kind: "ok", output };
}

function resolveFile(index: NavIndex, query: string): CodewikiFile | { error: string } {
	const exact = index.filesByPath.get(query);
	if (exact) return exact;
	const matches = index.paths.filter((path) => path.endsWith(query) || path.includes(query));
	if (matches.length === 1) {
		const file = index.filesByPath.get(matches[0] ?? "");
		if (file) return file;
	}
	if (matches.length > 1) {
		return { error: `ambiguous path '${query}' matched ${matches.length} files; use an exact indexed path` };
	}
	return { error: `path '${query}' is not in the codewiki` };
}

function runOutline(index: NavIndex, query: string): ToolResult {
	const file = resolveFile(index, query);
	if ("error" in file) return { kind: "error", message: `code_nav: ${file.error}` };
	const symbols = index.symbolsByFileId.get(file.id) ?? [];
	return { kind: "ok", output: renderJson({ file: fileSummary(file), symbols: symbols.map(symbolSummary) }) };
}

function runDeps(index: NavIndex, query: string): ToolResult {
	const file = resolveFile(index, query);
	if ("error" in file) return { kind: "error", message: `code_nav: ${file.error}` };
	const deps = index.depsByFileId.get(file.id) ?? { internal: [], external: [] };
	return { kind: "ok", output: renderJson({ file: fileSummary(file), deps }) };
}

function runDependents(index: NavIndex, query: string): ToolResult {
	const file = resolveFile(index, query);
	if ("error" in file) return { kind: "error", message: `code_nav: ${file.error}` };
	const dependents = index.dependentsByFileId.get(file.id) ?? [];
	return { kind: "ok", output: renderJson({ file: fileSummary(file), dependents }) };
}

export const codeNavTool: ToolSpec = {
	name: ToolNames.CodeNav,
	description:
		"Navigate the indexed codewiki: mode=symbol finds files by symbol, path finds files by glob/regex/substring, entries lists likely entry points, outline lists file symbols, deps lists imports, dependents lists importers.",
	parameters: Type.Object({
		mode: stringEnum(["symbol", "path", "entries", "outline", "deps", "dependents"], "Lookup mode."),
		query: Type.Optional(Type.String({ description: "Symbol name, indexed path, path pattern, or path substring." })),
		limit: Type.Optional(Type.Number({ description: `mode=entries: max results (default ${DEFAULT_ENTRY_LIMIT}).` })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args): Promise<ToolResult> {
		const mode = typeof args.mode === "string" ? args.mode : "";
		const loaded = loadCodewikiForTool();
		if (!loaded.ok) return { kind: "error", message: loaded.message };
		const index = buildNavIndex(loaded.codewiki);
		const query = typeof args.query === "string" ? args.query.trim() : "";
		if (mode === "symbol") {
			if (query.length === 0) return { kind: "error", message: "code_nav: mode=symbol requires query" };
			return runSymbol(index, query);
		}
		if (mode === "path") {
			if (query.length === 0) return { kind: "error", message: "code_nav: mode=path requires query" };
			return runPath(index, query);
		}
		if (mode === "entries") return runEntries(index, args.limit);
		if (mode === "outline") {
			if (query.length === 0) return { kind: "error", message: "code_nav: mode=outline requires query path" };
			return runOutline(index, query);
		}
		if (mode === "deps") {
			if (query.length === 0) return { kind: "error", message: "code_nav: mode=deps requires query path" };
			return runDeps(index, query);
		}
		if (mode === "dependents") {
			if (query.length === 0) return { kind: "error", message: "code_nav: mode=dependents requires query path" };
			return runDependents(index, query);
		}
		return {
			kind: "error",
			message: `code_nav: mode must be symbol, path, entries, outline, deps, or dependents; got '${mode}'`,
		};
	},
};
