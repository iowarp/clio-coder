import { spawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import path, { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { resolveFdBinary } from "./executables.js";
import { compileGlobRegex, normalizeGlobInput } from "./glob.js";
import { resolveReadPath } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.js";

const DEFAULT_LIMIT = 1000;
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

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

function renderFindOutput(paths: string[], limit: number): ToolResult {
	if (paths.length === 0) return { kind: "ok", output: "No files found matching pattern" };
	const resultLimitReached = paths.length > limit;
	const visiblePaths = paths.slice(0, limit);
	const truncation = truncateHead(visiblePaths.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;
	const details: Record<string, unknown> = {};
	const notices: string[] = [];
	if (resultLimitReached) {
		notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`);
		details.resultLimitReached = limit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
	return { kind: "ok", output, ...(Object.keys(details).length > 0 ? { details } : {}) };
}

function fallbackFind(pattern: string, searchPath: string, collectLimit: number): string[] {
	const matcher = compileGlobRegex(pattern.includes("/") ? pattern : `**/${pattern}`);
	const out: string[] = [];
	function walk(dir: string): void {
		if (out.length >= collectLimit) return;
		const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (out.length >= collectLimit) return;
			const absPath = join(dir, entry.name);
			let stat: import("node:fs").Stats;
			try {
				stat = lstatSync(absPath);
			} catch {
				continue;
			}
			if (stat.isDirectory() && !stat.isSymbolicLink()) {
				if (IGNORED_DIRS.has(entry.name)) continue;
				const relDir = `${toPosixPath(relative(searchPath, absPath))}/`;
				if (matcher.test(normalizeGlobInput(relDir))) out.push(relDir);
				walk(absPath);
				continue;
			}
			if (!stat.isFile()) continue;
			const relPath = toPosixPath(relative(searchPath, absPath));
			if (matcher.test(normalizeGlobInput(relPath))) out.push(relPath);
		}
	}
	walk(searchPath);
	return out;
}

async function fdFind(
	fdPath: string,
	pattern: string,
	searchPath: string,
	limit: number,
	signal?: AbortSignal,
): Promise<{ ok: true; paths: string[] } | { ok: false; message: string }> {
	return new Promise((resolve) => {
		const args = ["--glob", "--color=never", "--hidden", "--no-require-git", "--max-results", String(limit + 1)];
		let effectivePattern = pattern;
		if (pattern.includes("/")) {
			args.push("--full-path");
			if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
				effectivePattern = `**/${pattern}`;
			}
		}
		args.push("--", effectivePattern, searchPath);

		const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
		const rl = createInterface({ input: child.stdout });
		const lines: string[] = [];
		let stderr = "";
		let settled = false;
		const finish = (result: { ok: true; paths: string[] } | { ok: false; message: string }) => {
			if (settled) return;
			settled = true;
			rl.close();
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const onAbort = () => {
			if (!child.killed) child.kill();
			finish({ ok: false, message: "find: operation aborted" });
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		rl.on("line", (line) => {
			lines.push(line);
		});
		child.on("error", (error) => finish({ ok: false, message: `find: failed to run fd: ${error.message}` }));
		child.on("close", (code) => {
			if (signal?.aborted) {
				finish({ ok: false, message: "find: operation aborted" });
				return;
			}
			if (code !== 0 && lines.length === 0) {
				finish({ ok: false, message: `find: ${stderr.trim() || `fd exited with code ${code}`}` });
				return;
			}
			const paths = lines
				.map((rawLine) => rawLine.replace(/\r$/, "").trim())
				.filter((line) => line.length > 0)
				.map((line) => {
					const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
					let relPath = line.startsWith(searchPath) ? line.slice(searchPath.length + 1) : relative(searchPath, line);
					if (hadTrailingSlash && !relPath.endsWith("/")) relPath += "/";
					return toPosixPath(relPath);
				});
			finish({ ok: true, paths });
		});
	});
}

export const findTool: ToolSpec = {
	name: ToolNames.Find,
	description: "Find files by glob pattern; returns paths relative to the search directory. Respects .gitignore.",
	parameters: Type.Object({
		pattern: Type.String({ description: "Glob pattern, e.g. 'src/**/*.ts'." }),
		path: Type.Optional(Type.String({ description: "Directory to search in." })),
		limit: Type.Optional(Type.Number({ description: "Max results (default 1000)." })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args, options): Promise<ToolResult> {
		const pattern = typeof args.pattern === "string" && args.pattern.length > 0 ? args.pattern : null;
		if (!pattern) return { kind: "error", message: "find: missing pattern argument" };
		const searchPath = resolveReadPath(typeof args.path === "string" && args.path.length > 0 ? args.path : ".");
		if (!existsSync(searchPath)) return { kind: "error", message: `find: path not found: ${searchPath}` };
		if (!statSync(searchPath).isDirectory()) return { kind: "error", message: `find: not a directory: ${searchPath}` };
		const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_LIMIT;
		const fdPath = resolveFdBinary();
		if (fdPath) {
			const result = await fdFind(fdPath, pattern, searchPath, limit, options?.signal);
			if (!result.ok) return { kind: "error", message: result.message };
			return renderFindOutput(result.paths, limit);
		}
		try {
			return renderFindOutput(fallbackFind(pattern, searchPath, limit), limit);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: message.startsWith("glob:") ? `find: ${message}` : `find: ${message}` };
		}
	},
};
