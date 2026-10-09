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

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import type { Codewiki } from "../codewiki/schema.js";
import { isGeneratedWikiFile, WIKI_PLAN_FILE } from "./layout.js";
import type { ResolvedWikiDepth, WikiPageFailure, WikiPageStatus, WikiPlan, WikiPlanPage } from "./plan.js";
import {
	MAX_MEDIUM_OWNERSHIP_PAGES,
	MAX_PLAN_INTENT_CHARS,
	MAX_PLAN_PAGES,
	MAX_PLAN_PATH_CHARS,
	newCoverageCandidates,
} from "./plan.js";
import { parseWikiSourceContent } from "./source-content.js";

/** Dispatches one page may receive across all runs before it is left alone. */
export const MAX_PAGE_ATTEMPTS = 3;

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
	if (!normalized.endsWith(".md") || normalized.length > MAX_PLAN_PATH_CHARS) return null;
	const segments = normalized.split("/");
	if (
		segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.startsWith("."))
	) {
		return null;
	}
	if (isGeneratedWikiFile(normalized)) return null;
	return normalized;
}

function wikiPlanPath(dir: string): string {
	return join(dir, WIKI_PLAN_FILE);
}

function parsedStatus(value: unknown): WikiPageStatus | null {
	return value === "written" || value === "pending" ? value : null;
}

function parsedAttempts(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parsedFailure(value: unknown): WikiPageFailure | undefined {
	if (!isRecord(value)) return undefined;
	const phase = value.phase;
	if (phase !== "admission" && phase !== "writer" && phase !== "validation") return undefined;
	const detail = usableString(value.detail);
	if (!detail) return undefined;
	const runId = usableString(value.runId)?.slice(0, 120);
	return { phase, detail: detail.replace(/\s+/gu, " ").slice(0, 500), ...(runId ? { runId } : {}) };
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
 * whose path and specification survived. Returns null when nothing usable is left, so the caller
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
		const intent = (usableString(entry.intent) ?? "").slice(0, MAX_PLAN_INTENT_CHARS);
		const title = usableString(entry.title) ?? path.replace(/\.md$/, "");
		const sources = stringList(entry.sources, 16);
		const prior = priorByPath.get(path);
		const changedSpec =
			prior !== undefined &&
			(prior.title !== title ||
				prior.intent !== intent ||
				JSON.stringify([...prior.sources].sort()) !== JSON.stringify([...sources].sort()));
		const recorded = options.trustStatus ? parsedStatus(entry.status) : null;
		const recordedAttempts = options.trustStatus ? parsedAttempts(entry.attempts) : null;
		const lastFailure = prior?.lastFailure ?? (options.trustStatus ? parsedFailure(entry.lastFailure) : undefined);
		const dependencies =
			prior?.dependencies ?? (options.trustStatus ? stringList(entry.dependencies, Number.POSITIVE_INFINITY) : []);
		seen.add(path);
		pages.push({
			path,
			title,
			intent,
			sources,
			...(dependencies.length > 0 ? { dependencies } : {}),
			status: changedSpec ? "pending" : (prior?.status ?? recorded ?? "pending"),
			attempts: changedSpec ? 0 : (prior?.attempts ?? recordedAttempts ?? 0),
			...(!changedSpec && (prior?.status ?? recorded) !== "written" && lastFailure ? { lastFailure } : {}),
		});
	}
	if (pages.length === 0) return null;
	const ownerCount = (list: readonly { path: string }[]): number =>
		list.filter((page) => page.path !== "architecture.md").length;
	// Retaining a previous plan that is already over the ceiling enforces nothing, so only reject growth past it.
	if (
		!options.trustStatus &&
		previous?.depth === "medium" &&
		ownerCount(previous.pages) <= MAX_MEDIUM_OWNERSHIP_PAGES &&
		ownerCount(pages) > MAX_MEDIUM_OWNERSHIP_PAGES
	)
		return null;
	const retiredPages = [
		...new Set([
			...(previous?.retiredPages ?? (options.trustStatus ? stringList(value.retiredPages, MAX_PLAN_PAGES) : [])),
			...(previous?.pages.filter((page) => !seen.has(page.path)).map((page) => page.path) ?? []),
		]),
	]
		.map(sanitizePagePath)
		.filter((path): path is string => path !== null && !seen.has(path));
	const sourceContent =
		previous?.sourceContent ?? (options.trustStatus ? parseWikiSourceContent(value.sourceContent) : undefined);
	const sourceTreeHash = previous?.sourceTreeHash ?? (options.trustStatus ? value.sourceTreeHash : undefined);
	const sourceGitHead = previous?.sourceGitHead ?? (options.trustStatus ? value.sourceGitHead : undefined);
	const depth = previous?.depth ?? (options.trustStatus ? value.depth : undefined);
	const requestedDepth = previous?.requestedDepth ?? (options.trustStatus ? value.requestedDepth : undefined);
	return {
		version: 1,
		...(depth === "simple" || depth === "medium" || depth === "detailed" ? { depth } : {}),
		...(requestedDepth === "auto" ||
		requestedDepth === "simple" ||
		requestedDepth === "medium" ||
		requestedDepth === "detailed"
			? { requestedDepth }
			: {}),
		...(sourceContent ? { sourceContent } : {}),
		...(retiredPages.length ? { retiredPages } : {}),
		...(typeof sourceTreeHash === "string" && /^[a-f0-9]{64}$/.test(sourceTreeHash) ? { sourceTreeHash } : {}),
		...(typeof sourceGitHead === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceGitHead)
			? { sourceGitHead }
			: {}),
		overview: usableString(value.overview) ?? previous?.overview ?? "",
		pages,
	};
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

export function validateWikiPlanAnchors(
	plan: WikiPlan,
	cwd: string,
	onRejected: (page: string, sources: string[]) => void,
): WikiPlan {
	let root: string;
	try {
		root = realpathSync(cwd);
	} catch {
		return plan;
	}
	return {
		...plan,
		pages: plan.pages.map((page) => {
			const sources = page.sources.filter((source) => {
				if (isAbsolute(source)) return false;
				try {
					const file = realpathSync(resolve(root, source));
					const rel = relative(root, file);
					return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && statSync(file).isFile();
				} catch {
					// Missing or inaccessible anchors cannot ground a writer.
					return false;
				}
			});
			if (sources.length === page.sources.length) return page;
			onRejected(
				page.path,
				page.sources.filter((source) => !sources.includes(source)),
			);
			return { ...page, sources, status: "pending", attempts: page.status === "written" ? 0 : page.attempts };
		}),
	};
}

/**
 * Candidate areas whose entire assigned scope is absent from the saved baseline.
 *
 * These are offered to a planning pass, never appended to a settled plan.
 * A new file inside an existing scope, or a small directory that folds into
 * one, is absorbed by that page, and finer subdivision of baseline files keeps
 * the saved shape until an explicit replan. Legacy checkpoints without a
 * source inventory retain their existing shape.
 */
export function unclaimedCandidates(plan: WikiPlan, codewiki: Codewiki, depth: ResolvedWikiDepth): WikiPlanPage[] {
	const baseline = plan.sourceContent;
	if (!baseline || Object.keys(baseline).length === 0) return [];
	return newCoverageCandidates(codewiki, depth, (path) => Object.hasOwn(baseline, path));
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

/** An explicit operator retry includes exhausted pages without erasing their attempt history. */
export function pendingPages(plan: WikiPlan, retryExhausted = false): WikiPlanPage[] {
	return plan.pages.filter((page) => page.status !== "written" && (retryExhausted || page.attempts < MAX_PAGE_ATTEMPTS));
}
