import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path, { join, relative } from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { resolveFdBinary } from "./executables.js";
import { compileGlobRegex, fallbackIgnoredDirs, fdIgnoreArgs, normalizeGlobInput } from "./ignore-policy.js";
import {
	finalizeObservation,
	OBSERVE_SELF_CAPS,
	type ObservationReservation,
	observationBudgetExhausted,
	reserveObservation,
} from "./observation.js";
import { resolveReadPath } from "./path-utils.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "./registry.js";
import { SEARCH_SPAWN_TIMEOUT_MS, spawnLineStream } from "./spawn-hygiene.js";
import { stringEnum } from "./string-enum.js";
import { truncateHead } from "./truncate.js";

const DEFAULT_LIMIT = 500;
// order=mtime never walks the whole tree: it collects a bounded candidate set,
// stats only those, sorts, and slices. When the candidate cap is hit the
// ordering is approximate and the observation says so.
const MTIME_CANDIDATE_FLOOR = 2000;

type FindOrder = "path" | "mtime";

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

// Build fd's argv. Ignore semantics (hidden files, .gitignore honoring,
// generated-dir excludes, include_ignored) come entirely from the shared
// ignore policy so grep and find never disagree about tree visibility.
export function buildFdArgs(
	pattern: string,
	searchPath: string,
	maxResults: number,
	includeIgnored: boolean,
): string[] {
	const args = ["--glob", "--color=never", ...fdIgnoreArgs(searchPath, includeIgnored)];
	args.push("--max-results", String(maxResults));
	let effectivePattern = pattern;
	if (pattern.includes("/")) {
		args.push("--full-path");
		if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
			effectivePattern = `**/${pattern}`;
		}
	}
	args.push("--", effectivePattern, searchPath);
	return args;
}

async function fdFind(
	fdPath: string,
	pattern: string,
	searchPath: string,
	collectLimit: number,
	includeIgnored: boolean,
	signal?: AbortSignal,
): Promise<{ ok: true; paths: string[] } | { ok: false; message: string }> {
	const lines: string[] = [];
	const result = await spawnLineStream(fdPath, buildFdArgs(pattern, searchPath, collectLimit, includeIgnored), {
		...(signal ? { signal } : {}),
		onLine(line, stop) {
			lines.push(line);
			if (lines.length >= collectLimit) stop();
		},
	});
	if (result.aborted) return { ok: false, message: "find: operation aborted" };
	if (result.timedOut) {
		return {
			ok: false,
			message: `find: fd timed out after ${SEARCH_SPAWN_TIMEOUT_MS / 1000}s. Narrow the pattern or path, or lower limit.`,
		};
	}
	if (result.spawnError !== null) return { ok: false, message: `find: failed to run fd: ${result.spawnError}` };
	if (!result.stoppedEarly && result.exitCode !== 0 && lines.length === 0) {
		return { ok: false, message: `find: ${result.stderr.trim() || `fd exited with code ${result.exitCode}`}` };
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
	return { ok: true, paths };
}

// Bounded async fallback walker for hosts without fd. Uses dirents only (no
// per-entry lstat), skips the shared ignored-dir set, and stops as soon as the
// collect limit is reached; the full-tree sync lstat walk the old glob tool
// did is gone.
async function fallbackFind(
	pattern: string,
	searchPath: string,
	collectLimit: number,
	includeIgnored: boolean,
	signal?: AbortSignal,
): Promise<string[]> {
	const matcher = compileGlobRegex(pattern.includes("/") ? pattern : `**/${pattern}`);
	const ignored = fallbackIgnoredDirs(includeIgnored);
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		if (out.length >= collectLimit || signal?.aborted) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			return;
		}
		for (const entry of entries) {
			if (out.length >= collectLimit || signal?.aborted) return;
			const absPath = join(dir, entry.name);
			if (entry.isDirectory() && !entry.isSymbolicLink()) {
				if (ignored.has(entry.name)) continue;
				const relDir = `${toPosixPath(relative(searchPath, absPath))}/`;
				if (matcher.test(normalizeGlobInput(relDir))) out.push(relDir);
				await walk(absPath);
				continue;
			}
			if (!entry.isFile()) continue;
			const relPath = toPosixPath(relative(searchPath, absPath));
			if (matcher.test(normalizeGlobInput(relPath))) out.push(relPath);
		}
	}
	await walk(searchPath);
	return out;
}

interface OrderedPaths {
	paths: string[];
	/** Candidate cap was hit in mtime mode; ordering is approximate. */
	candidateCapHit: boolean;
	candidateCap: number | null;
}

function orderByMtime(paths: string[], searchPath: string, limit: number, candidateCap: number): OrderedPaths {
	const candidateCapHit = paths.length >= candidateCap;
	const stamped = paths.map((relPath) => {
		let mtimeMs = 0;
		try {
			mtimeMs = statSync(join(searchPath, relPath)).mtimeMs;
		} catch {
			// Entries that vanish mid-scan sort last instead of failing the call.
		}
		return { relPath, mtimeMs };
	});
	stamped.sort((a, b) => b.mtimeMs - a.mtimeMs || a.relPath.localeCompare(b.relPath));
	return { paths: stamped.slice(0, limit).map((entry) => entry.relPath), candidateCapHit, candidateCap };
}

