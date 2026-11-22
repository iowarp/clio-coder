import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { resolvePackageRoot } from "../../core/package-root.js";
import { ToolNames } from "../../core/tool-names.js";
import { parseCodewikiRaw } from "../../domains/context/codewiki/artifact.js";
import { missingGrammarNote } from "../../domains/context/codewiki/fetched-grammars.js";
import type { Codewiki, CodewikiFile, CodewikiSymbol } from "../../domains/context/codewiki/schema.js";
import { readWikiPage } from "../../domains/context/wiki/frontmatter.js";
import { listWikiPages } from "../../domains/context/wiki/layout.js";
import { readWikiMeta } from "../../domains/context/wiki/meta.js";
import { wikiCompletenessFromMeta, wikiStaleness } from "../../domains/context/wiki/staleness.js";
import { compileGlobRegex, emptySearchText } from "../ignore-policy.js";
import {
	commitObservationReservation,
	finalizeObservation,
	OBSERVE_SELF_CAPS,
	observationBudgetExhausted,
	releaseObservation,
	reserveObservation,
} from "../observation.js";
import type { ToolResult, ToolSpec } from "../registry.js";
import { writeToolOffload } from "../result-shaping.js";
import { byteLength } from "../truncate-utf8.js";
import {
	codeNavToolSurface,
	CODE_NAV_DEFAULT_ENTRY_LIMIT as DEFAULT_ENTRY_LIMIT,
	CODE_NAV_DEFAULT_LIMIT as DEFAULT_LIMIT,
	CODE_NAV_DEFAULT_RELATED_LIMIT as DEFAULT_RELATED_LIMIT,
	CODE_NAV_MAX_LIMIT as MAX_LIMIT,
} from "./code-nav-surface.js";
import { loadCodewikiForTool, renderJson } from "./shared.js";

