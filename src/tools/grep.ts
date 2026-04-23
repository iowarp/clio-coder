import { lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { compileGlobRegex, normalizeGlobInput } from "./glob.js";
import type { ToolResult, ToolSpec } from "./registry.js";

const MAX_MATCHES = 100;
const MAX_DEPTH = 8;

interface FileEntry {
	absPath: string;
	relPath: string;
	baseName: string;
}

function parseContext(value: unknown): number | null {
	if (value === undefined) return 0;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return null;
	}
	return Math.floor(value);
}

function walkFiles(root: string, current: string, depth: number, out: FileEntry[]): void {
	if (depth > MAX_DEPTH) return;

	const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		const absPath = path.join(current, entry.name);
		const stat = lstatSync(absPath);
		if (stat.isDirectory() && !stat.isSymbolicLink()) {
			walkFiles(root, absPath, depth + 1, out);
			continue;
		}
		if (stat.isFile()) {
			out.push({
				absPath,
				relPath: normalizeGlobInput(path.relative(root, absPath)),
				baseName: entry.name,
			});
		}
	}
}

export const grepTool: ToolSpec = {
	name: ToolNames.Grep,
	description:
		"Search files under a path with a JS regex and optional glob filter, returning file:line: content matches.",
	parameters: Type.Object(
		{
			pattern: Type.String({ description: "JavaScript RegExp pattern (no leading slash)." }),
			path: Type.Optional(Type.String({ description: "Root directory to search. Defaults to the orchestrator cwd." })),
			glob: Type.Optional(
				Type.String({ description: "Glob filter for file paths (e.g. **/*.ts). Omit to include every file." }),
			),
			context: Type.Optional(
				Type.Number({ description: "Lines of surrounding context per match. Must be >= 0. Defaults to 0." }),
			),
		},
		{ additionalProperties: false },
	),
	baseActionClass: "read",
	async run(args): Promise<ToolResult> {
		const patternArg = typeof args.pattern === "string" ? args.pattern : null;
		if (!patternArg) {
			return { kind: "error", message: "grep: missing pattern argument" };
		}

		const context = parseContext(args.context);
		if (context === null) {
			return { kind: "error", message: "grep: context must be a non-negative number" };
		}

		const rootArg = typeof args.path === "string" ? args.path : process.cwd();
		const root = path.resolve(rootArg);

		let rootStat: Stats;
		try {
			rootStat = lstatSync(root);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `grep: ${msg}` };
		}

		if (!rootStat.isDirectory()) {
			return { kind: "error", message: `grep: not a directory: ${root}` };
		}

		let matcher: RegExp;
		try {
			matcher = new RegExp(patternArg);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `grep: invalid pattern: ${msg}` };
		}

		let fileFilter: RegExp | null = null;
		let filterMode: "absolute" | "relative" | "basename" = "basename";
		if (typeof args.glob === "string" && args.glob.length > 0) {
			try {
				fileFilter = compileGlobRegex(args.glob);
				if (path.isAbsolute(args.glob)) {
					filterMode = "absolute";
				} else if (normalizeGlobInput(args.glob).includes("/")) {
					filterMode = "relative";
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { kind: "error", message: `grep: ${msg}` };
			}
		}

		const files: FileEntry[] = [];
		try {
			walkFiles(root, root, 0, files);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `grep: ${msg}` };
		}

		const output: string[] = [];
		let matches = 0;
		let truncated = false;

		for (const file of files) {
			if (fileFilter) {
				const candidate =
					filterMode === "absolute"
						? normalizeGlobInput(file.absPath)
						: filterMode === "relative"
							? file.relPath
							: file.baseName;
				if (!fileFilter.test(candidate)) continue;
			}

			let text: string;
			try {
				text = readFileSync(file.absPath, "utf8");
			} catch {
				continue;
			}

			const lines = text.split(/\r?\n/);
			let emittedUntil = -1;
			for (let i = 0; i < lines.length; i += 1) {
				if (!matcher.test(lines[i] ?? "")) continue;
				matches += 1;
				if (matches > MAX_MATCHES) {
					truncated = true;
					break;
				}

				const start = Math.max(0, i - context, emittedUntil + 1);
				const end = Math.min(lines.length - 1, i + context);
				for (let lineIndex = start; lineIndex <= end; lineIndex += 1) {
					output.push(`${file.absPath}:${lineIndex + 1}: ${lines[lineIndex] ?? ""}`);
				}
				emittedUntil = Math.max(emittedUntil, end);
			}

			if (truncated) break;
		}

		if (output.length === 0 && !truncated) {
			return { kind: "ok", output: "no matches" };
		}

		if (truncated) {
			output.push("[more results truncated]");
		}

		return { kind: "ok", output: output.join("\n") };
	},
};
