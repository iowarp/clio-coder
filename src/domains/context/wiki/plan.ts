/**
 * The page plan: the wiki's skeleton, as an artifact rather than a prompt
 * sentence.
 *
 * A plan names every page the wiki will contain, what each page must document,
 * and the source files that ground it. It is built deterministically from the
 * codewiki index, so a usable plan exists before any model runs; a planning
 * dispatch may then merge, split, rename, drop, or re-anchor entries by
 * rewriting `_plan.json` in the staging tree. A malformed rewrite falls back to
 * the candidate rather than failing the run.
 *
 * The plan is also the run's checkpoint. Each entry carries its own status, so
 * a run that ends early leaves a record of exactly which pages are still owed,
 * and the next run writes only those. Nothing here targets a page count: how
 * many pages a repository gets follows from how many substantial areas the
 * index finds at the requested depth.
 */

import type { Codewiki, CodewikiFile } from "../codewiki/indexer.js";

export type WikiDepth = "auto" | "simple" | "medium" | "detailed";
export type ResolvedWikiDepth = Exclude<WikiDepth, "auto">;

export type WikiPageStatus = "pending" | "written";

export interface WikiPlanPage {
	/** POSIX-relative page path inside the wiki root. */
	path: string;
	title: string;
	/** What this page must document, in one or two sentences. */
	intent: string;
	/** Repository-relative source files that ground the page. */
	sources: string[];
	/** Harness-owned: whether this page has been written in a completed dispatch. */
	status: WikiPageStatus;
	/** Harness-owned: how many dispatches have tried to write this page. */
	attempts: number;
}

export interface WikiPlan {
	version: 1;
	/** One paragraph describing what this repository is; opens the generated quickstart. */
	overview: string;
	pages: WikiPlanPage[];
}

export interface WikiGenerationPlan {
	requestedDepth: WikiDepth;
	depth: ResolvedWikiDepth;
	sourceFiles: number;
	sourceLines: number;
	/** The candidate skeleton derived from the index at this depth. */
	plan: WikiPlan;
}

/**
 * How finely a repository is decomposed at each depth.
 *
 * `areaDepth` is how many directory segments make an area, so depth changes the
 * granularity of the decomposition itself: at 1 the whole of `src` is one area,
 * at 3 each `src/domains/<name>` is. `areaShare` and `minAreaLines` then drop
 * areas too small to carry a page, folding them into the nearest ancestor.
 *
 * Both are decomposition thresholds, not page targets. Granularity is what
 * scales with repository size; the resulting page count is whatever the
 * repository's shape produces at that granularity, and is never something a
 * writer is told to hit.
 */
export const WIKI_DEPTH_STRATEGY: Record<ResolvedWikiDepth, DepthStrategy> = {
	simple: { areaDepth: 1, areaShare: 0.08, minAreaLines: 400 },
	medium: { areaDepth: 2, areaShare: 0.03, minAreaLines: 250 },
	detailed: { areaDepth: 3, areaShare: 0.008, minAreaLines: 150 },
};

export interface DepthStrategy {
	areaDepth: number;
	areaShare: number;
	minAreaLines: number;
}

/** Most source files named on one page's prompt. Keeps a page dispatch small. */
const MAX_PAGE_SOURCES = 8;

interface Area {
	key: string;
	files: CodewikiFile[];
	lines: number;
}

/**
 * The area a file belongs to: its first `maxDepth` directory segments. The
 * filename is dropped first, so a file sitting directly in `src` joins the
 * `src` area instead of becoming an area of its own named after itself.
 */
function areaForPath(path: string, maxDepth: number): string {
	const directories = path.split("/").filter(Boolean).slice(0, -1);
	if (directories.length === 0) return ".";
	return directories.slice(0, Math.max(1, maxDepth)).join("/");
}

function classifyDepth(sourceFiles: number, sourceLines: number): ResolvedWikiDepth {
	if (sourceFiles <= 150 && sourceLines <= 30_000) return "simple";
	if (sourceFiles <= 800 && sourceLines <= 150_000) return "medium";
	return "detailed";
}

function slugSegment(segment: string): string {
	const slug = segment
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : "section";
}

/**
 * Meaningful segments of an area: the ones that name a documentation section.
 * A leading `src/` describes the language's layout rather than a section, so it
 * is dropped and `src/domains/dispatch` becomes `domains/dispatch`. An area
 * that is only `src`, or the repository root, has no such segments and gets a
 * name of its own.
 */
function areaSegments(area: string): string[] {
	const parts = area.split("/").filter((part) => part.length > 0 && part !== ".");
	if (parts.length === 0) return ["root"];
	if (parts[0] !== "src") return parts;
	return parts.length === 1 ? ["source"] : parts.slice(1);
}

/** Turn an index area into a page path; nesting follows the repository's. */
export function pagePathForArea(area: string): string {
	return `${areaSegments(area).map(slugSegment).join("/")}.md`;
}

function titleForArea(area: string): string {
	const name = areaSegments(area).join(" ").replace(/[-_]+/g, " ").trim();
	return name.length > 0 ? name.charAt(0).toUpperCase() + name.slice(1) : "Overview";
}

