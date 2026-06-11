import { lstatSync, readdirSync, type Stats } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { resolveReadPath } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.js";

const MAX_RESULTS = 500;

interface WalkEntry {
	absPath: string;
	mtimeMs: number;
}

function escapeRegexChar(ch: string): string {
	return /[\\^$+?.()|{}]/.test(ch) ? `\\${ch}` : ch;
}

function escapeClassChar(ch: string): string {
	return /[\\\]^-]/.test(ch) ? `\\${ch}` : ch;
}

export function normalizeGlobInput(input: string): string {
	return input.replace(/\\/g, "/");
}

export function compileGlobRegex(pattern: string): RegExp {
	const normalized = normalizeGlobInput(pattern);
	if (normalized.length === 0) {
		throw new Error("glob: pattern must not be empty");
	}

	let regex = "^";
	for (let i = 0; i < normalized.length; ) {
		const ch = normalized[i];
		if (ch === undefined) break;

		if (ch === "*") {
			if (normalized[i + 1] === "*") {
				if (normalized[i + 2] === "/") {
					regex += "(?:.*\\/)?";
					i += 3;
					continue;
				}
				regex += ".*";
				i += 2;
				continue;
			}
			regex += "[^/]*";
			i += 1;
			continue;
		}

		if (ch === "?") {
			regex += "[^/]";
			i += 1;
			continue;
		}

		if (ch === "[") {
			const end = normalized.indexOf("]", i + 1);
			if (end === -1) {
				throw new Error(`glob: invalid pattern (unclosed character class): ${pattern}`);
			}
			const content = normalized.slice(i + 1, end);
			if (content.length === 0) {
				throw new Error(`glob: invalid pattern (empty character class): ${pattern}`);
			}
			regex += `[${Array.from(content).map(escapeClassChar).join("")}]`;
			i = end + 1;
			continue;
		}

		regex += escapeRegexChar(ch);
		i += 1;
	}

	regex += "$";
	return new RegExp(regex);
}

function walk(root: string, out: WalkEntry[]): void {
	const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		const absPath = path.join(root, entry.name);
		const stat = lstatSync(absPath);
		out.push({ absPath, mtimeMs: stat.mtimeMs });
		if (stat.isDirectory() && !stat.isSymbolicLink()) {
			walk(absPath, out);
		}
	}
}

export const globTool: ToolSpec = {
	name: ToolNames.Glob,
	description:
		"Find files and directories matching a glob (supports *, **, ?, [abc]). Returns paths relative to the search root, sorted by mtime descending.",
	parameters: Type.Object({
		pattern: Type.String({ description: "Glob pattern (*, **, ?, [abc])." }),
		path: Type.Optional(Type.String({ description: "Root directory to search from." })),
		limit: Type.Optional(Type.Number({ description: "Max results (default 500)." })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args): Promise<ToolResult> {
		const patternArg = typeof args.pattern === "string" ? args.pattern : null;
		if (!patternArg) {
			return { kind: "error", message: "glob: missing pattern argument" };
		}

		const rootArg = typeof args.path === "string" ? args.path : process.cwd();
		const root = resolveReadPath(rootArg);
		const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : MAX_RESULTS;

		let rootStat: Stats;
		try {
			rootStat = lstatSync(root);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `glob: ${msg}` };
		}

		if (!rootStat.isDirectory()) {
			return { kind: "error", message: `glob: not a directory: ${root}` };
		}

		let matcher: RegExp;
		try {
			matcher = compileGlobRegex(patternArg);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: msg.startsWith("glob:") ? msg : `glob: ${msg}` };
		}

		const entries: WalkEntry[] = [];
		try {
			walk(root, entries);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `glob: ${msg}` };
		}

		const useAbsolute = path.isAbsolute(patternArg);
		const matches = entries.filter((entry) => {
			const absPath = normalizeGlobInput(entry.absPath);
			if (useAbsolute) {
				return matcher.test(absPath);
			}
			const relPath = normalizeGlobInput(path.relative(root, entry.absPath));
			return matcher.test(relPath);
		});

		matches.sort((a, b) => {
			if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
			return a.absPath.localeCompare(b.absPath);
		});

		const resultLimitReached = matches.length > limit;
		const rawOutput = matches
			.slice(0, limit)
			.map((entry) => entry.absPath)
			.map((absPath) => normalizeGlobInput(path.relative(root, absPath)))
			.join("\n");
		const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
		const details: Record<string, unknown> = { root };
		const notices: string[] = [];
		if (resultLimitReached) {
			notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`);
			details.resultLimitReached = limit;
		}
		if (truncation.truncated) {
			notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
			details.truncation = truncation;
		}
		const output = notices.length > 0 ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;
		return { kind: "ok", output, ...(Object.keys(details).length > 0 ? { details } : {}) };
	},
};
