import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Type } from "typebox";
import { packedSourceDirectory, packedSourcePathsUnder } from "../core/source-pack.js";
import { ToolNames } from "../core/tool-names.js";
import { StringEnum } from "../engine/ai.js";
import { resolveFdBinary } from "./executables.js";
import {
	compileGlobRegex,
	fallbackIgnoredDirs,
	fdIgnoreArgs,
	internalSearchExclusionNotice,
	normalizeGlobInput,
} from "./ignore-policy.js";
import {
	commitObservationReservation,
	createObservationPathFilter,
	finalizeObservation,
	OBSERVE_SELF_CAPS,
	type ObservationReservation,
	observationBudgetExhausted,
	releaseObservation,
	reserveObservation,
} from "./observation.js";
import { resolveReadPath, toPosixPath } from "./path-utils.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "./registry.js";
import {
	createSearchDiagnostics,
	finishSearch,
	newSearchCompleteness,
	type SearchCompleteness,
	searchNotice,
	skipSearchPath,
	spawnLineStream,
	validateSearchPatternSize,
} from "./spawn-hygiene.js";
import { hookLandingRefusal } from "./tool-landing.js";
import { truncateHead } from "./truncate.js";

const DEFAULT_LIMIT = 500;
// order=mtime never walks the whole tree: it collects a bounded candidate set,
// stats only those, sorts, and slices. When the candidate cap is hit the
// ordering is approximate and the observation says so.
const MTIME_CANDIDATE_FLOOR = 2000;

type FindOrder = "path" | "mtime";

// Build fd's argv. Ignore semantics (hidden files, .gitignore honoring,
// generated-dir excludes, include_ignored) come entirely from the shared
// ignore policy so grep and find never disagree about tree visibility.
function buildFdArgs(pattern: string, searchPath: string, includeIgnored: boolean): string[] {
	const args = ["--glob", "--color=never", ...fdIgnoreArgs(searchPath, includeIgnored)];
	args.push("--show-errors");
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
	search: SearchCompleteness,
	allows: (path: string) => boolean,
	signal?: AbortSignal,
): Promise<{ ok: true; paths: string[] } | { ok: false; message: string }> {
	const lines: string[] = [];
	const diagnostics = createSearchDiagnostics(search, (path) => allows(resolve(process.cwd(), path)));
	const result = await spawnLineStream(fdPath, buildFdArgs(pattern, searchPath, includeIgnored), {
		...(signal ? { signal } : {}),
		onStderrLine: diagnostics.onLine,
		onLine(line, stop) {
			if (line.length === 0 || !allows(resolve(searchPath, line))) return;
			lines.push(line);
			if (lines.length >= collectLimit) stop();
		},
	});
	finishSearch(search, result);
	if (!result.aborted && !result.timedOut && !result.stoppedEarly && result.exitCode !== 0) {
		search.complete = false;
		search.reason = "errors";
	}
	if (result.spawnError !== null) return { ok: false, message: `find: failed to run fd: ${result.spawnError}` };
	if (
		!result.aborted &&
		!result.timedOut &&
		!result.stoppedEarly &&
		result.exitCode !== 0 &&
		lines.length === 0 &&
		(diagnostics.realError || (search.skipped.count === 0 && !search.skipped.unknown))
	) {
		return {
			ok: false,
			message: `find: fd rejected the search or failed (exit code ${result.exitCode}). Check the glob and search path.`,
		};
	}
	const paths = lines
		.map((rawLine) => rawLine.replace(/\r$/, ""))
		.filter((line) => line.length > 0)
		.map((line) => {
			const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
			let relPath = relative(searchPath, line);
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
	search: SearchCompleteness,
	allows: (path: string) => boolean,
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
			skipSearchPath(search, dir, allows);
			return;
		}
		for (const entry of entries) {
			if (out.length >= collectLimit || signal?.aborted) return;
			const absPath = join(dir, entry.name);
			if (!allows(absPath)) continue;
			if (entry.isDirectory() && !entry.isSymbolicLink()) {
				if (ignored.has(entry.name)) continue;
				const relDir = `${toPosixPath(relative(searchPath, absPath))}/`;
				if (matcher.test(normalizeGlobInput(relDir))) out.push(relDir);
				await walk(absPath);
				continue;
			}
			if (entry.isSymbolicLink()) {
				try {
					if (statSync(absPath).isDirectory()) skipSearchPath(search, absPath, allows);
				} catch {
					skipSearchPath(search, absPath, allows);
				}
			} else if (!entry.isFile()) continue;
			const relPath = toPosixPath(relative(searchPath, absPath));
			if (matcher.test(normalizeGlobInput(relPath))) out.push(relPath);
		}
	}
	await walk(searchPath);
	return out;
}

