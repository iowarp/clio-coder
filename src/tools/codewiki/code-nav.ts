import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import type { Codewiki, CodewikiFile, CodewikiSymbol } from "../../domains/context/codewiki/indexer.js";
import { listWikiPages, validateWikiLayout } from "../../domains/context/wiki/layout.js";
import { readWikiMeta } from "../../domains/context/wiki/meta.js";
import { wikiStaleness } from "../../domains/context/wiki/staleness.js";
import { compileGlobRegex } from "../ignore-policy.js";
import {
	finalizeObservation,
	OBSERVE_SELF_CAPS,
	observationBudgetExhausted,
	reserveObservation,
} from "../observation.js";
import type { ToolResult, ToolSpec } from "../registry.js";
import { stringEnum } from "../string-enum.js";
import { loadCodewikiForTool, renderJson } from "./shared.js";

const REGEX_SYNTAX_HINTS = /\.\*|\.\+|\^|\$|\\[dDwWsSbB]|\(\?:|\(\?=|\(\?!/;
const DEFAULT_LIMIT = 50;
const DEFAULT_ENTRY_LIMIT = 25;
const MAX_LIMIT = 200;

interface NavIndex {
	filesById: Map<string, CodewikiFile>;
	filesByPath: Map<string, CodewikiFile>;
	paths: string[];
	symbolToFileIds: Map<string, string[]>;
	symbolsByFileId: Map<string, CodewikiSymbol[]>;
	depsByFileId: Map<string, { internal: string[]; external: string[] }>;
	dependentsByFileId: Map<string, string[]>;
}

/** One mode's result: a JSON-clean payload plus the envelope counts. */
interface NavPayload {
	payload: Record<string, unknown>;
	shownCount: number;
	totalCount: number;
	next?: string;
}

const navIndexCache = new WeakMap<Codewiki, NavIndex>();

function regexFromPattern(pattern: string): RegExp | null {
	if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
		const last = pattern.lastIndexOf("/");
		const body = pattern.slice(1, last);
		// Strip g/y: the regex is reused across .test() in a .filter, and a sticky/global
		// flag advances lastIndex between calls, silently skipping matching paths.
		const flags = pattern.slice(last + 1).replace(/[gy]/g, "");
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
		...(file.summary ? { summary: file.summary } : {}),
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

function navIndexFor(codewiki: Codewiki): NavIndex {
	const cached = navIndexCache.get(codewiki);
	if (cached) return cached;
	const index = buildNavIndex(codewiki);
	navIndexCache.set(codewiki, index);
	return index;
}

function runSymbol(index: NavIndex, query: string, limit: number): NavPayload {
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
	const shown = matched.slice(0, limit);
	const omitted = matched.length - shown.length;
	const symbols = shown.map(({ file, symbol }) => ({ ...symbolSummary(symbol), path: file.path }));
	const next = matched.length === 0 ? `mode=path query=${query}` : omitted > 0 ? `limit=${limit * 2}` : undefined;
	return {
		payload: {
			symbols,
			files: files.sort(comparePath).slice(0, limit).map(fileSummary),
			omitted,
			...(next !== undefined ? { next } : {}),
		},
		shownCount: shown.length,
		totalCount: matched.length,
		...(next !== undefined ? { next } : {}),
	};
}

function runPath(index: NavIndex, query: string, limit: number): NavPayload {
	const regex = regexFromPattern(query);
	const matches = index.paths
		.filter((path) => (regex ? regex.test(path) : path.includes(query)))
		.map((path) => index.filesByPath.get(path))
		.filter((file): file is CodewikiFile => Boolean(file));
	const shown = matches.slice(0, limit);
	const omitted = matches.length - shown.length;
	const next = matches.length === 0 ? "mode=entries" : omitted > 0 ? `limit=${limit * 2}` : undefined;
	return {
		payload: { files: shown.map(fileSummary), omitted, ...(next !== undefined ? { next } : {}) },
		shownCount: shown.length,
		totalCount: matches.length,
		...(next !== undefined ? { next } : {}),
	};
}

function runEntries(index: NavIndex, limit: number): NavPayload {
	const cwd = process.cwd();
	const packageEntries = readPackageEntryPaths(cwd);
	const candidates = [...index.filesByPath.values()].filter(
		(file) => file.lang !== "config" && (file.role === "entry" || packageEntries.has(file.path)),
	);
	const ranked = candidates.sort((a, b) => {
		const aPkg = packageEntries.has(a.path) ? 0 : 1;
		const bPkg = packageEntries.has(b.path) ? 0 : 1;
		return aPkg === bPkg ? a.path.localeCompare(b.path) : aPkg - bPkg;
	});
	const shown = ranked.slice(0, limit);
	const omitted = ranked.length - shown.length;
	const next = ranked.length === 0 ? "mode=path query=src/" : omitted > 0 ? `limit=${limit * 2}` : undefined;
	return {
		payload: { files: shown.map(fileSummary), omitted, ...(next !== undefined ? { next } : {}) },
		shownCount: shown.length,
		totalCount: ranked.length,
		...(next !== undefined ? { next } : {}),
	};
}

function resolveFile(index: NavIndex, query: string): CodewikiFile | { error: string } {
	const exact = index.filesByPath.get(query);
	if (exact) return exact;
	const matches = index.paths.filter((path) => path.includes(query));
	if (matches.length === 1) {
		const file = index.filesByPath.get(matches[0] ?? "");
		if (file) return file;
	}
	if (matches.length > 1) {
		return { error: `ambiguous path '${query}' matched ${matches.length} files; use an exact indexed path` };
	}
	return { error: `path '${query}' is not in the codewiki` };
}

function runOutline(index: NavIndex, query: string, limit: number): NavPayload | ToolResult {
	const file = resolveFile(index, query);
	if ("error" in file) return { kind: "error", message: `code_nav: ${file.error}` };
	const symbols = index.symbolsByFileId.get(file.id) ?? [];
	const shown = symbols.slice(0, limit);
	const omitted = symbols.length - shown.length;
	const next = omitted > 0 ? `limit=${limit * 2}` : undefined;
	return {
		payload: {
			file: fileSummary(file),
			symbols: shown.map(symbolSummary),
			omitted,
			...(next !== undefined ? { next } : {}),
		},
		shownCount: shown.length,
		totalCount: symbols.length,
		...(next !== undefined ? { next } : {}),
	};
}

function runDeps(index: NavIndex, query: string, limit: number): NavPayload | ToolResult {
	const file = resolveFile(index, query);
	if ("error" in file) return { kind: "error", message: `code_nav: ${file.error}` };
	const deps = index.depsByFileId.get(file.id) ?? { internal: [], external: [] };
	const internal = deps.internal.slice(0, limit);
	const external = deps.external.slice(0, limit);
	const total = deps.internal.length + deps.external.length;
	const shown = internal.length + external.length;
	const omitted = total - shown;
	const next = omitted > 0 ? `limit=${limit * 2}` : undefined;
	return {
		payload: {
			file: fileSummary(file),
			deps: { internal, external },
			omitted,
			...(next !== undefined ? { next } : {}),
		},
		shownCount: shown,
		totalCount: total,
		...(next !== undefined ? { next } : {}),
	};
}

function runDependents(index: NavIndex, query: string, limit: number): NavPayload | ToolResult {
	const file = resolveFile(index, query);
	if ("error" in file) return { kind: "error", message: `code_nav: ${file.error}` };
	const dependents = index.dependentsByFileId.get(file.id) ?? [];
	const shown = dependents.slice(0, limit);
	const omitted = dependents.length - shown.length;
	const next = omitted > 0 ? `limit=${limit * 2}` : undefined;
	return {
		payload: {
			file: fileSummary(file),
			dependents: shown,
			omitted,
			...(next !== undefined ? { next } : {}),
		},
		shownCount: shown.length,
		totalCount: dependents.length,
		...(next !== undefined ? { next } : {}),
	};
}

function runWiki(cwd: string): NavPayload {
	const meta = readWikiMeta(cwd);
	if (!meta) {
		return {
			payload: {
				pages: [],
				staleness: { state: "absent" },
				message: "no wiki exists; run clio context wiki",
			},
			shownCount: 0,
			totalCount: 0,
		};
	}
	const validation = validateWikiLayout(cwd);
	const pages = validation.ok ? listWikiPages(cwd) : meta.pages;
	return {
		payload: {
			pages,
			staleness: wikiStaleness(cwd),
			...(!validation.ok
				? { message: `wiki layout invalid; run clio context wiki --update (${validation.problems.join("; ")})` }
				: {}),
		},
		shownCount: pages.length,
		totalCount: pages.length,
	};
}

function parseLimit(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.min(Math.floor(value), MAX_LIMIT);
	return fallback;
}

export const codeNavTool: ToolSpec = {
	name: ToolNames.CodeNav,
	description:
		"Navigate the indexed codewiki: mode=symbol finds files by symbol, path finds files by glob/regex/substring, entries lists likely entry points, outline lists file symbols, deps lists imports, dependents lists importers, wiki lists Markdown wiki pages.",
	parameters: Type.Object({
		mode: stringEnum(["symbol", "path", "entries", "outline", "deps", "dependents", "wiki"], "Lookup mode."),
		query: Type.Optional(Type.String({ description: "Symbol name, indexed path, path pattern, or path substring." })),
		limit: Type.Optional(
			Type.Number({
				description: `Max results (default ${DEFAULT_LIMIT}, entries ${DEFAULT_ENTRY_LIMIT}, max ${MAX_LIMIT}).`,
			}),
		),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args, options): Promise<ToolResult> {
		const mode = typeof args.mode === "string" ? args.mode : "";
		const loaded = await loadCodewikiForTool();
		if (!loaded.ok) return { kind: "error", message: loaded.message };
		const index = navIndexFor(loaded.codewiki);
		const query = typeof args.query === "string" ? args.query.trim() : "";
		const limit = parseLimit(args.limit, mode === "entries" ? DEFAULT_ENTRY_LIMIT : DEFAULT_LIMIT);
		const reservation = reserveObservation(OBSERVE_SELF_CAPS.codeNav, options);
		if (reservation.exhausted) {
			return observationBudgetExhausted({
				tool: ToolNames.CodeNav,
				unit: "results",
				reservation,
				subject: `mode=${mode}`,
				hint: "Use a lower limit or continue in a follow-up turn.",
			});
		}
		const close = (nav: NavPayload | ToolResult): ToolResult => {
			if ("kind" in nav) return nav;
			return finalizeObservation({
				tool: ToolNames.CodeNav,
				unit: "results",
				format: "json",
				output: renderJson(nav.payload),
				shownCount: nav.shownCount,
				totalCount: nav.totalCount,
				truncated: nav.shownCount < nav.totalCount,
				...(nav.next !== undefined ? { next: nav.next } : {}),
				reservation,
				...(options ? { options } : {}),
			});
		};
		if (mode === "symbol") {
			if (query.length === 0) return { kind: "error", message: "code_nav: mode=symbol requires query" };
			return close(runSymbol(index, query, limit));
		}
		if (mode === "path") {
			if (query.length === 0) return { kind: "error", message: "code_nav: mode=path requires query" };
			return close(runPath(index, query, limit));
		}
		if (mode === "entries") return close(runEntries(index, limit));
		if (mode === "outline") {
			if (query.length === 0) return { kind: "error", message: "code_nav: mode=outline requires query path" };
			return close(runOutline(index, query, limit));
		}
		if (mode === "deps") {
			if (query.length === 0) return { kind: "error", message: "code_nav: mode=deps requires query path" };
			return close(runDeps(index, query, limit));
		}
		if (mode === "dependents") {
			if (query.length === 0) return { kind: "error", message: "code_nav: mode=dependents requires query path" };
			return close(runDependents(index, query, limit));
		}
		if (mode === "wiki") return close(runWiki(process.cwd()));
		return {
			kind: "error",
			message: `code_nav: mode must be symbol, path, entries, outline, deps, dependents, or wiki; got '${mode}'`,
		};
	},
};
