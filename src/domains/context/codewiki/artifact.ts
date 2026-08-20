import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import type { ProjectType } from "../../session/workspace/project-type.js";
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

function stableFileId(path: string): string {
	return `f_${createHash("sha256").update(path).digest("hex").slice(0, 16)}`;
}

function languageForLegacyPath(path: string): CodewikiLanguage | null {
	if (path.endsWith(".d.ts")) return null;
	const extension = path.slice(path.lastIndexOf("."));
	const source = new Map<string, Exclude<CodewikiLanguage, "config">>([
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
	]).get(extension);
	if (source) return source;
	const name = path.split("/").pop() ?? path;
	return new Set([
		"package.json",
		"pyproject.toml",
		"setup.py",
		"Cargo.toml",
		"go.mod",
		"pom.xml",
		"CMakeLists.txt",
		"compile_commands.json",
		"Gemfile",
	]).has(name) ||
		name.endsWith(".csproj") ||
		name.toLowerCase().endsWith(".cmake")
		? "config"
		: null;
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
	return { name: symbol.name, kind: symbol.kind, fileId: symbol.fileId, line: symbol.line, ...(sig ? { sig } : {}) };
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
				role: file.role,
				hash: file.hash,
				imports: uniqueSorted(file.imports),
				...(file.summary ? { summary: file.summary } : {}),
			}))
			.sort(compareFiles),
		symbols: codewiki.symbols.map(normalizeSymbol).sort(compareSymbols),
		edges: [...codewiki.edges].sort(compareEdges),
	};
}

export function codewikiPath(cwd: string): string {
	return join(cwd, ".clio-coder", "codewiki.json");
}
export function serializeCodewiki(codewiki: Codewiki): string {
	return `${JSON.stringify(normalizeCodewiki(codewiki))}\n`;
}
export function writeCodewiki(cwd: string, codewiki: Codewiki): string {
	const serialized = serializeCodewiki(codewiki);
	safeResourceWrite(codewikiPath(cwd), serialized, { encoding: "utf8" });
	return serialized;
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

function upgradeV3(value: CodewikiV3): Codewiki {
	return normalizeCodewiki({
		version: CODEWIKI_VERSION,
		language: value.language,
		files: value.files.map((file) => ({ ...file, hash: "", imports: [] })),
		symbols: value.symbols,
		edges: value.edges,
	});
}
function upgradeV4(value: CodewikiV4): Codewiki {
	return normalizeCodewiki({
		version: CODEWIKI_VERSION,
		language: value.language,
		files: value.files.map((file) => ({ ...file, hash: "" })),
		symbols: value.symbols,
		edges: value.edges,
	});
}
function upgradeV2(value: CodewikiV2): Codewiki {
	const files: CodewikiFileV3[] = value.entries.map((entry) => ({
		id: stableFileId(entry.path),
		path: entry.path,
		lang:
			languageForLegacyPath(entry.path) ??
			(value.language === "unknown" || value.language === "polyglot" || value.language === "dotfiles"
				? "config"
				: value.language),
		loc: 0,
		role: entry.kind === "entry-point" ? "entry" : entry.kind === "test" ? "test" : "module",
	}));
	const ids = new Map(files.map((file) => [file.path, file.id] as const));
	const symbols = value.entries
		.flatMap((entry) =>
			entry.exports.map((name) => ({ name, kind: "const" as const, fileId: ids.get(entry.path) ?? "", line: 1 })),
		)
		.filter((symbol) => symbol.fileId);
	const edges = value.entries
		.flatMap((entry) =>
			entry.imports.map((item): CodewikiEdge => {
				const fileId = ids.get(entry.path) ?? "";
				const toFileId = ids.get(item);
				return toFileId ? { fileId, toFileId } : { fileId, externalModule: item };
			}),
		)
		.filter((edge) => edge.fileId);
	return upgradeV3({ version: 3, language: value.language, files, symbols, edges });
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
function validFile(value: unknown, hash: boolean): boolean {
	const item = object(value);
	if (!item) return false;
	return (
		typeof item.id === "string" &&
		typeof item.path === "string" &&
		typeof item.lang === "string" &&
		LANGUAGES.has(item.lang as CodewikiLanguage) &&
		Number.isInteger(item.loc) &&
		(item.loc as number) >= 0 &&
		typeof item.role === "string" &&
		ROLES.has(item.role as CodewikiFileRole) &&
		(!hash ||
			(typeof item.hash === "string" &&
				Array.isArray(item.imports) &&
				item.imports.every((v) => typeof v === "string"))) &&
		(!("summary" in item) || typeof item.summary === "string")
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
		(!("sig" in item) || typeof item.sig === "string")
	);
}
function validEdge(value: unknown): boolean {
	const item = object(value);
	if (!item || typeof item.fileId !== "string") return false;
	return (typeof item.toFileId === "string") !== (typeof item.externalModule === "string");
}
function validEntry(value: unknown): boolean {
	const item = object(value);
	if (!item || typeof item.path !== "string") return false;
	return (
		Array.isArray(item.exports) &&
		item.exports.every((v) => typeof v === "string") &&
		Array.isArray(item.imports) &&
		item.imports.every((v) => typeof v === "string") &&
		(item.kind === "entry-point" || item.kind === "test" || item.kind === "module") &&
		(!("summary" in item) || typeof item.summary === "string")
	);
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
		item.files.every((v) => validFile(v, true)) &&
		Array.isArray(item.symbols) &&
		item.symbols.every(validSymbol) &&
		Array.isArray(item.edges) &&
		item.edges.every(validEdge) &&
		validNative(item as unknown as Codewiki)
	)
		return normalizeCodewiki(item as unknown as Codewiki);
	if (
		item.version === 4 &&
		Array.isArray(item.files) &&
		item.files.every((v) => validFile(v, true)) &&
		Array.isArray(item.symbols) &&
		item.symbols.every(validSymbol) &&
		Array.isArray(item.edges) &&
		item.edges.every(validEdge)
	)
		return upgradeV4(item as unknown as CodewikiV4);
	if (
		item.version === 3 &&
		Array.isArray(item.files) &&
		item.files.every((v) => validFile(v, false)) &&
		Array.isArray(item.symbols) &&
		item.symbols.every(validSymbol) &&
		Array.isArray(item.edges) &&
		item.edges.every(validEdge)
	)
		return upgradeV3(item as unknown as CodewikiV3);
	if (
		item.version === 2 &&
		typeof item.generatedAt === "string" &&
		Array.isArray(item.entries) &&
		item.entries.every(validEntry)
	)
		return upgradeV2(item as unknown as CodewikiV2);
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
export async function readCodewikiAsync(cwd: string): Promise<Codewiki | null> {
	try {
		return parseCodewikiRaw(await readFile(codewikiPath(cwd), "utf8"));
	} catch {
		return null;
	}
}
export function codewikiNeedsBackfill(codewiki: Codewiki): boolean {
	return codewiki.files.some((file) => file.lang !== "config" && file.hash.length === 0);
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