/**
 * Packed source members under `searchPath` that match the glob the way the
 * fallback walker matches, appended after the disk matches up to the collect
 * limit. Null when nothing under `searchPath` is served from the pack, which
 * is always the case in a checkout.
 */
function packedFind(
	pattern: string,
	searchPath: string,
	collected: string[],
	collectLimit: number,
	allows: (path: string) => boolean,
): { paths: string[]; mtimeMs: number } | null {
	const packed = packedSourcePathsUnder(searchPath);
	if (packed === null) return null;
	const matcher = compileGlobRegex(pattern.includes("/") ? pattern : `**/${pattern}`);
	const seen = new Set(collected.map((entry) => entry.replace(/\/$/, "")));
	const paths: string[] = [];
	for (const rel of [...packed.directories, ...packed.files]) {
		if (collected.length + paths.length >= collectLimit) break;
		if (seen.has(rel.replace(/\/$/, "")) || !matcher.test(rel)) continue;
		// Filter before the match counts, so withheld members never take a slot from permitted ones.
		if (!allows(join(searchPath, rel))) continue;
		paths.push(rel);
	}
	return { paths, mtimeMs: packed.mtimeMs };
}

interface OrderedPaths {
	paths: string[];
	/** Candidate cap was hit in mtime mode; ordering is approximate. */
	candidateCapHit: boolean;
	candidateCap: number | null;
}

function orderByMtime(
	paths: string[],
	searchPath: string,
	limit: number,
	candidateCap: number,
	search: SearchCompleteness,
	packed: { paths: Set<string>; mtimeMs: number } | null,
): OrderedPaths {
	const candidateCapHit = paths.length >= candidateCap;
	const stamped = paths.map((relPath) => {
		if (packed?.paths.has(relPath)) return { relPath, mtimeMs: packed.mtimeMs };
		let mtimeMs = 0;
		try {
			mtimeMs = statSync(join(searchPath, relPath)).mtimeMs;
		} catch {
			// Entries that vanish mid-scan sort last and remain explicitly incomplete.
			skipSearchPath(search, join(searchPath, relPath));
		}
		return { relPath, mtimeMs };
	});
	stamped.sort((a, b) => b.mtimeMs - a.mtimeMs || a.relPath.localeCompare(b.relPath));
	return { paths: stamped.slice(0, limit).map((entry) => entry.relPath), candidateCapHit, candidateCap };
}

