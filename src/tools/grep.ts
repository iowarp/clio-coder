import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path, { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { resolveRgBinary } from "./executables.js";
import { compileGlobRegex, normalizeGlobInput } from "./glob.js";
import { resolveReadPath } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { DEFAULT_MAX_BYTES, formatSize, GREP_MAX_LINE_LENGTH, truncateHead, truncateLine } from "./truncate.js";

const DEFAULT_LIMIT = 100;
const CLIO_EXCLUDE_GLOBS = ["!**/.clio/**", "!**/.fallow/**", "!**/node_modules/**", "!**/dist/**", "!**/build/**"];
// Directories the pure-Node fallback skips, mirroring the rg path's
// CLIO_EXCLUDE_GLOBS plus .git. rg respects .gitignore natively; the fallback
// cannot, so it skips these well-known heavy/generated trees to stay bounded.
const FALLBACK_IGNORED_DIRS = new Set([".clio", ".fallow", ".git", "build", "dist", "node_modules"]);
// Per-file read ceiling for the fallback. Matches the read tool's file cap; the
// fallback skips anything larger rather than pulling it fully into memory.
const FALLBACK_MAX_FILE_BYTES = 20_000_000;

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

// Shared rendering for both the ripgrep and pure-Node fallback paths: format
// each match (with optional context lines) as `path:line: text`, join, apply
// the same head truncation, and append match-limit / byte-limit / line-length
// notices. Keeps the two search backends byte-for-byte consistent in output.
function renderGrepMatches(input: {
	matches: Match[];
	searchPath: string;
	isDirectory: boolean;
	context: number;
	limit: number;
	matchLimitReached: boolean;
}): ToolResult {
	const { matches, searchPath, isDirectory, context, limit, matchLimitReached } = input;
	if (matches.length === 0) return { kind: "ok", output: "No matches found" };
	const fileCache = new Map<string, string[]>();
	let linesTruncated = false;

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
		const relativePath = formatPath(match.filePath, searchPath, isDirectory);
		if (context === 0 && match.lineText !== undefined) {
			const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
			const { text, wasTruncated } = truncateLine(sanitized);
			if (wasTruncated) linesTruncated = true;
			return [`${relativePath}:${match.lineNumber}: ${text}`];
		}
		const lines = getFileLines(match.filePath);
		if (lines.length === 0) return [`${relativePath}:${match.lineNumber}: (unable to read file)`];
		const block: string[] = [];
		const start = context > 0 ? Math.max(1, match.lineNumber - context) : match.lineNumber;
		const end = context > 0 ? Math.min(lines.length, match.lineNumber + context) : match.lineNumber;
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

	const rawOutput = matches.flatMap(formatBlock).join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;
	const details: Record<string, unknown> = {};
	const notices: string[] = [];
	if (matchLimitReached) {
		notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
		details.matchLimitReached = limit;
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
	return { kind: "ok", output, ...(Object.keys(details).length > 0 ? { details } : {}) };
}

function buildMatchRegex(
	pattern: string,
	literal: boolean,
	ignoreCase: boolean,
): { ok: true; regex: RegExp } | { ok: false; message: string } {
	const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
	try {
		return { ok: true, regex: new RegExp(source, ignoreCase ? "i" : "") };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, message: `grep: invalid pattern: ${message}` };
	}
}

function looksBinary(buffer: Buffer): boolean {
	const probe = Math.min(buffer.length, 1024);
	for (let i = 0; i < probe; i += 1) {
		if (buffer[i] === 0) return true;
	}
	return false;
}

// Pure-Node content search used when ripgrep is not on PATH (offline/weak
// nodes). Bounded: skips FALLBACK_IGNORED_DIRS, files over FALLBACK_MAX_FILE_BYTES,
// and binary files; stops at `limit` matches. Honors path, glob, literal,
// ignoreCase, context, and limit, and renders identically to the rg path.
function fallbackGrep(input: {
	pattern: string;
	searchPath: string;
	isDirectory: boolean;
	glob?: string;
	ignoreCase: boolean;
	literal: boolean;
	context: number;
	limit: number;
	signal?: AbortSignal;
}): ToolResult {
	const built = buildMatchRegex(input.pattern, input.literal, input.ignoreCase);
	if (!built.ok) return { kind: "error", message: built.message };
	const regex = built.regex;
	let globMatcher: RegExp | null = null;
	if (input.glob) {
		const normalized = input.glob.includes("/") ? input.glob : `**/${input.glob}`;
		try {
			globMatcher = compileGlobRegex(normalized);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `grep: ${message}` };
		}
	}

	const matches: Match[] = [];
	let matchLimitReached = false;

	const searchFile = (filePath: string): void => {
		if (matchLimitReached) return;
		let buffer: Buffer;
		try {
			const stat = statSync(filePath);
			if (!stat.isFile() || stat.size > FALLBACK_MAX_FILE_BYTES) return;
			buffer = readFileSync(filePath);
		} catch {
			return;
		}
		if (looksBinary(buffer)) return;
		const lines = buffer.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
		for (let i = 0; i < lines.length; i += 1) {
			const lineText = lines[i] ?? "";
			regex.lastIndex = 0;
			if (!regex.test(lineText)) continue;
			matches.push({ filePath, lineNumber: i + 1, lineText });
			if (matches.length >= input.limit) {
				matchLimitReached = true;
				return;
			}
		}
	};

	const walk = (dir: string): void => {
		if (matchLimitReached || input.signal?.aborted) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			return;
		}
		for (const entry of entries) {
			if (matchLimitReached || input.signal?.aborted) return;
			const absPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (FALLBACK_IGNORED_DIRS.has(entry.name)) continue;
				walk(absPath);
				continue;
			}
			if (!entry.isFile()) continue;
			if (globMatcher) {
				const relPath = normalizeGlobInput(relative(input.searchPath, absPath));
				if (!globMatcher.test(relPath)) continue;
			}
			searchFile(absPath);
		}
	};

	if (input.isDirectory) walk(input.searchPath);
	else searchFile(input.searchPath);

	if (input.signal?.aborted) return { kind: "error", message: "grep: operation aborted" };
	return renderGrepMatches({
		matches,
		searchPath: input.searchPath,
		isDirectory: input.isDirectory,
		context: input.context,
		limit: input.limit,
		matchLimitReached,
	});
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
		let stderr = "";
		let matchLimitReached = false;
		let killedDueToLimit = false;
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

		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		rl.on("line", (line) => {
			if (line.length === 0 || matches.length >= input.limit) return;
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
			finish(
				renderGrepMatches({
					matches,
					searchPath: input.searchPath,
					isDirectory: input.isDirectory,
					context: input.context,
					limit: input.limit,
					matchLimitReached,
				}),
			);
		});
	});
}

