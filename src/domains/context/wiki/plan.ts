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

import type { Codewiki, CodewikiFile } from "../codewiki/schema.js";
import { isGeneratedWikiFile } from "./layout.js";
import type { WikiSourceContent } from "./source-content.js";

export type WikiDepth = "auto" | "simple" | "medium" | "detailed";
export type ResolvedWikiDepth = Exclude<WikiDepth, "auto">;

export type WikiPageStatus = "pending" | "written";

export interface WikiPageFailure {
	phase: "admission" | "writer" | "validation";
	detail: string;
	runId?: string;
}

export interface WikiPlanPage {
	/** POSIX-relative page path inside the wiki root. */
	path: string;
	title: string;
	/** What this page must document, in one or two sentences. */
	intent: string;
	/** Repository-relative source files that ground the page. */
	sources: string[];
	/** Harness-owned cited source/test paths retained even after routing repair drops a missing path. */
	dependencies?: string[];
	/** Harness-owned: whether this page has been written in a completed dispatch. */
	status: WikiPageStatus;
	/** Harness-owned: admitted writer attempts for this page specification, including explicit retries. */
	attempts: number;
	/** Last unsuccessful outcome, retained across publication and authored replanning. */
	lastFailure?: WikiPageFailure;
}

export interface WikiPlan {
	version: 1;
	/** Harness-owned resolved coverage depth; absent in legacy checkpoints. */
	depth?: ResolvedWikiDepth;
	/** Harness-owned policy, retained before the first publication on interrupted runs. */
	requestedDepth?: WikiDepth;
	/** Source revision observed before dispatch; stale checkpoints must be revalidated. */
	sourceTreeHash?: string;
	/** Harness-captured Git baseline for resuming before any wiki has been published. */
	sourceGitHead?: string;
	/** Source bytes observed before dispatch, shared across page dependencies. */
	sourceContent?: WikiSourceContent;
	/** Harness-owned retirements from authored replanning; explicit reintroduction clears a path. */
	retiredPages?: string[];
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

export const MAX_PLAN_PAGES = 200;
export const MAX_PLAN_PATH_CHARS = 200;
export const MAX_PLAN_INTENT_CHARS = 600;
export const MAX_MEDIUM_OWNERSHIP_PAGES = 24;
const MEDIUM_SPLIT_LINES = 8_000;

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
	let stem = areaSegments(area)
		.map(slugSegment)
		.join("/")
		.slice(0, MAX_PLAN_PATH_CHARS - 3)
		.replace(/\/+$/, "");
	if (isGeneratedWikiFile(`${stem}.md`)) stem = `${stem.slice(0, MAX_PLAN_PATH_CHARS - 8).replace(/\/+$/, "")}-area`;
	return `${stem}.md`;
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

function mediumOwnership(areas: Area[], threshold: number): Area[] {
	const splitLines = Math.max(
		MEDIUM_SPLIT_LINES,
		Math.ceil(areas.reduce((sum, area) => sum + area.lines, 0) / MAX_MEDIUM_OWNERSHIP_PAGES),
	);
	const included = areas.filter((area) => area.lines >= threshold);
	const selected = included.length > 0 ? included : areas.slice(0, 1);
	const owned = new Map(
		selected.slice(0, MAX_MEDIUM_OWNERSHIP_PAGES - 1).map((area) => [area.key, { ...area, files: [...area.files] }]),
	);
	const selectedKeys = new Set(owned.keys());
	for (const area of areas) {
		if (selectedKeys.has(area.key)) continue;
		const ancestor = [...owned.keys()]
			.filter((key) => area.key.startsWith(`${key}/`))
			.sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
		const parent = area.key.split("/").slice(0, -1).join("/") || ".";
		const key = owned.has(area.key)
			? area.key
			: (ancestor ?? (owned.has(parent) || owned.size < MAX_MEDIUM_OWNERSHIP_PAGES - 1 ? parent : "."));
		const host = owned.get(key) ?? { key, files: [], lines: 0 };
		host.files.push(...area.files);
		host.lines += area.lines;
		owned.set(key, host);
	}
	const result = [...owned.values()].sort((a, b) => b.lines - a.lines || a.key.localeCompare(b.key));
	for (let position = 0; position < result.length; position += 1) {
		const area = result[position];
		if (!area || area.lines <= splitLines) continue;
		const { areaShare, minAreaLines } = WIKI_DEPTH_STRATEGY.medium;
		const childThreshold = Math.max(minAreaLines, Math.floor(area.lines * areaShare));
		let childDepth = area.key === "." ? 1 : area.key.split("/").length + 1;
		let children = collectAreas(area.files, childDepth);
		while (children.length === 1 && children[0]?.key !== area.key) {
			const child = children[0];
			const next = collectAreas(area.files, childDepth + 1);
			if (next.length === 1 && next[0]?.key === child?.key) break;
			children = next;
			childDepth += 1;
		}
		const substantial = children.filter((child) => child.key !== area.key && child.lines >= childThreshold);
		const keys = new Set(substantial.map((child) => child.key));
		const remainder = children.filter((child) => !keys.has(child.key));
		const split = [
			...substantial,
			...(remainder.length > 0
				? [
						{
							key: area.key,
							files: remainder.flatMap((child) => child.files),
							lines: remainder.reduce((sum, child) => sum + child.lines, 0),
						},
					]
				: []),
		];
		if (split.length < 2) continue;
		const merged = new Map(result.filter((_, index) => index !== position).map((entry) => [entry.key, entry]));
		for (const child of split) {
			const existing = merged.get(child.key);
			merged.set(
				child.key,
				existing
					? { key: child.key, files: [...existing.files, ...child.files], lines: existing.lines + child.lines }
					: child,
			);
		}
		if (merged.size > MAX_MEDIUM_OWNERSHIP_PAGES) continue;
		result.splice(0, result.length, ...merged.values());
		result.sort((a, b) => b.lines - a.lines || a.key.localeCompare(b.key));
		position = -1;
	}
	for (const area of result) area.files.sort((a, b) => a.path.localeCompare(b.path));
	return result.sort((a, b) => b.lines - a.lines || a.key.localeCompare(b.key));
}

/**
 * The architecture page every wiki gets. It is the one page whose subject is
 * the repository rather than a directory. With separate area pages it is
 * anchored on indexed entry points; a combined simple page uses its full
 * ownership group's ranked anchors instead.
 */
function overviewPage(source: ReadonlyArray<CodewikiFile>): WikiPlanPage {
	const entries = source.filter((file) => file.role === "entry");
	return {
		path: "architecture.md",
		title: "Architecture",
		intent:
			"Explain what this repository is and its top-level composition; describe relationships, boundaries, " +
			"and request or command flow where the inspected source establishes them.",
		sources: rankedSources(entries.length > 0 ? entries : source),
		status: "pending",
		attempts: 0,
	};
}

/** Counts describe assigned indexed coverage, not the bounded prompt anchors. */
function intentForScope(
	files: ReadonlyArray<CodewikiFile>,
	areaDepth: number,
	maxChars = MAX_PLAN_INTENT_CHARS,
): string {
	const lines = files.reduce((total, file) => total + Math.max(0, file.loc), 0);
	const introduction =
		`Assigned scope (${files.length} indexed files, ${lines} lines): document responsibilities and key entry points/symbols; ` +
		"explain lifecycle rules, callers, dependencies, and specific test cases only where inspected source or tests " +
		"establish them. Anchors are starting points, not the full assignment. Assigned areas: ";
	let scopeDepth = areaDepth;
	let scopes = [...new Set(files.map((file) => areaForPath(file.path, scopeDepth)))].sort();
	while (introduction.length + scopes.join(", ").length + 1 > maxChars && scopeDepth > 1) {
		scopeDepth -= 1;
		scopes = [...new Set(files.map((file) => areaForPath(file.path, scopeDepth)))].sort();
	}
	const description = scopes.join(", ");
	return `${introduction}${introduction.length + description.length + 1 <= maxChars ? description : "repository root"}.`;
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
	// If every area is below threshold, the largest hosts the folded coverage.
	// At simple depth a single ownership group shares the architecture page.
	const selected =
		depth === "medium" ? mediumOwnership(areas, threshold) : included.length > 0 ? included : areas.slice(0, 1);
	const selectedKeys = new Set(selected.map((area) => area.key));
	const extras = new Map<string, CodewikiFile[]>();
	for (const area of areas) {
		if (depth === "medium") break;
		if (selectedKeys.has(area.key)) continue;
		const ancestor = selected.find((candidate) => area.key.startsWith(`${candidate.key}/`));
		const host = ancestor?.key ?? selected[0]?.key;
		if (host === undefined) continue;
		extras.set(host, [...(extras.get(host) ?? []), ...area.files]);
	}
	const overview = overviewPage(source);
	const [onlyArea] = selected;
	if (depth === "simple" && selected.length === 1 && onlyArea) {
		const files = [...onlyArea.files, ...(extras.get(onlyArea.key) ?? [])];
		return {
			version: 1,
			depth,
			overview: "",
			pages: [
				{
					...overview,
					intent: `${overview.intent} ${intentForScope(files, areaDepth, MAX_PLAN_INTENT_CHARS - overview.intent.length - 1)}`,
					sources: rankedSources(files),
				},
			],
		};
	}
	const pages = selected.map((area): WikiPlanPage => {
		const files = [...area.files, ...(extras.get(area.key) ?? [])];
		return {
			path: pagePathForArea(area.key),
			title: titleForArea(area.key),
			intent: intentForScope(
				files,
				depth === "medium" ? (area.key === "." ? 1 : area.key.split("/").length + 1) : areaDepth,
			),
			sources: rankedSources(files),
			status: "pending",
			attempts: 0,
		};
	});
	if (pages.length > 0) {
		overview.intent +=
			" Link to the area pages for detailed behavior; keep this page focused on their composition and relationships.";
	}
	return dedupePagePaths({
		version: 1,
		depth,
		overview: "",
		pages: [overview, ...pages],
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
			const ending = `-${suffix}.md`;
			path = `${page.path
				.slice(0, -3)
				.slice(0, MAX_PLAN_PATH_CHARS - ending.length)
				.replace(/\/+$/, "")}${ending}`;
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
	return {
		requestedDepth,
		depth,
		sourceFiles,
		sourceLines,
		plan: { ...buildCandidatePlan(codewiki, depth), requestedDepth },
	};
}