function renderFindResult(input: {
	ordered: OrderedPaths;
	collected: number;
	collectLimit: number;
	limit: number;
	order: FindOrder;
	reservation: ObservationReservation;
	options: ToolInvokeOptions | undefined;
}): ToolResult {
	const { ordered, collected, collectLimit, limit, order, reservation, options } = input;
	if (ordered.paths.length === 0) {
		return finalizeObservation({
			tool: ToolNames.Find,
			unit: "paths",
			output: "No files found matching pattern",
			shownCount: 0,
			totalCount: 0,
			truncated: false,
			reservation,
			...(options ? { options } : {}),
		});
	}
	const fullOutput = ordered.paths.join("\n");
	const truncation = truncateHead(fullOutput, {
		maxBytes: reservation.callCapBytes,
		maxLines: Number.MAX_SAFE_INTEGER,
	});
	const limitHit = collected > limit || collected >= collectLimit;
	// Unknown totals: the collector stopped at its cap, so matches beyond it
	// exist but were never counted.
	const totalKnown = !limitHit && !ordered.candidateCapHit;
	const truncated = limitHit || ordered.candidateCapHit || truncation.truncated;
	const next = limitHit ? `limit=${limit * 2}` : ordered.candidateCapHit ? "order=path" : undefined;
	const details: Record<string, unknown> = {};
	if (order === "mtime" && ordered.candidateCap !== null) {
		details.candidates = {
			cap: ordered.candidateCap,
			collected,
			capHit: ordered.candidateCapHit,
			...(ordered.candidateCapHit ? { note: "candidate cap reached; mtime ordering is approximate" } : {}),
		};
	}
	return finalizeObservation({
		tool: ToolNames.Find,
		unit: "paths",
		output: truncation.content,
		// Offload only when the byte cap cut collected paths; a bare result
		// limit continues via `next`, and the offload would duplicate the body.
		...(truncation.truncated ? { fullOutput } : {}),
		shownCount: truncation.outputLines,
		totalCount: totalKnown ? ordered.paths.length : null,
		truncated,
		...(next !== undefined ? { next } : {}),
		...(Object.keys(details).length > 0 ? { details } : {}),
		reservation,
		...(options ? { options } : {}),
	});
}

export const findTool: ToolSpec = {
	name: ToolNames.Find,
	description:
		"Find files and directories by glob pattern (supports *, **, ?, [abc]); returns paths relative to the search directory. Respects .gitignore and skips generated dirs (node_modules, dist, build, ...) unless include_ignored=true. order=path (default) returns fd's native order; order=mtime returns newest first from a bounded candidate set. Truncated results say how to continue and where the full list was saved.",
	parameters: Type.Object({
		pattern: Type.String({ description: "Glob pattern, e.g. 'src/**/*.ts'." }),
		path: Type.Optional(Type.String({ description: "Directory to search in." })),
		order: Type.Optional(stringEnum(["path", "mtime"], "Result order: path (default) or mtime descending.")),
		limit: Type.Optional(Type.Number({ description: `Max results (default ${DEFAULT_LIMIT}).` })),
		include_ignored: Type.Optional(Type.Boolean({ description: "Search gitignored and generated paths too." })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args, options): Promise<ToolResult> {
		const pattern = typeof args.pattern === "string" && args.pattern.length > 0 ? args.pattern : null;
		if (!pattern) return { kind: "error", message: "find: missing pattern argument" };
		const order: FindOrder = args.order === "mtime" ? "mtime" : "path";
		if (args.order !== undefined && args.order !== "path" && args.order !== "mtime") {
			return { kind: "error", message: `find: order must be path or mtime; got '${String(args.order)}'` };
		}
		const searchPath = resolveReadPath(typeof args.path === "string" && args.path.length > 0 ? args.path : ".");
		if (!existsSync(searchPath)) return { kind: "error", message: `find: path not found: ${searchPath}` };
		if (!statSync(searchPath).isDirectory()) return { kind: "error", message: `find: not a directory: ${searchPath}` };
		const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_LIMIT;
		const includeIgnored = args.include_ignored === true;
		const reservation = reserveObservation(OBSERVE_SELF_CAPS.find, options);
		if (reservation.exhausted) {
			return observationBudgetExhausted({
				tool: ToolNames.Find,
				unit: "paths",
				reservation,
				subject: `pattern '${pattern}'`,
				hint: "Use a narrower pattern or path in a follow-up turn.",
			});
		}
		const collectLimit = order === "mtime" ? Math.max(limit * 4, MTIME_CANDIDATE_FLOOR) : limit + 1;

		let collectedPaths: string[];
		const fdPath = resolveFdBinary();
		if (fdPath) {
			const result = await fdFind(fdPath, pattern, searchPath, collectLimit, includeIgnored, options?.signal);
			if (!result.ok) return { kind: "error", message: result.message };
			collectedPaths = result.paths;
		} else {
			try {
				collectedPaths = await fallbackFind(pattern, searchPath, collectLimit, includeIgnored, options?.signal);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { kind: "error", message: `find: ${message}` };
			}
		}

		const ordered: OrderedPaths =
			order === "mtime"
				? orderByMtime(collectedPaths, searchPath, limit, collectLimit)
				: { paths: collectedPaths.slice(0, limit), candidateCapHit: false, candidateCap: null };
		return renderFindResult({
			ordered,
			collected: collectedPaths.length,
			collectLimit,
			limit,
			order,
			reservation,
			options,
		});
	},
};