export const grepTool: ToolSpec = {
	name: ToolNames.Grep,
	description: `Search file contents with ripgrep; returns matching lines with paths and line numbers. Respects .gitignore. Capped at ${DEFAULT_LIMIT} matches.`,
	parameters: Type.Object({
		pattern: Type.String({ description: "Search pattern (regex by default)." }),
		path: Type.Optional(Type.String({ description: "Directory or file to search." })),
		glob: Type.Optional(Type.String({ description: "Filter files by glob, e.g. '*.ts'." })),
		ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search." })),
		literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal text." })),
		context: Type.Optional(Type.Number({ description: "Context lines per match." })),
		limit: Type.Optional(Type.Number({ description: "Max matches." })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args, options): Promise<ToolResult> {
		const pattern = typeof args.pattern === "string" && args.pattern.length > 0 ? args.pattern : null;
		if (!pattern) return { kind: "error", message: "grep: missing pattern argument" };
		const context = parseContext(args.context);
		if (context === null) return { kind: "error", message: "grep: context must be a non-negative number" };
		const searchPath = resolveReadPath(typeof args.path === "string" && args.path.length > 0 ? args.path : ".");
		const stat = statIsDirectory(searchPath);
		if (!stat.ok) return { kind: "error", message: `grep: ${stat.message}` };
		const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_LIMIT;
		const glob = typeof args.glob === "string" && args.glob.length > 0 ? args.glob : undefined;
		const ignoreCase = args.ignoreCase === true;
		const literal = args.literal === true;
		const rgPath = resolveRgBinary();
		if (rgPath) {
			return runRipgrep({
				rgPath,
				pattern,
				searchPath,
				isDirectory: stat.isDirectory,
				...(glob !== undefined ? { glob } : {}),
				ignoreCase,
				literal,
				context,
				limit,
				...(options?.signal ? { signal: options.signal } : {}),
			});
		}
		// rg absent (offline/weak node): degrade to a bounded pure-Node search
		// instead of failing content search outright.
		return fallbackGrep({
			pattern,
			searchPath,
			isDirectory: stat.isDirectory,
			...(glob !== undefined ? { glob } : {}),
			ignoreCase,
			literal,
			context,
			limit,
			...(options?.signal ? { signal: options.signal } : {}),
		});
	},
};