const REGEX_SYNTAX_HINTS = /\.\*|\.\+|\^|\$|\\[dDwWsSbB]|\(\?:|\(\?=|\(\?!/;
const CLIO_CODEWIKI_RELATIVE_PATH = join("dist", "assets", "codemap.json.gz");
// A dist built before the map shipped gzipped carries one of these plain names instead.
const CLIO_CODEWIKI_PLAIN_PATHS = [join("dist", "assets", "codemap.json"), join("dist", "assets", "codewiki.json")];

function readClioCodewikiText(packageRoot: string): string {
	const gzipped = join(packageRoot, CLIO_CODEWIKI_RELATIVE_PATH);
	if (existsSync(gzipped)) return gunzipSync(readFileSync(gzipped)).toString("utf8");
	const plain = CLIO_CODEWIKI_PLAIN_PATHS.map((path) => join(packageRoot, path)).find((path) => existsSync(path));
	return readFileSync(plain ?? gzipped, "utf8");
}

type CodeNavSource = "workspace" | "clio";

interface LoadedNavSource {
	codewiki: Codewiki;
	entryRoot: string | null;
	fingerprint?: import("../../domains/context/fingerprint.js").Fingerprint;
}

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
	/** The complete listing a byte-cut answer offloaded, handed to the observation as its offload source. */
	fullOutput?: string;
}

const navIndexCache = new WeakMap<Codewiki, NavIndex>();
let clioCodewikiCache: { packageRoot: string; codewiki: Codewiki } | null = null;

function packageRootResolvedPath(packageRoot: string, indexedPath: string): string {
	const resolved = resolve(packageRoot, indexedPath);
	const rel = relative(packageRoot, resolved);
	if (
		rel.length === 0 ||
		rel === ".." ||
		rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
		isAbsolute(rel)
	) {
		throw new Error(`invalid package-root-relative path in bundled code map: ${indexedPath}`);
	}
	return resolved;
}

function packageRootResolvedCodewiki(packageRoot: string, codewiki: Codewiki): Codewiki {
	return {
		...codewiki,
		files: codewiki.files.map((file) => ({
			...file,
			path: packageRootResolvedPath(packageRoot, file.path),
		})),
	};
}

function loadClioCodewikiForTool(): { ok: true; loaded: LoadedNavSource } | { ok: false; message: string } {
	try {
		const packageRoot = resolvePackageRoot();
		if (clioCodewikiCache?.packageRoot === packageRoot) {
			return { ok: true, loaded: { codewiki: clioCodewikiCache.codewiki, entryRoot: packageRoot } };
		}
		const parsed = parseCodewikiRaw(readClioCodewikiText(packageRoot));
		if (!parsed) throw new Error("bundled artifact is not a valid codemap");
		const codewiki = packageRootResolvedCodewiki(packageRoot, parsed);
		clioCodewikiCache = { packageRoot, codewiki };
		return { ok: true, loaded: { codewiki, entryRoot: packageRoot } };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			message: `code_nav: bundled CLIO Coder code map unavailable at ${CLIO_CODEWIKI_RELATIVE_PATH}: ${message}`,
		};
	}
}

async function loadNavSource(
	source: CodeNavSource,
): Promise<{ ok: true; loaded: LoadedNavSource } | { ok: false; message: string }> {
	if (source === "clio") return loadClioCodewikiForTool();
	const loaded = await loadCodewikiForTool(process.cwd());
	return loaded.ok
		? { ok: true, loaded: { codewiki: loaded.codewiki, entryRoot: null, fingerprint: loaded.fingerprint } }
		: { ok: false, message: loaded.message };
}

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

function readPackageEntryPaths(cwd: string, resolveFromRoot: boolean): Set<string> {
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
	const add = (value: string): void => {
		const normalized = normalizeEntryPath(value);
		out.add(resolveFromRoot ? packageRootResolvedPath(cwd, normalized) : normalized);
	};
	if (typeof pkg.main === "string") add(pkg.main);
	if (typeof pkg.bin === "string") add(pkg.bin);
	if (typeof pkg.bin === "object" && pkg.bin !== null && !Array.isArray(pkg.bin)) {
		for (const value of Object.values(pkg.bin)) {
			if (typeof value === "string") add(value);
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

/**
 * A directory the index holds, for the empty-result line's listing call: the query's leading word when it names one
 * ("src users catalog" names src), else the first top-level directory. None when every indexed file is at the root.
 */
function listedDirectory(index: NavIndex, query: string): string | undefined {
	const dirs = [...new Set(index.paths.filter((path) => path.includes("/")).map((path) => path.split("/")[0] ?? ""))]
		.filter((dir) => dir.length > 0)
		.sort((a, b) => a.localeCompare(b));
	const lead = query.split(/[\s/]+/u).find((word) => word.length > 0);
	return lead !== undefined && dirs.includes(lead) ? lead : dirs[0];
}

/** The empty-result line of a symbol or path search, naming the query exactly as it was matched. */
function navNoMatch(index: NavIndex, query: string, searched: string): string {
	const spaced = /\s/u.test(query) ? " (matched as one string, spaces included)" : "";
	return emptySearchText(`${searched}${spaced}`, listedDirectory(index, query));
}

/** Whether a result, as the call would return it, fits the call's observation cap. */
type NavFits = (nav: NavPayload) => boolean;

/** The call's byte fit, and the writer that offloads a complete listing as the call would render it. */
interface NavFit {
	fits: NavFits;
	offload: (nav: NavPayload) => { text: string; path: string | null };
}

/**
 * The most rows, up to `rows`, whose result fits the call's byte cap. Bytes grow with the row count, so a binary search
 * finds it. When even zero rows overflow, the zero-row result goes out and the observation's oversize stub replaces it
 * whole; that stub is kept for a payload nothing can shrink.
 */
function largestFit(
	build: (rows: number) => NavPayload,
	rows: number,
	fits: NavFits,
): { rows: number; nav: NavPayload } {
	const full = build(rows);
	if (fits(full)) return { rows, nav: full };
	let low = 0;
	let high = rows - 1;
	let best = { rows: 0, nav: build(0) };
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const candidate = build(mid);
		if (fits(candidate)) {
			best = { rows: mid, nav: candidate };
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return best;
}

interface ListMore {
	next?: string;
	byteLimited?: true;
	offloadPath?: string;
	rest?: string;
}

const LIST_REST_OFFLOADED =
	"every row is in offloadPath: read it, or narrow the query (mode=path with a subdirectory, mode=outline for one file)";
const LIST_REST_NARROW =
	"the omitted rows did not fit this call: narrow the query (mode=path with a subdirectory, mode=outline for one file)";

/**
 * A row-bounded listing fitted to the call cap (field F3: 134 same-named definitions overflowed it, and the stub
 * showed none and offered a larger limit that could not fit either). It shows the most rows up to `limit` that fit.
 * When a larger limit fits more, `next` names it: up to twice the limit, never past the matches or MAX_LIMIT. When no
 * limit can show more, because the bytes cut the answer (byteLimited) or nothing past it fits, the complete listing is
 * offloaded and the payload names offloadPath, since a limit continuation would only repeat the rows shown. `size` is
 * the row dimension, so `rows === size` shows everything.
 */
function fitList(
	size: number,
	limit: number,
	fit: NavFit,
	build: (rows: number, more: ListMore) => NavPayload,
): NavPayload {
	const wanted = Math.min(limit, size);
	const ceiling = Math.max(wanted, Math.min(limit * 2, MAX_LIMIT, size));
	// Probe with the widest continuation, so the rows chosen still fit once the real one is attached.
	const probe = (rows: number): NavPayload => build(rows, rows < size ? { next: `limit=${ceiling}` } : {});
	const shown = largestFit(probe, wanted, fit.fits).rows;
	if (shown === size) return build(shown, {});
	if (shown === wanted) {
		const reach = largestFit(probe, ceiling, fit.fits).rows;
		if (reach > shown) return build(shown, { next: `limit=${reach}` });
	}
	const { text, path } = fit.offload(build(size, {}));
	const cut: ListMore = {
		...(shown < wanted ? { byteLimited: true } : {}),
		...(path !== null ? { offloadPath: path, rest: LIST_REST_OFFLOADED } : { rest: LIST_REST_NARROW }),
	};
	// The offload pointer is longer than the probed continuation, so fit the rows again with it attached.
	const fitted = largestFit((rows) => build(rows, cut), shown, fit.fits).nav;
	return path !== null ? { ...fitted, fullOutput: text } : fitted;
}

function listTail(more: ListMore, missNext?: string): Record<string, unknown> {
	const next = more.next ?? missNext;
	return {
		...(more.byteLimited ? { byteLimited: true } : {}),
		...(more.offloadPath !== undefined ? { offloadPath: more.offloadPath } : {}),
		...(more.rest !== undefined ? { rest: more.rest } : {}),
		...(next !== undefined ? { next } : {}),
	};
}

function runSymbol(index: NavIndex, query: string, limit: number, fit: NavFit): NavPayload {
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
	files.sort(comparePath);
	const missNext = matched.length === 0 ? `mode=path query=${query}` : undefined;
	return fitList(matched.length, limit, fit, (rows, more) => {
		const shown = matched.slice(0, rows);
		const tail = listTail(more, missNext);
		return {
			payload: {
				symbols: shown.map(({ file, symbol }) => ({ ...symbolSummary(symbol), path: file.path })),
				files: files.slice(0, rows).map(fileSummary),
				omitted: matched.length - shown.length,
				...tail,
				...(matched.length === 0
					? { noMatch: navNoMatch(index, query, `the code map's symbols for the exact name "${query}"`) }
					: {}),
			},
			shownCount: shown.length,
			totalCount: matched.length,
			...(typeof tail.next === "string" ? { next: tail.next } : {}),
		};
	});
}

function runPath(index: NavIndex, query: string, limit: number, fit: NavFit): NavPayload {
	const regex = regexFromPattern(query);
	const matches = index.paths
		.filter((path) => (regex ? regex.test(path) : path.includes(query)))
		.map((path) => index.filesByPath.get(path))
		.filter((file): file is CodewikiFile => Boolean(file));
	const missNext = matches.length === 0 ? "mode=entries" : undefined;
	const how = regex ? `the pattern ${query}` : `the substring "${query}"`;
	return fitList(matches.length, limit, fit, (rows, more) => {
		const shown = matches.slice(0, rows);
		const tail = listTail(more, missNext);
		return {
			payload: {
				files: shown.map(fileSummary),
				omitted: matches.length - shown.length,
				...tail,
				...(matches.length === 0
					? { noMatch: navNoMatch(index, query, `the code map's ${index.paths.length} indexed paths for ${how}`) }
					: {}),
			},
			shownCount: shown.length,
			totalCount: matches.length,
			...(typeof tail.next === "string" ? { next: tail.next } : {}),
		};
	});
}

function runEntries(index: NavIndex, limit: number, entryRoot: string | null, fit: NavFit): NavPayload {
	const cwd = entryRoot ?? process.cwd();
	const packageEntries = readPackageEntryPaths(cwd, entryRoot !== null);
	const candidates = [...index.filesByPath.values()].filter(
		(file) => file.lang !== "config" && (file.role === "entry" || packageEntries.has(file.path)),
	);
	const ranked = candidates.sort((a, b) => {
		const aPkg = packageEntries.has(a.path) ? 0 : 1;
		const bPkg = packageEntries.has(b.path) ? 0 : 1;
		return aPkg === bPkg ? a.path.localeCompare(b.path) : aPkg - bPkg;
	});
	const missNext = ranked.length === 0 ? "mode=path query=src/" : undefined;
	return fitList(ranked.length, limit, fit, (rows, more) => {
		const shown = ranked.slice(0, rows);
		const tail = listTail(more, missNext);
		return {
			payload: { files: shown.map(fileSummary), omitted: ranked.length - shown.length, ...tail },
			shownCount: shown.length,
			totalCount: ranked.length,
			...(typeof tail.next === "string" ? { next: tail.next } : {}),
		};
	});
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
		const directoryPrefix = `${query.replace(/\/+$/u, "")}/`;
		if (matches.every((path) => path.startsWith(directoryPrefix))) {
			return {
				error:
					`path '${query}' is a directory-like prefix, but deps/dependents/outline require one indexed file. ` +
					`Use mode=path query=${query} to list files, then pass an exact file path to this mode.`,
			};
		}
		return { error: `ambiguous path '${query}' matched ${matches.length} files; use an exact indexed path` };
	}
	// Point-of-failure redirect: measured on a live coder worker, symbol names
	// fed to deps mode ("mean", "median") returned a bare not-found that gave
	// the model nothing to pivot on, and it retried the same call into the
	// loop guard. Name the working alternatives instead.
	return {
		error:
			`path '${query}' is not an indexed file path. deps/dependents/outline take file paths; ` +
			`for a symbol name use mode=symbol query=${query}, or use grep/read on the workspace directly.`,
	};
}

function runOutline(index: NavIndex, query: string, limit: number, fit: NavFit): NavPayload | ToolResult {
	const file = resolveFile(index, query);
	if ("error" in file) return { kind: "error", message: `code_nav: ${file.error}` };
	const symbols = index.symbolsByFileId.get(file.id) ?? [];
	return fitList(symbols.length, limit, fit, (rows, more) => {
		const shown = symbols.slice(0, rows);
		const tail = listTail(more);
		return {
			payload: {
				file: fileSummary(file),
				symbols: shown.map(symbolSummary),
				omitted: symbols.length - shown.length,
				...tail,
			},
			shownCount: shown.length,
			totalCount: symbols.length,
			...(typeof tail.next === "string" ? { next: tail.next } : {}),
		};
	});
}

function runDeps(index: NavIndex, query: string, limit: number, fit: NavFit): NavPayload | ToolResult {
	const file = resolveFile(index, query);
	if ("error" in file) return { kind: "error", message: `code_nav: ${file.error}` };
	const deps = index.depsByFileId.get(file.id) ?? { internal: [], external: [] };
	const total = deps.internal.length + deps.external.length;
	// The limit bounds each list, so the row dimension is the longer one.
	return fitList(Math.max(deps.internal.length, deps.external.length), limit, fit, (rows, more) => {
		const internal = deps.internal.slice(0, rows);
		const external = deps.external.slice(0, rows);
		const shown = internal.length + external.length;
		const tail = listTail(more);
		return {
			payload: { file: fileSummary(file), deps: { internal, external }, omitted: total - shown, ...tail },
			shownCount: shown,
			totalCount: total,
			...(typeof tail.next === "string" ? { next: tail.next } : {}),
		};
	});
}

function runDependents(index: NavIndex, query: string, limit: number, fit: NavFit): NavPayload | ToolResult {
	const file = resolveFile(index, query);
	if ("error" in file) return { kind: "error", message: `code_nav: ${file.error}` };
	const dependents = index.dependentsByFileId.get(file.id) ?? [];
	return fitList(dependents.length, limit, fit, (rows, more) => {
		const shown = dependents.slice(0, rows);
		const tail = listTail(more);
		return {
			payload: { file: fileSummary(file), dependents: shown, omitted: dependents.length - shown.length, ...tail },
			shownCount: shown.length,
			totalCount: dependents.length,
			...(typeof tail.next === "string" ? { next: tail.next } : {}),
		};
	});
}

// The related bundle answers "what surrounds this definition" from the same
// index the single-relation modes read, so one call replaces outline + deps +
// dependents without a second scan. Its limit is one budget for the whole
// bundle: categories fill round-robin, so a heavily imported module cannot
// crowd out its own definitions and the response stays proportional.
const RELATED_NOTE =
	"importers import this file directly and are not call sites; testImporters are role=test importers, a hint for which checks to run, not proof of coverage";

interface RelatedCategory {
	key: "definitions" | "imports" | "importers" | "testImporters" | "externalImports";
	items: unknown[];
	/** Legacy-mode call that lists this category in full. */
	more: string;
}

function allocateRelatedBudget(budget: number, sizes: readonly number[]): number[] {
	const shown = sizes.map(() => 0);
	let left = budget;
	while (left > 0) {
		let progressed = false;
		for (let i = 0; i < sizes.length && left > 0; i++) {
			if ((shown[i] ?? 0) < (sizes[i] ?? 0)) {
				shown[i] = (shown[i] ?? 0) + 1;
				left--;
				progressed = true;
			}
		}
		if (!progressed) break;
	}
	return shown;
}

function definitionSummary(symbol: CodewikiSymbol): Record<string, unknown> {
	return { name: symbol.name, kind: symbol.kind, line: symbol.line, ...(symbol.sig ? { sig: symbol.sig } : {}) };
}

function relatedLimit(count: number): number {
	return Math.min(Math.max(count, 1), MAX_LIMIT);
}

function relatedBundle(
	index: NavIndex,
	file: CodewikiFile,
	definitions: CodewikiSymbol[],
	head: Record<string, unknown>,
	definitionsMore: string,
	budget: number,
	fits: NavFits,
	sourcePrefix: string,
): NavPayload {
	const deps = index.depsByFileId.get(file.id) ?? { internal: [], external: [] };
	const importers: string[] = [];
	const testImporters: string[] = [];
	for (const path of index.dependentsByFileId.get(file.id) ?? []) {
		if (index.filesByPath.get(path)?.role === "test") testImporters.push(path);
		else importers.push(path);
	}
	const depsMore = `mode=deps query=${file.path} limit=${relatedLimit(Math.max(deps.internal.length, deps.external.length))}`;
	const dependentsMore = `mode=dependents query=${file.path} limit=${relatedLimit(importers.length + testImporters.length)}`;
	// Priority order: round-robin hands out slots in this order each pass.
	const categories: RelatedCategory[] = [
		{ key: "definitions", items: definitions.map(definitionSummary), more: definitionsMore },
		{ key: "imports", items: deps.internal, more: depsMore },
		{ key: "importers", items: importers, more: dependentsMore },
		{ key: "testImporters", items: testImporters, more: dependentsMore },
		{ key: "externalImports", items: deps.external, more: depsMore },
	];
	const totalCount = categories.reduce((sum, category) => sum + category.items.length, 0);
	const build = (items: number): NavPayload => {
		const shown = allocateRelatedBudget(
			items,
			categories.map((category) => category.items.length),
		);
		const slice = (i: number): unknown[] => categories[i]?.items.slice(0, shown[i] ?? 0) ?? [];
		const more: Record<string, { omitted: number; next: string }> = {};
		let next: string | undefined;
		let largestOmitted = 0;
		categories.forEach((category, i) => {
			const omitted = category.items.length - (shown[i] ?? 0);
			if (omitted === 0) return;
			more[category.key] = { omitted, next: `${sourcePrefix}${category.more}` };
			if (omitted > largestOmitted) {
				largestOmitted = omitted;
				next = category.more;
			}
		});
		const shownCount = shown.reduce((sum, count) => sum + count, 0);
		return {
			payload: {
				related: true,
				...head,
				file: fileSummary(file),
				definitions: slice(0),
				imports: { internal: slice(1), external: slice(4) },
				importers: slice(2),
				testImporters: slice(3),
				omitted: totalCount - shownCount,
				budget: items,
				...(items < budget ? { byteLimited: true } : {}),
				...(Object.keys(more).length > 0 ? { more } : {}),
				...(next !== undefined ? { next } : {}),
				note: RELATED_NOTE,
			},
			shownCount,
			totalCount,
			...(next !== undefined ? { next } : {}),
		};
	};
	// The item budget bounds the shape; the call's observation cap bounds the
	// bytes. Shrink the item budget until the JSON fits so a pool-limited or
	// signature-heavy bundle degrades to fewer facts with honest omitted counts
	// instead of the all-or-nothing oversize stub.
	return largestFit(build, budget, fits).nav;
}

function runSymbolRelated(
	index: NavIndex,
	query: string,
	budget: number,
	fits: NavFits,
	sourcePrefix: string,
): NavPayload {
	const files = (index.symbolToFileIds.get(query) ?? [])
		.map((id) => index.filesById.get(id))
		.filter((file): file is CodewikiFile => Boolean(file))
		.sort(comparePath);
	if (files.length === 0) {
		const next = `mode=path query=${query}`;
		return {
			payload: { related: true, symbol: query, definitions: [], omitted: 0, next },
			shownCount: 0,
			totalCount: 0,
			next,
		};
	}
	const definitionsIn = (file: CodewikiFile): CodewikiSymbol[] =>
		(index.symbolsByFileId.get(file.id) ?? []).filter((symbol) => symbol.name === query);
	const [only] = files;
	if (files.length === 1 && only) {
		return relatedBundle(
			index,
			only,
			definitionsIn(only),
			{ symbol: query },
			`mode=symbol query=${query} limit=${relatedLimit(definitionsIn(only).length)}`,
			budget,
			fits,
			sourcePrefix,
		);
	}
	// Same name in several files: the neighborhood belongs to one owning file,
	// and choosing for the model would answer a question it did not ask.
	const candidates = files.slice(0, budget).map((file) => {
		const defs = definitionsIn(file);
		const first = defs[0];
		return {
			path: file.path,
			role: file.role,
			...(first ? { line: first.line, kind: first.kind, ...(first.sig ? { sig: first.sig } : {}) } : {}),
			...(defs.length > 1 ? { definitions: defs.length } : {}),
		};
	});
	const firstPath = files[0]?.path ?? "";
	const next = `mode=outline related=true query=${firstPath}`;
	return {
		payload: {
			related: true,
			symbol: query,
			ambiguous: true,
			message: `'${query}' is defined in ${files.length} indexed files; related=true needs one owning file. Re-run mode=outline related=true with the exact path you mean.`,
			candidates,
			omitted: files.length - candidates.length,
			next,
		},
		shownCount: candidates.length,
		totalCount: files.length,
		next,
	};
}

function runOutlineRelated(
	index: NavIndex,
	query: string,
	budget: number,
	fits: NavFits,
	sourcePrefix: string,
): NavPayload | ToolResult {
	const file = resolveFile(index, query);
	if ("error" in file) return { kind: "error", message: `code_nav: ${file.error}` };
	if (file.path !== query) {
		return {
			kind: "error",
			message: `code_nav: related=true takes an exact indexed path; '${query}' only partially matches. Re-run with query=${file.path}`,
		};
	}
	const symbols = index.symbolsByFileId.get(file.id) ?? [];
	return relatedBundle(
		index,
		file,
		symbols,
		{},
		`mode=outline query=${file.path} limit=${relatedLimit(symbols.length)}`,
		budget,
		fits,
		sourcePrefix,
	);
}

const WIKI_UPDATE_COMMAND = "clio-coder context wiki --update";

function wikiPageId(path: string): string {
	return path.replace(/\.md$/i, "");
}

function wikiPageSummary(cwd: string, path: string): string {
	let text = "";
	try {
		text = readFileSync(join(cwd, ".clio-coder", "wiki", path), "utf8");
	} catch {
		return "Summary unavailable; read the page for details.";
	}
	return (
		readWikiPage({ pagePath: path, content: text, sourceRoot: cwd }).metadata.summary || "Read the page for details."
	);
}

function wikiPageCatalog(pages: ReadonlyArray<{ path: string; title: string }>): string {
	return pages.map((page) => `${wikiPageId(page.path)} (${page.title})`).join(", ");
}

function resolveWikiPage(
	pages: ReadonlyArray<{ path: string; title: string }>,
	query: string,
): { path: string; title: string } | { kind: "error"; message: string } {
	const needle = query.toLocaleLowerCase();
	const exact = pages.filter(
		(page) => wikiPageId(page.path).toLocaleLowerCase() === needle || page.title.toLocaleLowerCase() === needle,
	);
	const matches =
		exact.length > 0
			? exact
			: pages.filter(
					(page) =>
						wikiPageId(page.path).toLocaleLowerCase().includes(needle) || page.title.toLocaleLowerCase().includes(needle),
				);
	if (matches.length === 1 && matches[0]) return matches[0];
	const catalog = wikiPageCatalog(pages) || "none";
	if (matches.length === 0) {
		return { kind: "error", message: `code_nav: no wiki page matches '${query}'; pages are: ${catalog}` };
	}
	return {
		kind: "error",
		message: `code_nav: wiki query '${query}' is ambiguous; matching pages are: ${wikiPageCatalog(matches)}`,
	};
}

function runWiki(cwd: string, query: string): NavPayload | ToolResult {
	const meta = readWikiMeta(cwd);
	if (!meta) {
		if (query.length > 0) {
			return {
				kind: "error",
				message:
					`code_nav: no wiki page matches '${query}'; pages are: none; ` +
					`wiki generation is operator-only: run \`${WIKI_UPDATE_COMMAND}\``,
			};
		}
		return {
			payload: {
				pages: [],
				staleness: { state: "absent" },
				message: `no wiki exists; wiki generation is operator-only: run \`${WIKI_UPDATE_COMMAND}\``,
			},
			shownCount: 0,
			totalCount: 0,
		};
	}
	// The tree on disk is the wiki. Metadata is a record of the run that wrote
	// it, not a competing page list to fall back to.
	const onDiskPages = listWikiPages(cwd);
	const pages = onDiskPages;
	const staleness = wikiStaleness(cwd);
	const messages: string[] = [];
	if (staleness.state !== "fresh") {
		messages.push(`Wiki pages may be outdated; wiki regeneration is operator-only: run \`${WIKI_UPDATE_COMMAND}\`.`);
	}
	const owed = wikiCompletenessFromMeta(meta)?.owed ?? 0;
	if (owed > 0) {
		messages.push(
			`${owed} planned page${owed === 1 ? " is" : "s are"} await successful generation/validation; run \`${WIKI_UPDATE_COMMAND}\` to finish them.`,
		);
	}
	if (query.length > 0) {
		const resolved = resolveWikiPage(onDiskPages, query);
		if ("kind" in resolved) {
			return staleness.state === "fresh" ? resolved : { ...resolved, message: `${resolved.message}; ${messages[0]}` };
		}
		return {
			payload: {
				page: {
					id: wikiPageId(resolved.path),
					title: resolved.title,
					summary: wikiPageSummary(cwd, resolved.path),
					path: `.clio-coder/wiki/${resolved.path}`,
				},
				staleness,
				...(messages.length > 0 ? { message: messages.join(" ") } : {}),
			},
			shownCount: 1,
			totalCount: 1,
		};
	}
	return {
		payload: {
			pages,
			staleness,
			...(messages.length > 0 ? { message: messages.join(" ") } : {}),
		},
		shownCount: pages.length,
		totalCount: pages.length,
	};
}

const MODES: readonly string[] = ["symbol", "path", "entries", "outline", "deps", "dependents", "wiki", "project"];

function parseLimit(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.min(Math.floor(value), MAX_LIMIT);
	return fallback;
}

export const codeNavTool: ToolSpec = {
	...codeNavToolSurface,
	async run(args, options): Promise<ToolResult> {
		const rawSource = args.source;
		if (rawSource !== undefined && rawSource !== "workspace" && rawSource !== "clio") {
			return {
				kind: "error",
				message: `code_nav: source must be workspace or clio; got '${String(rawSource)}'`,
			};
		}
		const source: CodeNavSource = rawSource === "clio" ? "clio" : "workspace";
		const mode = typeof args.mode === "string" ? args.mode : "";
		if (source === "clio" && (mode === "wiki" || mode === "project")) {
			// Name clio_docs only where this run may call it, so the remedy never costs a refused call (bt-37).
			const admitted = [options?.allowedTools, options?.turnConstraints?.allowedTools].every(
				(tools) => tools === undefined || tools.includes(ToolNames.ClioDocs),
			);
			return {
				kind: "error",
				message: admitted
					? "code_nav: source=clio does not provide mode=wiki/project; use the clio_docs capability through gateway for CLIO Coder documentation"
					: "code_nav: source=clio does not provide mode=wiki/project, and CLIO Coder documentation is not available on this run",
			};
		}

		if (args.related !== undefined && typeof args.related !== "boolean") {
			return { kind: "error", message: `code_nav: related must be true or false; got '${String(args.related)}'` };
		}
		const related = args.related === true;
		if (related && mode !== "symbol" && mode !== "outline" && MODES.includes(mode)) {
			return {
				kind: "error",
				message: `code_nav: related=true applies only to mode=symbol or mode=outline; got mode=${mode}. Drop related, or use mode=outline related=true query=<exact path>.`,
			};
		}

		const query = typeof args.query === "string" ? args.query.trim() : "";
		const limit = parseLimit(
			args.limit,
			related ? DEFAULT_RELATED_LIMIT : mode === "entries" ? DEFAULT_ENTRY_LIMIT : DEFAULT_LIMIT,
		);
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
		// The index load below awaits, so charge the cap now: parallel siblings
		// reserving meanwhile must see this spend. Finalize reconciles it to the
		// bytes returned and the finally block refunds every error return.
		commitObservationReservation(reservation);
		try {
			let grammarNote: string | undefined;
			const present = (nav: NavPayload): { payload: Record<string, unknown>; next: string | undefined } => {
				const next = source === "clio" && nav.next !== undefined ? `source=clio ${nav.next}` : nav.next;
				const paged = next === nav.next ? nav.payload : { ...nav.payload, next };
				return { payload: grammarNote !== undefined ? { ...paged, grammarNote } : paged, next };
			};
			// Builders shrink to the payload as returned, grammar note and source prefix included.
			const fits: NavFits = (nav) => byteLength(renderJson(present(nav).payload)) <= reservation.callCapBytes;
			// The offload is named by its text's digest, so finalize, given the same text, records this very path.
			const fit: NavFit = {
				fits,
				offload: (nav) => {
					const text = renderJson(present(nav).payload);
					return { text, path: writeToolOffload(text, options) };
				},
			};
			const close = (nav: NavPayload | ToolResult): ToolResult => {
				if ("kind" in nav) return nav;
				const { payload, next } = present(nav);
				return finalizeObservation({
					tool: ToolNames.CodeNav,
					unit: "results",
					format: "json",
					output: renderJson(payload),
					...(nav.fullOutput !== undefined ? { fullOutput: nav.fullOutput } : {}),
					shownCount: nav.shownCount,
					totalCount: nav.totalCount,
					truncated: nav.shownCount < nav.totalCount,
					...(next !== undefined ? { next } : {}),
					reservation,
					...(options ? { options } : {}),
				});
			};
			if (!MODES.includes(mode))
				return {
					kind: "error",
					message: `code_nav: mode must be symbol, path, entries, outline, deps, dependents, wiki, or project; got '${mode}'`,
				};
			if (mode === "wiki") return close(runWiki(process.cwd(), query));
			const loaded = await loadNavSource(source);
			if (mode === "project") {
				const { readProjectStatus } = await import("../../domains/context/project-status.js");
				return close({
					payload: await readProjectStatus(
						process.cwd(),
						loaded.ok && loaded.loaded.fingerprint
							? { codewiki: loaded.loaded.codewiki, fingerprint: loaded.loaded.fingerprint }
							: undefined,
						loaded.ok ? undefined : loaded.message,
					),
					shownCount: 1,
					totalCount: 1,
				});
			}
			if (!loaded.ok) return { kind: "error", message: loaded.message };
			const index = navIndexFor(loaded.loaded.codewiki);
			// Symbol and outline answers depend on how files were parsed; a symbol
			// search spans every language in the index, an outline only its file's.
			if (source === "workspace" && (mode === "symbol" || mode === "outline")) {
				const outlined = mode === "outline" ? resolveFile(index, query) : null;
				grammarNote = missingGrammarNote(
					outlined === null ? loaded.loaded.codewiki.files : "error" in outlined ? [] : [outlined],
				);
			}
			const sourcePrefix = source === "clio" ? "source=clio " : "";
			if (mode === "symbol") {
				if (query.length === 0) return { kind: "error", message: "code_nav: mode=symbol requires query" };
				if (related) return close(runSymbolRelated(index, query, limit, fits, sourcePrefix));
				return close(runSymbol(index, query, limit, fit));
			}
			if (mode === "path") {
				if (query.length === 0) return { kind: "error", message: "code_nav: mode=path requires query" };
				return close(runPath(index, query, limit, fit));
			}
			if (mode === "entries") return close(runEntries(index, limit, loaded.loaded.entryRoot, fit));
			if (mode === "outline") {
				if (query.length === 0) return { kind: "error", message: "code_nav: mode=outline requires query path" };
				if (related) return close(runOutlineRelated(index, query, limit, fits, sourcePrefix));
				return close(runOutline(index, query, limit, fit));
			}
			if (mode === "deps") {
				if (query.length === 0) return { kind: "error", message: "code_nav: mode=deps requires query path" };
				return close(runDeps(index, query, limit, fit));
			}
			if (mode === "dependents") {
				if (query.length === 0) return { kind: "error", message: "code_nav: mode=dependents requires query path" };
				return close(runDependents(index, query, limit, fit));
			}
			return {
				kind: "error",
				message: `code_nav: mode must be symbol, path, entries, outline, deps, dependents, wiki, or project; got '${mode}'`,
			};
		} finally {
			releaseObservation(reservation);
		}
	},
};
