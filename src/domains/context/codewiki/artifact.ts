import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureProjectIgnore } from "../../../core/project-root.js";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { grammarNowCached } from "./fetched-grammars.js";
import {
	CODEWIKI_VERSION,
	type Codewiki,
	type CodewikiEdge,
	type CodewikiEntry,
	type CodewikiFile,
	type CodewikiFileRole,
	type CodewikiLanguage,
	type CodewikiSymbol,
	type CodewikiSymbolKind,
} from "./schema.js";

function uniqueSorted(values: Iterable<string>): string[] {
	return [...new Set([...values].filter((item) => item.length > 0))].sort((a, b) => a.localeCompare(b));
}

function compareFiles(a: CodewikiFile, b: CodewikiFile): number {
	return a.path.localeCompare(b.path);
}
function compareSymbols(a: CodewikiSymbol, b: CodewikiSymbol): number {
	return (
		a.fileId.localeCompare(b.fileId) || a.line - b.line || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind)
	);
}
function compareEdges(a: CodewikiEdge, b: CodewikiEdge): number {
	const file = a.fileId.localeCompare(b.fileId);
	if (file !== 0) return file;
	const left = "toFileId" in a ? a.toFileId : `~${a.externalModule}`;
	const right = "toFileId" in b ? b.toFileId : `~${b.externalModule}`;
	return left.localeCompare(right);
}

const SIG_KINDS = new Set<CodewikiSymbolKind>(["func", "class", "method", "type"]);
function normalizeSymbol(symbol: CodewikiSymbol): CodewikiSymbol {
	const sig = SIG_KINDS.has(symbol.kind) ? symbol.sig?.trim().slice(0, 240) : undefined;
	return {
		name: symbol.name,
		kind: symbol.kind,
		fileId: symbol.fileId,
		line: symbol.line,
		...(sig ? { sig } : {}),
		...(symbol.exported !== undefined ? { exported: symbol.exported } : {}),
	};
}
function normalizeCodewiki(codewiki: Codewiki): Codewiki {
	return {
		version: CODEWIKI_VERSION,
		language: codewiki.language,
		files: codewiki.files
			.map((file) => ({
				id: file.id,
				path: file.path,
				lang: file.lang,
				loc: file.loc,
				...(file.bytes !== undefined ? { bytes: file.bytes } : {}),
				role: file.role,
				hash: file.hash,
				imports: uniqueSorted(file.imports),
				...(file.summary ? { summary: file.summary } : {}),
				...(file.grammarMissing !== undefined ? { grammarMissing: file.grammarMissing } : {}),
			}))
			.sort(compareFiles),
		symbols: codewiki.symbols.map(normalizeSymbol).sort(compareSymbols),
		edges: [...codewiki.edges].sort(compareEdges),
	};
}

export function codewikiPath(cwd: string): string {
	return codemapPath(cwd);
}
export function codemapPath(cwd: string): string {
	return join(cwd, ".clio-coder", "codemap.json");
}
export function serializeCodewiki(codewiki: Codewiki): string {
	return `${JSON.stringify(normalizeCodewiki(codewiki))}\n`;
}
export function writeCodewiki(cwd: string, codewiki: Codewiki): string {
	const serialized = serializeCodewiki(codewiki);
	ensureProjectIgnore(cwd);
	safeResourceWrite(codemapPath(cwd), serialized, { encoding: "utf8" });
	return serialized;
}

