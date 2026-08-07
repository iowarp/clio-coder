/**
 * Reading, sanitizing, and checkpointing the page plan.
 *
 * The plan file is the one piece of state that survives an interrupted run, so
 * every function here is total: a plan that cannot be parsed, or an authored
 * rewrite that is malformed, degrades to the deterministic candidate instead of
 * ending the run. Progress is harness-owned: it is believed when read back from
 * the harness's own checkpoint and discarded when read from a document a model
 * just rewrote, so a planning pass cannot mark its own pages finished.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { isGeneratedWikiFile, WIKI_PLAN_FILE } from "./layout.js";
import type { WikiPageStatus, WikiPlan, WikiPlanPage } from "./plan.js";

/** Dispatches one page may receive across all runs before it is left alone. */
export const MAX_PAGE_ATTEMPTS = 3;

/** Longest authored intent kept, so one bad entry cannot bloat a page prompt. */
const MAX_INTENT_CHARS = 600;

/** Most pages a plan may carry, bounding an authored rewrite's blast radius. */
const MAX_PLAN_PAGES = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usableString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringList(value: unknown, limit: number): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const entry of value) {
		const usable = usableString(entry);
		if (usable && !out.includes(usable)) out.push(usable);
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * A page path a writer may be pointed at: relative, Markdown, inside the wiki
 * root, and not one of the generated navigation files. Returns null for
 * anything else, which drops the entry rather than failing the plan.
 */
export function sanitizePagePath(value: unknown): string | null {
	const raw = usableString(value);
	if (raw === null) return null;
	const normalized = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
	if (!normalized.endsWith(".md") || normalized.length > 200) return null;
	const segments = normalized.split("/");
	if (
		segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.startsWith("."))
	) {
		return null;
	}
	if (isGeneratedWikiFile(normalized)) return null;
	return normalized;
}

export function wikiPlanPath(dir: string): string {
	return join(dir, WIKI_PLAN_FILE);
}

function parsedStatus(value: unknown): WikiPageStatus | null {
	return value === "written" || value === "pending" ? value : null;
}

