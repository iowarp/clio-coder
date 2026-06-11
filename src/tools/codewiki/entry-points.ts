import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import type { CodewikiEntry } from "../../domains/context/codewiki/indexer.js";
import type { ToolResult, ToolSpec } from "../registry.js";
import { loadCodewikiForTool, renderEntries } from "./shared.js";

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

const DEFAULT_ENTRY_LIMIT = 25;
const MAX_ENTRY_LIMIT = 200;

export const entryPointsTool: ToolSpec = {
	name: ToolNames.EntryPoints,
	description:
		"Return likely project entry points from the codewiki index. Use this tool to locate main entry points or initialization routes in the codebase.",
	parameters: Type.Object({
		limit: Type.Optional(
			Type.Number({
				description: `Maximum entries returned. Default: ${DEFAULT_ENTRY_LIMIT}, max: ${MAX_ENTRY_LIMIT}. Package-manifest entries rank first.`,
			}),
		),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args): Promise<ToolResult> {
		const cwd = process.cwd();
		const loaded = loadCodewikiForTool(cwd);
		if (!loaded.ok) return { kind: "error", message: loaded.message };
		const packageEntries = readPackageEntryPaths(cwd);
		const entries = loaded.codewiki.entries.filter((entry) => isEntry(entry, packageEntries));
		const limit =
			typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
				? Math.min(Math.floor(args.limit), MAX_ENTRY_LIMIT)
				: DEFAULT_ENTRY_LIMIT;
		// Manifest-declared entries are the strongest signal; surface them first
		// so a small default limit never drops package.json main/bin targets.
		const ranked = [...entries].sort((a, b) => {
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
	},
};
