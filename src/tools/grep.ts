import { lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { compileGlobRegex, normalizeGlobInput } from "./glob.js";
import type { ToolResult, ToolSpec } from "./registry.js";

const MAX_MATCHES = 100;
const MAX_DEPTH = 8;
const MAX_FILE_BYTES = 1_000_000;
const BINARY_SAMPLE_BYTES = 8192;
const IGNORED_DIRS = new Set([
	".cache",
	".clio",
	".fallow",
	".git",
	".next",
	".pytest_cache",
	".turbo",
	".venv",
	"build",
	"coverage",
	"dist",
	"node_modules",
	"target",
]);
const BINARY_EXTENSIONS = new Set([
	".7z",
	".bin",
	".bmp",
	".class",
	".dll",
	".dylib",
	".gif",
	".gz",
	".ico",
	".jpeg",
	".jpg",
	".o",
	".pdf",
	".png",
	".so",
	".tar",
	".wasm",
	".webp",
	".zip",
]);

interface FileEntry {
	absPath: string;
	relPath: string;
	baseName: string;
	stat: Stats;
}

interface WalkStats {
	ignoredDirs: number;
}

function parseContext(value: unknown): number | null {
	if (value === undefined) return 0;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return null;
	}
	return Math.floor(value);
}

function walkFiles(root: string, current: string, depth: number, out: FileEntry[], stats: WalkStats): void {
	if (depth > MAX_DEPTH) return;

	const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		const absPath = path.join(current, entry.name);
		const stat = lstatSync(absPath);
		if (stat.isDirectory() && !stat.isSymbolicLink()) {
			if (IGNORED_DIRS.has(entry.name)) {
				stats.ignoredDirs += 1;
				continue;
			}
			walkFiles(root, absPath, depth + 1, out, stats);
			continue;
		}
		if (stat.isFile()) {
			out.push({
				absPath,
				relPath: normalizeGlobInput(path.relative(root, absPath)),
				baseName: entry.name,
				stat,
			});
		}
	}
}

function hasBinaryExtension(filePath: string): boolean {
	return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isLikelyBinary(buffer: Buffer): boolean {
	const sampleLength = Math.min(buffer.length, BINARY_SAMPLE_BYTES);
	if (sampleLength === 0) return false;
	let suspicious = 0;
	for (let i = 0; i < sampleLength; i += 1) {
		const byte = buffer[i] ?? 0;
		if (byte === 0) return true;
		if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
	}
	return suspicious / sampleLength > 0.1;
}

function skippedSuffix(stats: { ignoredDirs: number; largeFiles: number; binaryFiles: number }): string {
	const parts: string[] = [];
	if (stats.ignoredDirs > 0) parts.push(`${stats.ignoredDirs} ignored dirs`);
	if (stats.largeFiles > 0) parts.push(`${stats.largeFiles} large files`);
	if (stats.binaryFiles > 0) parts.push(`${stats.binaryFiles} binary files`);
	return parts.length > 0 ? `\n[skipped ${parts.join(", ")}]` : "";
}

export const grepTool: ToolSpec = {
	name: ToolNames.Grep,
	description:
		"Search files under a directory with a JavaScript regex. Returns file:line: matches, optionally with surrounding context. Filter files with a glob like **/*.ts.",
	parameters: Type.Object({
		pattern: Type.String({ description: "JavaScript RegExp pattern (no leading slash)." }),
		path: Type.Optional(Type.String({ description: "Root directory to search. Defaults to the orchestrator cwd." })),
		glob: Type.Optional(
			Type.String({ description: "Glob filter for file paths (e.g. **/*.ts). Omit to include every file." }),
		),
		context: Type.Optional(
			Type.Number({ description: "Lines of surrounding context per match. Must be >= 0. Defaults to 0." }),
		),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
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
		const skipped = { ignoredDirs: 0, largeFiles: 0, binaryFiles: 0 };
		try {
			walkFiles(root, root, 0, files, skipped);
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

			if (file.stat.size > MAX_FILE_BYTES) {
				skipped.largeFiles += 1;
				continue;
			}
			if (hasBinaryExtension(file.absPath)) {
				skipped.binaryFiles += 1;
				continue;
			}

			let text: string;
			try {
				const bytes = readFileSync(file.absPath);
				if (isLikelyBinary(bytes)) {
					skipped.binaryFiles += 1;
					continue;
				}
				text = bytes.toString("utf8");
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
			return { kind: "ok", output: `no matches${skippedSuffix(skipped)}` };
		}

		if (truncated) {
			output.push("[more results truncated]");
		}
		const suffix = skippedSuffix(skipped);
		if (suffix.length > 0) output.push(suffix.trim());

		return { kind: "ok", output: output.join("\n") };
	},
};
