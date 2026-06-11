import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import type { CodewikiEntry } from "../../domains/context/codewiki/indexer.js";
import { compileGlobRegex } from "../glob.js";
import type { ToolResult, ToolSpec } from "../registry.js";
import { stringEnum } from "../string-enum.js";
import { loadCodewikiForTool, renderEntries } from "./shared.js";

const REGEX_SYNTAX_HINTS = /\.\*|\.\+|\^|\$|\\[dDwWsSbB]|\(\?:|\(\?=|\(\?!/;
const DEFAULT_ENTRY_LIMIT = 25;
const MAX_ENTRY_LIMIT = 200;

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
		.replace(/^\.\/+/, "")
		.replace(/^dist\//, "src/")
		.replace(/\.js$/, ".ts");
}

function isEntry(entry: CodewikiEntry, packageEntries: ReadonlySet<string>): boolean {
	if (packageEntries.has(entry.path)) return true;
	if (entry.kind === "entry-point") return true;
	return /(^|\/)(index|main|cli|orchestrator|bootstrap)\.tsx?$/.test(entry.path);
}

function runSymbol(entries: ReadonlyArray<CodewikiEntry>, query: string): ToolResult {
	const matches = entries.filter((entry) => entry.exports.includes(query));
	return { kind: "ok", output: renderEntries(matches) };
}

function runPath(entries: ReadonlyArray<CodewikiEntry>, query: string): ToolResult {
	const regex = regexFromPattern(query);
	const matches = entries.filter((entry) => (regex ? regex.test(entry.path) : entry.path.includes(query)));
	if (matches.length === 0) {
		return {
			kind: "ok",
			output: `${renderEntries(matches)}\n[no matches; codewiki indexes only .ts/.tsx paths — broaden the pattern, switch glob/regex/substring syntax, or use glob]`,
		};
	}
	return { kind: "ok", output: renderEntries(matches) };
}

function runEntries(entries: ReadonlyArray<CodewikiEntry>, limitArg: unknown): ToolResult {
	const cwd = process.cwd();
	const packageEntries = readPackageEntryPaths(cwd);
	const candidates = entries.filter((entry) => isEntry(entry, packageEntries));
	const limit =
		typeof limitArg === "number" && Number.isFinite(limitArg) && limitArg > 0
			? Math.min(Math.floor(limitArg), MAX_ENTRY_LIMIT)
			: DEFAULT_ENTRY_LIMIT;
	// Manifest-declared entries are the strongest signal; surface them first
	// so a small default limit never drops package.json main/bin targets.
	const ranked = [...candidates].sort((a, b) => {
		const aPkg = packageEntries.has(a.path) ? 0 : 1;
		const bPkg = packageEntries.has(b.path) ? 0 : 1;
		return aPkg === bPkg ? a.path.localeCompare(b.path) : aPkg - bPkg;
	});
	const limited = ranked.slice(0, limit);
	const omitted = ranked.length - limited.length;
	const output =
		omitted > 0
			? `${renderEntries(limited)}\n[${omitted} more entries omitted; pass limit up to ${MAX_ENTRY_LIMIT} for more]`
			: renderEntries(limited);
	return { kind: "ok", output };
}

export const codeNavTool: ToolSpec = {
	name: ToolNames.CodeNav,
	description:
		"Navigate the indexed TypeScript codewiki: mode=symbol finds modules exporting a symbol, mode=path finds modules by glob/regex/substring, mode=entries lists likely entry points.",
	parameters: Type.Object({
		mode: stringEnum(["symbol", "path", "entries"], "Lookup mode."),
		query: Type.Optional(Type.String({ description: "Exported symbol (mode=symbol) or path pattern (mode=path)." })),
		limit: Type.Optional(Type.Number({ description: `mode=entries: max results (default ${DEFAULT_ENTRY_LIMIT}).` })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args): Promise<ToolResult> {
		const mode = typeof args.mode === "string" ? args.mode : "";
		const loaded = loadCodewikiForTool();
		if (!loaded.ok) return { kind: "error", message: loaded.message };
		const entries = loaded.codewiki.entries;
		const query = typeof args.query === "string" ? args.query.trim() : "";
		if (mode === "symbol") {
			if (query.length === 0)
				return { kind: "error", message: "code_nav: mode=symbol requires query (an exported symbol name)" };
			return runSymbol(entries, query);
		}
		if (mode === "path") {
			if (query.length === 0) {
				return {
					kind: "error",
					message: "code_nav: mode=path requires query (glob like src/cli/*.ts, regex like ^src/cli/, or substring)",
				};
			}
			return runPath(entries, query);
		}
		if (mode === "entries") {
			return runEntries(entries, args.limit);
		}
		return { kind: "error", message: `code_nav: mode must be symbol, path, or entries; got '${mode}'` };
	},
};
