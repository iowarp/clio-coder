import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { resolveRgBinary } from "./executables.js";
import { resolveToCwd } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { DEFAULT_MAX_BYTES, formatSize, GREP_MAX_LINE_LENGTH, truncateHead, truncateLine } from "./truncate.js";

const DEFAULT_LIMIT = 100;
const CLIO_EXCLUDE_GLOBS = ["!**/.clio/**", "!**/.fallow/**", "!**/node_modules/**", "!**/dist/**", "!**/build/**"];

function parseContext(value: unknown): number | null {
	if (value === undefined) return 0;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
	return Math.floor(value);
}

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

function formatPath(filePath: string, searchPath: string, isDirectory: boolean): string {
	if (isDirectory) {
		const relativePath = path.relative(searchPath, filePath);
		if (relativePath && !relativePath.startsWith("..")) return toPosixPath(relativePath);
	}
	return path.basename(filePath);
}

function statIsDirectory(searchPath: string): { ok: true; isDirectory: boolean } | { ok: false; message: string } {
	try {
		return { ok: true, isDirectory: statSync(searchPath).isDirectory() };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, message };
	}
}

interface Match {
	filePath: string;
	lineNumber: number;
	lineText?: string;
}

async function runRipgrep(input: {
	rgPath: string;
	pattern: string;
	searchPath: string;
	isDirectory: boolean;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context: number;
	limit: number;
	signal?: AbortSignal;
}): Promise<ToolResult> {
	const args = ["--json", "--line-number", "--color=never", "--hidden"];
	for (const exclude of CLIO_EXCLUDE_GLOBS) args.push("--glob", exclude);
	if (input.ignoreCase) args.push("--ignore-case");
	if (input.literal) args.push("--fixed-strings");
	if (input.glob) args.push("--glob", input.glob);
	args.push("--", input.pattern, input.searchPath);

	return new Promise((resolve) => {
		const child = spawn(input.rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
		const rl = createInterface({ input: child.stdout });
		const matches: Match[] = [];
		const fileCache = new Map<string, string[]>();
		let stderr = "";
		let matchLimitReached = false;
		let killedDueToLimit = false;
		let linesTruncated = false;
		let settled = false;

		const finish = (result: ToolResult): void => {
			if (settled) return;
			settled = true;
			rl.close();
			input.signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const stopChild = (dueToLimit = false): void => {
			if (!child.killed) {
				killedDueToLimit = dueToLimit;
				child.kill();
			}
		};
		const onAbort = (): void => {
			stopChild();
			finish({ kind: "error", message: "grep: operation aborted" });
		};
		input.signal?.addEventListener("abort", onAbort, { once: true });

		const getFileLines = (filePath: string): string[] => {
			let lines = fileCache.get(filePath);
			if (!lines) {
				try {
					lines = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
				} catch {
					lines = [];
				}
				fileCache.set(filePath, lines);
			}
			return lines;
		};

		const formatBlock = (match: Match): string[] => {
			const relativePath = formatPath(match.filePath, input.searchPath, input.isDirectory);
			if (input.context === 0 && match.lineText !== undefined) {
				const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
				const { text, wasTruncated } = truncateLine(sanitized);
				if (wasTruncated) linesTruncated = true;
				return [`${relativePath}:${match.lineNumber}: ${text}`];
			}
			const lines = getFileLines(match.filePath);
			if (lines.length === 0) return [`${relativePath}:${match.lineNumber}: (unable to read file)`];
			const block: string[] = [];
			const start = input.context > 0 ? Math.max(1, match.lineNumber - input.context) : match.lineNumber;
			const end = input.context > 0 ? Math.min(lines.length, match.lineNumber + input.context) : match.lineNumber;
			for (let current = start; current <= end; current += 1) {
				const lineText = (lines[current - 1] ?? "").replace(/\r/g, "");
				const { text, wasTruncated } = truncateLine(lineText);
				if (wasTruncated) linesTruncated = true;
				block.push(
					current === match.lineNumber ? `${relativePath}:${current}: ${text}` : `${relativePath}-${current}- ${text}`,
				);
			}
			return block;
		};

		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		rl.on("line", (line) => {
			if (!line.trim() || matches.length >= input.limit) return;
			let event: unknown;
			try {
				event = JSON.parse(line) as unknown;
			} catch {
				return;
			}
			if (!event || typeof event !== "object" || (event as { type?: unknown }).type !== "match") return;
			const data = (event as { data?: Record<string, unknown> }).data;
			const filePath = (data?.path as { text?: unknown } | undefined)?.text;
			const lineNumber = data?.line_number;
			const lineText = (data?.lines as { text?: unknown } | undefined)?.text;
			if (typeof filePath !== "string" || typeof lineNumber !== "number") return;
			const match: Match = { filePath, lineNumber };
			if (typeof lineText === "string") match.lineText = lineText;
			matches.push(match);
			if (matches.length >= input.limit) {
				matchLimitReached = true;
				stopChild(true);
			}
		});
		child.on("error", (error) => finish({ kind: "error", message: `grep: failed to run rg: ${error.message}` }));
		child.on("close", (code) => {
			if (input.signal?.aborted) {
				finish({ kind: "error", message: "grep: operation aborted" });
				return;
			}
			if (!killedDueToLimit && code !== 0 && code !== 1) {
				finish({ kind: "error", message: `grep: ${stderr.trim() || `ripgrep exited with code ${code}`}` });
				return;
			}
			if (matches.length === 0) {
				finish({ kind: "ok", output: "No matches found" });
				return;
			}
			const rawOutput = matches.flatMap(formatBlock).join("\n");
			const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			const details: Record<string, unknown> = {};
			const notices: string[] = [];
			if (matchLimitReached) {
				notices.push(`${input.limit} matches limit reached. Use limit=${input.limit * 2} for more, or refine pattern`);
				details.matchLimitReached = input.limit;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}
			if (linesTruncated) {
				notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
				details.linesTruncated = true;
			}
			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
			finish({ kind: "ok", output, ...(Object.keys(details).length > 0 ? { details } : {}) });
		});
	});
}

export const grepTool: ToolSpec = {
	name: ToolNames.Grep,
	description: `Search file contents for a pattern using ripgrep. Returns matching lines with file paths and line numbers. Respects .gitignore and skips Clio cache directories. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB.`,
	parameters: Type.Object({
		pattern: Type.String({ description: "Search pattern (regex by default)." }),
		path: Type.Optional(Type.String({ description: "Directory or file to search. Defaults to the orchestrator cwd." })),
		glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'." })),
		ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search. Defaults to false." })),
		literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal text instead of regex." })),
		context: Type.Optional(Type.Number({ description: "Lines of surrounding context per match. Defaults to 0." })),
		limit: Type.Optional(Type.Number({ description: "Maximum number of matches. Defaults to 100." })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args, options): Promise<ToolResult> {
		const pattern = typeof args.pattern === "string" && args.pattern.length > 0 ? args.pattern : null;
		if (!pattern) return { kind: "error", message: "grep: missing pattern argument" };
		const context = parseContext(args.context);
		if (context === null) return { kind: "error", message: "grep: context must be a non-negative number" };
		const searchPath = resolveToCwd(typeof args.path === "string" && args.path.length > 0 ? args.path : ".");
		const stat = statIsDirectory(searchPath);
		if (!stat.ok) return { kind: "error", message: `grep: ${stat.message}` };
		const rgPath = resolveRgBinary();
		if (!rgPath) return { kind: "error", message: "grep: ripgrep (rg) is not available on PATH" };
		return runRipgrep({
			rgPath,
			pattern,
			searchPath,
			isDirectory: stat.isDirectory,
			...(typeof args.glob === "string" && args.glob.length > 0 ? { glob: args.glob } : {}),
			ignoreCase: args.ignoreCase === true,
			literal: args.literal === true,
			context,
			limit: typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_LIMIT,
			...(options?.signal ? { signal: options.signal } : {}),
		});
	},
};