function parsedAttempts(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export interface SanitizeWikiPlanOptions {
	/**
	 * Whether the recorded progress in this document may be believed.
	 *
	 * True for the harness's own checkpoint and for the plan stored in metadata:
	 * that is where progress is written, so reading it back is how a run resumes.
	 * False for a document a model just rewrote, because a planning pass that
	 * marked its pages finished would skip every one of them. Progress the
	 * harness already knows, passed as `previous`, always wins over both.
	 */
	trustStatus: boolean;
}

/**
 * Parse a plan, preferring harness-owned progress from `previous` for any page
 * whose path survived. Returns null when nothing usable is left, so the caller
 * falls back to the candidate plan.
 */
export function sanitizeWikiPlan(
	value: unknown,
	previous?: WikiPlan,
	options: SanitizeWikiPlanOptions = { trustStatus: true },
): WikiPlan | null {
	if (!isRecord(value) || !Array.isArray(value.pages)) return null;
	const priorByPath = new Map((previous?.pages ?? []).map((page) => [page.path, page] as const));
	const pages: WikiPlanPage[] = [];
	const seen = new Set<string>();
	for (const entry of value.pages) {
		if (pages.length >= MAX_PLAN_PAGES) break;
		if (!isRecord(entry)) continue;
		const path = sanitizePagePath(entry.path);
		if (path === null || seen.has(path)) continue;
		const intent = usableString(entry.intent);
		const prior = priorByPath.get(path);
		const recorded = options.trustStatus ? parsedStatus(entry.status) : null;
		const recordedAttempts = options.trustStatus ? parsedAttempts(entry.attempts) : null;
		seen.add(path);
		pages.push({
			path,
			title: usableString(entry.title) ?? path.replace(/\.md$/, ""),
			intent: intent === null ? "" : intent.slice(0, MAX_INTENT_CHARS),
			sources: stringList(entry.sources, 16),
			status: prior?.status ?? recorded ?? "pending",
			attempts: prior?.attempts ?? recordedAttempts ?? 0,
		});
	}
	if (pages.length === 0) return null;
	return { version: 1, overview: usableString(value.overview) ?? previous?.overview ?? "", pages };
}

function readPlanDocument(dir: string): unknown {
	const filePath = wikiPlanPath(dir);
	if (!existsSync(filePath)) return undefined;
	try {
		return JSON.parse(readFileSync(filePath, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Read the harness's checkpoint. Returns null when absent, unreadable, or
 * unusable.
 */
export function readWikiPlanFile(dir: string, previous?: WikiPlan): WikiPlan | null {
	const document = readPlanDocument(dir);
	return document === undefined ? null : sanitizeWikiPlan(document, previous, { trustStatus: true });
}

/**
 * Read the plan file as a document a planning pass just rewrote: its structure
 * is taken, its progress is not.
 */
export function readAuthoredWikiPlan(dir: string, previous: WikiPlan): WikiPlan | null {
	const document = readPlanDocument(dir);
	return document === undefined ? null : sanitizeWikiPlan(document, previous, { trustStatus: false });
}

export function writeWikiPlanFile(dir: string, plan: WikiPlan): void {
	safeResourceWrite(wikiPlanPath(dir), `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8" });
}

/**
 * Candidate pages for areas no existing page covers.
 *
 * These are offered to a planning pass, never appended to a settled plan. The
 * index proposes paths derived from directory names; a planner routinely
 * renames and regroups them, so appending by path would grow a second, machine-
 * named copy of coverage that already exists. An area counts as covered when
 * some page claims one of its sources, whatever that page ended up being called.
 */
export function unclaimedCandidates(
	plan: WikiPlan,
	candidate: WikiPlan,
	pageSources: ReadonlyMap<string, ReadonlyArray<string>> = new Map(),
): WikiPlanPage[] {
	const knownPaths = new Set(plan.pages.map((page) => page.path));
	const claimed = new Set<string>();
	for (const page of plan.pages) {
		for (const source of [...page.sources, ...(pageSources.get(page.path) ?? [])]) claimed.add(source);
	}
	return candidate.pages.filter(
		(page) => !knownPaths.has(page.path) && !page.sources.some((source) => claimed.has(source)),
	);
}

export interface ScopeUpdateInput {
	plan: WikiPlan;
	/** Repository-relative paths that changed since the wiki was last written. */
	changedPaths: ReadonlySet<string>;
	/** Wiki-relative page paths that exist on disk right now. */
	existingPages: ReadonlySet<string>;
	/** Per-page source paths drawn from each page's front matter. */
	pageSources: ReadonlyMap<string, ReadonlyArray<string>>;
}

/**
 * Decide what an update run owes. A page is rewritten when a source it claims
 * has changed or when its file is missing; everything else is already current
 * and is skipped. This is what replaces asking a model to guess which pages a
 * diff invalidates: the answer is computed from the sources each page recorded
 * in its own front matter.
 */
export function scopePlanForUpdate(input: ScopeUpdateInput): WikiPlan {
	const changedPrefixes = [...input.changedPaths];
	const pages = input.plan.pages.map((page): WikiPlanPage => {
		if (!input.existingPages.has(page.path)) return { ...page, status: "pending", attempts: 0 };
		const claimed = [...(input.pageSources.get(page.path) ?? []), ...page.sources];
		const touched = claimed.some((source) =>
			changedPrefixes.some((changed) => changed === source || changed.startsWith(`${source}/`)),
		);
		return touched ? { ...page, status: "pending", attempts: 0 } : { ...page, status: "written" };
	});
	return { ...input.plan, pages };
}

/** Pages this run still owes, in plan order, excluding ones already exhausted. */
export function pendingPages(plan: WikiPlan): WikiPlanPage[] {
	return plan.pages.filter((page) => page.status !== "written" && page.attempts < MAX_PAGE_ATTEMPTS);
}