function renderFindResult(input: {
	searchPath: string;
	search: SearchCompleteness;
	fallback: boolean;
	withheldPaths: number;
	packedPaths: Set<string>;
	ordered: OrderedPaths;
	collected: number;
	collectLimit: number;
	limit: number;
	order: FindOrder;
	reservation: ObservationReservation;
	options: ToolInvokeOptions | undefined;
}): ToolResult {
	const { ordered, collected, collectLimit, limit, order, reservation, options, search } = input;
	if ((collected > limit || collected >= collectLimit || ordered.candidateCapHit) && search.complete) {
		search.complete = false;
		search.reason = "limit";
	}
	const packedShown = ordered.paths.filter((entry) => input.packedPaths.has(entry)).length;
	const coverageNotice =
		(input.fallback
			? "\n[Fallback search uses GENERATED_DIRS only; .gitignore is not applied.]"
			: "\n[Native fd search: skipped symlinked directories are not counted.]") +
		(packedShown > 0
			? `\n[${packedShown} of these paths ship inside dist/assets/source.pack, not as files on disk; read opens them by this path.]`
			: "");
	if (ordered.paths.length === 0) {
		return finalizeObservation({
			tool: ToolNames.Find,
			withheldPaths: input.withheldPaths,
			unit: "paths",
			output:
				(search.complete ? "No visible files found matching pattern" : "Search incomplete") +
				searchNotice(search, 0, "paths") +
				coverageNotice +
				internalSearchExclusionNotice(input.searchPath),
			details: { search, symlinkDirectories: { counted: input.fallback } },
			shownCount: 0,
			totalCount: search.complete ? 0 : null,
			truncated: !search.complete,
			...(collected >= collectLimit ? { next: `limit=${limit * 2}` } : {}),
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
	if (truncation.truncated && search.complete) {
		search.complete = false;
		search.reason = "limit";
	}
	const totalKnown = search.complete;
	const truncated = !search.complete || limitHit || ordered.candidateCapHit || truncation.truncated;
	const next = limitHit ? `limit=${limit * 2}` : ordered.candidateCapHit ? "order=path" : undefined;
	const details: Record<string, unknown> = { search, symlinkDirectories: { counted: input.fallback } };
	if (input.packedPaths.size > 0) details.packed = { collected: input.packedPaths.size, shown: packedShown };
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
		withheldPaths: input.withheldPaths,
		unit: "paths",
		output: truncation.content + searchNotice(search, truncation.outputLines, "paths") + coverageNotice,
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
		"Find files and directories by glob pattern (*, **, ?, [abc]); returns paths relative to the search directory. Respects .gitignore and skips generated dirs (node_modules, dist, build, ...) unless include_ignored=true. Symlinked directories are never followed. Only the fallback counts skipped symlinked directories; native fd leaves that count not measured, as indicated by details.symlinkDirectories.counted=false. Without fd, the fallback skips generated dirs but does not apply .gitignore. order=path (default) returns fd's native order; order=mtime returns newest first from a bounded candidate set. A truncated result says how to continue.",
	parameters: Type.Object({
		pattern: Type.String({ description: "Glob, e.g. 'src/**/*.ts'." }),
		path: Type.Optional(Type.String({ description: "Directory to search." })),
		order: Type.Optional(StringEnum(["path", "mtime"])),
		limit: Type.Optional(Type.Number({ description: "Max results (default 500)." })),
		include_ignored: Type.Optional(Type.Boolean({ description: "Also search gitignored and generated paths." })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args, options): Promise<ToolResult> {
		const pattern = typeof args.pattern === "string" && args.pattern.length > 0 ? args.pattern : null;
		if (!pattern) return { kind: "error", message: "find: missing pattern argument" };
		// Reject an oversized pattern before spawning fd or compiling a fallback
		// glob regex; an over-MAX_ARG_STRLEN argv entry would otherwise throw E2BIG.
		const patternSize = validateSearchPatternSize(pattern);
		if (!patternSize.ok) return { kind: "error", message: `find: ${patternSize.message}` };
		const order: FindOrder = args.order === "mtime" ? "mtime" : "path";
		if (args.order !== undefined && args.order !== "path" && args.order !== "mtime") {
			return { kind: "error", message: `find: order must be path or mtime; got '${String(args.order)}'` };
		}
		const searchPath = resolveReadPath(typeof args.path === "string" && args.path.length > 0 ? args.path : ".");
		const moved = hookLandingRefusal("find", options?.hookLanding, searchPath);
		if (moved !== null) return { kind: "error", message: moved };
		// A directory of an installed package's src/ may exist only in the source pack.
		const packOnly = !existsSync(searchPath) && packedSourceDirectory(searchPath) !== null;
		if (!packOnly && !existsSync(searchPath)) return { kind: "error", message: `find: path not found: ${searchPath}` };
		if (!packOnly && !statSync(searchPath).isDirectory())
			return { kind: "error", message: `find: not a directory: ${searchPath}` };
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

		// find yields on the fd subprocess / readdir walk below, so charge the
		// shared turn pool up front and refund the unused slice at finalize; a
		// concurrent OBSERVE sibling that reserves mid-walk must see this spend.
		commitObservationReservation(reservation);
		try {
			let collectedPaths: string[];
			const search = newSearchCompleteness();
			const pathFilter = createObservationPathFilter(process.cwd(), options?.allowsObservationPath);
			const fdPath = resolveFdBinary();
			if (packOnly) {
				collectedPaths = [];
			} else if (fdPath) {
				const result = await fdFind(
					fdPath,
					pattern,
					searchPath,
					collectLimit,
					includeIgnored,
					search,
					pathFilter.allows,
					options?.signal,
				);
				if (!result.ok) return { kind: "error", message: result.message };
				collectedPaths = result.paths;
			} else {
				try {
					collectedPaths = await fallbackFind(
						pattern,
						searchPath,
						collectLimit,
						includeIgnored,
						search,
						pathFilter.allows,
						options?.signal,
					);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return { kind: "error", message: `find: ${message}` };
				}
			}

			if (options?.signal?.aborted) {
				search.complete = false;
				search.reason = "cancelled";
			}
			const packed = packedFind(pattern, searchPath, collectedPaths, collectLimit, pathFilter.allows);
			if (packed) collectedPaths = [...collectedPaths, ...packed.paths];
			collectedPaths = collectedPaths.filter((entry) => pathFilter.allows(join(searchPath, entry)));
			const kept = new Set(collectedPaths);
			const packedPaths = new Set(packed?.paths.filter((entry) => kept.has(entry)) ?? []);
			const collectedCount = collectedPaths.length;
			const ordered: OrderedPaths =
				order === "mtime"
					? orderByMtime(
							collectedPaths,
							searchPath,
							limit,
							collectLimit,
							search,
							packed ? { paths: packedPaths, mtimeMs: packed.mtimeMs } : null,
						)
					: { paths: collectedPaths.slice(0, limit), candidateCapHit: false, candidateCap: null };
			return renderFindResult({
				searchPath,
				search,
				fallback: !fdPath,
				withheldPaths: pathFilter.withheldPaths,
				packedPaths,
				ordered,
				collected: collectedCount,
				collectLimit,
				limit,
				order,
				reservation,
				options,
			});
		} finally {
			releaseObservation(reservation);
		}
	},
};
