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
	if (entry.role && /entry|main|bootstrap|cli/i.test(entry.role)) return true;
	return /(^|\/)(index|main|cli|orchestrator|bootstrap)\.tsx?$/.test(entry.path);
}

export const entryPointsTool: ToolSpec = {
	name: ToolNames.EntryPoints,
	description: "Return likely project entry points from the codewiki index.",
	parameters: Type.Object({}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(): Promise<ToolResult> {
		const cwd = process.cwd();
		const loaded = loadCodewikiForTool(cwd);
		if (!loaded.ok) return { kind: "error", message: loaded.message };
		const packageEntries = readPackageEntryPaths(cwd);
		const entries = loaded.codewiki.entries.filter((entry) => isEntry(entry, packageEntries));
		return { kind: "ok", output: renderEntries(entries) };
	},
};