/** Rank an area's files so the ones a writer must read appear first. */
function rankedSources(files: ReadonlyArray<CodewikiFile>): string[] {
	return [...files]
		.sort((a, b) => {
			const roleRank = (file: CodewikiFile): number => (file.role === "entry" ? 0 : file.role === "test" ? 2 : 1);
			return roleRank(a) - roleRank(b) || b.loc - a.loc || a.path.localeCompare(b.path);
		})
		.slice(0, MAX_PAGE_SOURCES)
		.map((file) => file.path);
}

function collectAreas(source: ReadonlyArray<CodewikiFile>, areaDepth: number): Area[] {
	const byKey = new Map<string, Area>();
	for (const file of source) {
		const key = areaForPath(file.path, areaDepth);
		const area = byKey.get(key) ?? { key, files: [], lines: 0 };
		area.files.push(file);
		area.lines += Math.max(0, file.loc);
		byKey.set(key, area);
	}
	return [...byKey.values()].sort((a, b) => b.lines - a.lines || a.key.localeCompare(b.key));
}

/**
 * The architecture page every wiki gets. It is the one page whose subject is
 * the repository rather than a directory, so it is anchored on indexed entry
 * points instead of an area.
 */
function overviewPage(source: ReadonlyArray<CodewikiFile>): WikiPlanPage {
	const entries = source.filter((file) => file.role === "entry");
	return {
		path: "architecture.md",
		title: "Architecture",
		intent:
			"Explain what this repository is, its top-level composition, how a request or command flows through it, " +
			"and where the boundaries between its major areas are.",
		sources: rankedSources(entries.length > 0 ? entries : source),
		status: "pending",
		attempts: 0,
	};
}

/**
 * Build the candidate skeleton from the index. Areas above the depth threshold
 * become pages; the rest fold their files into the closest ancestor page that
 * did, so a small directory is documented somewhere rather than dropped.
 */
export function buildCandidatePlan(codewiki: Codewiki, depth: ResolvedWikiDepth): WikiPlan {
	const source = codewiki.files.filter((file) => file.lang !== "config");
	const totalLines = source.reduce((total, file) => total + Math.max(0, file.loc), 0);
	const { areaDepth, areaShare, minAreaLines } = WIKI_DEPTH_STRATEGY[depth];
	const threshold = Math.max(minAreaLines, Math.floor(totalLines * areaShare));
	const areas = collectAreas(source, areaDepth);
	const included = areas.filter((area) => area.lines >= threshold);
	// A repository whose areas are all below threshold still gets pages: the
	// largest area always earns one, so a small repo is never reduced to a
	// single architecture page with nothing under it.
	const selected = included.length > 0 ? included : areas.slice(0, 1);
	const selectedKeys = new Set(selected.map((area) => area.key));
	const extras = new Map<string, CodewikiFile[]>();
	for (const area of areas) {
		if (selectedKeys.has(area.key)) continue;
		const ancestor = selected.find((candidate) => area.key.startsWith(`${candidate.key}/`));
		const host = ancestor?.key ?? selected[0]?.key;
		if (host === undefined) continue;
		extras.set(host, [...(extras.get(host) ?? []), ...area.files]);
	}
	const pages = selected.map((area): WikiPlanPage => {
		const files = [...area.files, ...(extras.get(area.key) ?? [])];
		return {
			path: pagePathForArea(area.key),
			title: titleForArea(area.key),
			intent:
				`Document ${area.key} (${area.files.length} indexed files, ${area.lines} lines): what it owns, its entry ` +
				"points and important symbols, the state and lifecycle invariants it enforces, an upstream caller and a " +
				"downstream dependency, the focused tests that prove its behavior, and what to watch when editing it.",
			sources: rankedSources(files),
			status: "pending",
			attempts: 0,
		};
	});
	return dedupePagePaths({
		version: 1,
		overview: "",
		pages: [overviewPage(source), ...pages],
	});
}

/** Two areas can slug to one path; keep the first and suffix the rest. */
function dedupePagePaths(plan: WikiPlan): WikiPlan {
	const seen = new Set<string>();
	const pages: WikiPlanPage[] = [];
	for (const page of plan.pages) {
		let path = page.path;
		let suffix = 2;
		while (seen.has(path)) {
			path = page.path.replace(/\.md$/, `-${suffix}.md`);
			suffix += 1;
		}
		seen.add(path);
		pages.push({ ...page, path });
	}
	return { ...plan, pages };
}

export function planWikiGeneration(codewiki: Codewiki, requestedDepth: WikiDepth = "auto"): WikiGenerationPlan {
	const source = codewiki.files.filter((file) => file.lang !== "config");
	const sourceFiles = source.length;
	const sourceLines = source.reduce((total, file) => total + Math.max(0, file.loc), 0);
	const depth = requestedDepth === "auto" ? classifyDepth(sourceFiles, sourceLines) : requestedDepth;
	return { requestedDepth, depth, sourceFiles, sourceLines, plan: buildCandidatePlan(codewiki, depth) };
}
