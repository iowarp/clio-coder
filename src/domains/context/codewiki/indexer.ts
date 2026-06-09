import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import * as ts from "typescript";
import type { ProjectType } from "../../session/workspace/project-type.js";

export interface CodewikiEntry {
	path: string;
	exports: string[];
	imports: string[];
	kind: "entry-point" | "test" | "module";
	summary?: string;
}

export interface Codewiki {
	version: 2;
	generatedAt: string;
	language: ProjectType;
	entries: CodewikiEntry[];
}

export interface BuildCodewikiInput {
	cwd: string;
	language: ProjectType;
	generatedAt?: string;
}

const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build", ".clio", ".venv", "target"]);
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx"]);

function normalizeRel(cwd: string, filePath: string): string {
	return relative(cwd, filePath).split("\\").join("/");
}

function extensionOf(name: string): string {
	const index = name.lastIndexOf(".");
	return index === -1 ? "" : name.slice(index);
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
		if (!TYPESCRIPT_EXTENSIONS.has(extensionOf(entry.name))) continue;
		if (entry.name.endsWith(".d.ts")) continue;
		out.push(normalizeRel(cwd, absPath));
	}
}

function hasExportModifier(node: ts.HasModifiers): boolean {
	return Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function hasDefaultModifier(node: ts.HasModifiers): boolean {
	return Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
}

function addName(target: Set<string>, name: string | undefined): void {
	if (!name || name.length === 0) return;
	target.add(name);
}

function exportedNames(source: ts.SourceFile): string[] {
	const names = new Set<string>();
	for (const node of source.statements) {
		if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
			if (!hasExportModifier(node)) continue;
			if (hasDefaultModifier(node)) names.add("default");
			addName(names, node.name?.text);
			continue;
		}
		if (ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
			if (hasExportModifier(node)) addName(names, node.name.text);
			continue;
		}
		if (ts.isVariableStatement(node) && hasExportModifier(node)) {
			for (const declaration of node.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) addName(names, declaration.name.text);
			}
			continue;
		}
		if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
			for (const element of node.exportClause.elements) addName(names, element.name.text);
			continue;
		}
		if (ts.isExportAssignment(node)) names.add("default");
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

function resolveImport(cwd: string, fromRel: string, specifier: string): string | null {
	if (!specifier.startsWith(".")) return null;
	const fromDir = dirname(join(cwd, fromRel));
	const base = resolve(fromDir, specifier);
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		base.replace(/\.js$/, ".ts"),
		base.replace(/\.js$/, ".tsx"),
		join(base, "index.ts"),
		join(base, "index.tsx"),
	];
	for (const candidate of candidates) {
		try {
			if (statSync(candidate).isFile()) return normalizeRel(cwd, candidate);
		} catch {
			// try the next candidate
		}
	}
	return null;
}

function importEdges(cwd: string, relPath: string, source: ts.SourceFile): string[] {
	const imports = new Set<string>();
	for (const node of source.statements) {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			const resolved = resolveImport(cwd, relPath, node.moduleSpecifier.text);
			if (resolved) imports.add(resolved);
			continue;
		}
		if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			const resolved = resolveImport(cwd, relPath, node.moduleSpecifier.text);
			if (resolved) imports.add(resolved);
		}
	}
	return [...imports].sort((a, b) => a.localeCompare(b));
}

function firstJsDoc(text: string): string | null {
	const match = /\/\*\*([\s\S]*?)\*\//.exec(text);
	if (!match) return null;
	const cleaned = (match[1] ?? "")
		.split("\n")
		.map((line) => line.replace(/^\s*\*\s?/, "").trim())
		.filter((line) => line.length > 0 && !line.startsWith("@"))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > 0 ? cleaned.slice(0, 160) : null;
}

function kindFor(relPath: string): CodewikiEntry["kind"] {
	const lower = relPath.toLowerCase();
	if (/(^|\/)(index|main|cli|orchestrator|bootstrap)\.tsx?$/.test(lower)) return "entry-point";
	if (lower.includes("/test") || lower.endsWith(".test.ts") || lower.endsWith(".test.tsx")) return "test";
	return "module";
}

function isIndexablePath(relPath: string): boolean {
	if (relPath.endsWith(".d.ts")) return false;
	if (!TYPESCRIPT_EXTENSIONS.has(extensionOf(relPath))) return false;
	return !relPath.split("/").some((segment) => EXCLUDED_DIRS.has(segment));
}

/** Index one source file into a codewiki entry, or null if it is gone or unreadable. */
function buildEntry(cwd: string, relPath: string): CodewikiEntry | null {
	let text: string;
	try {
		text = readFileSync(join(cwd, relPath), "utf8");
	} catch {
		return null;
	}
	const source = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true);
	const entry: CodewikiEntry = {
		path: relPath,
		exports: exportedNames(source),
		imports: importEdges(cwd, relPath, source),
		kind: kindFor(relPath),
	};
	const summary = firstJsDoc(text);
	if (summary) entry.summary = summary;
	return entry;
}

export function buildCodewiki(input: BuildCodewikiInput): Codewiki {
	const files: string[] = [];
	walkFiles(input.cwd, input.cwd, files);
	files.sort((a, b) => a.localeCompare(b));
	const entries: CodewikiEntry[] = [];
	for (const relPath of files) {
		const entry = buildEntry(input.cwd, relPath);
		if (entry) entries.push(entry);
	}
	return {
		version: 2,
		generatedAt: input.generatedAt ?? new Date().toISOString(),
		language: input.language,
		entries,
	};
}

/**
 * Apply an in-place, incremental update for a set of changed paths without
 * re-walking the whole tree. Re-indexes indexable files that still exist, drops
 * entries for deleted or moved-away files, and keeps the entry list sorted.
 * Returns a new Codewiki (the input is not mutated). Cheap relative to a full
 * `buildCodewiki`: it parses only the changed files.
 */
export function updateCodewikiPaths(cwd: string, codewiki: Codewiki, paths: ReadonlyArray<string>): Codewiki {
	const byPath = new Map(codewiki.entries.map((entry) => [entry.path, entry] as const));
	let changed = false;
	for (const rawPath of paths) {
		const relPath = rawPath.split("\\").join("/").replace(/^\.\//, "");
		if (!isIndexablePath(relPath)) continue;
		const entry = buildEntry(cwd, relPath);
		if (entry) {
			byPath.set(relPath, entry);
			changed = true;
		} else if (byPath.delete(relPath)) {
			changed = true;
		}
	}
	if (!changed) return codewiki;
	const entries = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
	return { ...codewiki, generatedAt: new Date().toISOString(), entries };
}

export function codewikiPath(cwd: string): string {
	return join(cwd, ".clio", "codewiki.json");
}

export function writeCodewiki(cwd: string, codewiki: Codewiki): void {
	const filePath = codewikiPath(cwd);
	mkdirSync(dirname(filePath), { recursive: true });
	const tmpPath = join(dirname(filePath), `.codewiki-${process.pid}-${randomUUID()}.tmp`);
	writeFileSync(tmpPath, `${JSON.stringify(codewiki, null, 2)}\n`, "utf8");
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
	return isCodewiki(parsed) ? parsed : null;
}

function isCodewiki(value: unknown): value is Codewiki {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	if (obj.version !== 2 || typeof obj.generatedAt !== "string" || typeof obj.language !== "string") return false;
	if (!Array.isArray(obj.entries)) return false;
	return obj.entries.every(isCodewikiEntry);
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