const LANGUAGES = new Set<CodewikiLanguage>([
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
const ROLES = new Set<CodewikiFileRole>(["entry", "test", "module", "config"]);
const KINDS = new Set<CodewikiSymbolKind>(["func", "class", "method", "type", "const", "var", "trait", "iface"]);
function object(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
function validFile(value: unknown): boolean {
	const item = object(value);
	if (!item) return false;
	return (
		typeof item.id === "string" &&
		typeof item.path === "string" &&
		typeof item.lang === "string" &&
		LANGUAGES.has(item.lang as CodewikiLanguage) &&
		Number.isInteger(item.loc) &&
		(item.loc as number) >= 0 &&
		(!("bytes" in item) || (Number.isSafeInteger(item.bytes) && (item.bytes as number) >= 0)) &&
		typeof item.role === "string" &&
		ROLES.has(item.role as CodewikiFileRole) &&
		typeof item.hash === "string" &&
		Array.isArray(item.imports) &&
		item.imports.every((v) => typeof v === "string") &&
		(!("summary" in item) || typeof item.summary === "string") &&
		(!("grammarMissing" in item) || typeof item.grammarMissing === "boolean")
	);
}
function validSymbol(value: unknown): boolean {
	const item = object(value);
	if (!item) return false;
	return (
		typeof item.name === "string" &&
		typeof item.kind === "string" &&
		KINDS.has(item.kind as CodewikiSymbolKind) &&
		typeof item.fileId === "string" &&
		Number.isInteger(item.line) &&
		(item.line as number) >= 1 &&
		(!("sig" in item) || typeof item.sig === "string") &&
		(!("exported" in item) || typeof item.exported === "boolean")
	);
}
function validEdge(value: unknown): boolean {
	const item = object(value);
	if (!item || typeof item.fileId !== "string") return false;
	return (typeof item.toFileId === "string") !== (typeof item.externalModule === "string");
}
function validNative(value: Codewiki): boolean {
	const ids = new Set<string>();
	const paths = new Set<string>();
	const loc = new Map<string, number>();
	for (const file of value.files) {
		const segments = file.path.split("/");
		if (
			ids.has(file.id) ||
			paths.has(file.path) ||
			file.path.length === 0 ||
			file.path.includes("\0") ||
			file.path.includes("\\") ||
			file.path.startsWith("/") ||
			/^[A-Za-z]:\//.test(file.path) ||
			segments.some((part) => part.length === 0 || part === "." || part === "..") ||
			!/^[0-9a-f]{16}$/.test(file.hash)
		)
			return false;
		ids.add(file.id);
		paths.add(file.path);
		loc.set(file.id, file.loc);
	}
	for (const symbol of value.symbols) {
		const lines = loc.get(symbol.fileId);
		if (lines === undefined || symbol.line > lines) return false;
	}
	return value.edges.every((edge) => ids.has(edge.fileId) && (!("toFileId" in edge) || ids.has(edge.toFileId)));
}

function upgrade(value: unknown): Codewiki | null {
	const item = object(value);
	if (!item || typeof item.language !== "string") return null;
	if (
		item.version === 5 &&
		Array.isArray(item.files) &&
		item.files.every(validFile) &&
		Array.isArray(item.symbols) &&
		item.symbols.every(validSymbol) &&
		Array.isArray(item.edges) &&
		item.edges.every(validEdge) &&
		validNative(item as unknown as Codewiki)
	)
		return normalizeCodewiki(item as unknown as Codewiki);
	return null;
}

export function parseCodewikiRaw(raw: string): Codewiki | null {
	try {
		return upgrade(JSON.parse(raw));
	} catch {
		return null;
	}
}
export function readCodewiki(cwd: string): Codewiki | null {
	const path = codewikiPath(cwd);
	if (!existsSync(path)) return null;
	try {
		return parseCodewikiRaw(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}
/**
 * An artifact an unchanged fingerprint must not short-circuit: a file without
 * a content hash, or one indexed without the first-use grammar now cached.
 */
export function codewikiNeedsBackfill(codewiki: Codewiki): boolean {
	const reparse = grammarNowCached();
	return codewiki.files.some((file) => file.hash.length === 0 || reparse(file));
}
export function structuralCodewikiHash(codewiki: Codewiki): string {
	return createHash("sha256")
		.update(JSON.stringify(normalizeCodewiki(codewiki)))
		.digest("hex");
}
export function codewikiEntries(codewiki: Codewiki): CodewikiEntry[] {
	const files = new Map(codewiki.files.map((file) => [file.id, file] as const));
	const exports = new Map<string, string[]>();
	const imports = new Map<string, string[]>();
	for (const symbol of codewiki.symbols)
		exports.set(symbol.fileId, [...(exports.get(symbol.fileId) ?? []), symbol.name]);
	for (const edge of codewiki.edges) {
		const value = "toFileId" in edge ? files.get(edge.toFileId)?.path : edge.externalModule;
		if (value) imports.set(edge.fileId, [...(imports.get(edge.fileId) ?? []), value]);
	}
	return codewiki.files
		.filter((file) => file.lang !== "config")
		.map((file) => ({
			path: file.path,
			exports: uniqueSorted(exports.get(file.id) ?? []),
			imports: uniqueSorted(imports.get(file.id) ?? []),
			kind:
				file.role === "entry" ? ("entry-point" as const) : file.role === "test" ? ("test" as const) : ("module" as const),
			...(file.summary ? { summary: file.summary } : {}),
		}))
		.sort((a, b) => a.path.localeCompare(b.path));
}
