import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";

export interface WikiPage {
	path: string;
	title: string;
}

export type WikiLayoutValidation = { ok: true } | { ok: false; problems: string[] };

function compareStrings(a: string, b: string): number {
	return a.localeCompare(b);
}

function wikiPageFileNamesInDir(dir: string): string[] {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !WIKI_TEMPORARY_PAGE_NAMES.has(entry.name))
		.map((entry) => entry.name)
		.sort(compareStrings);
}

export const WIKI_TEMPORARY_PAGE_NAMES: ReadonlySet<string> = new Set(["_plan.md", "plan.md"]);

/**
 * The page's own H1, or null when it has none. Validation and the title reader
 * share this one definition, so a page that promotes is exactly a page whose
 * title the reader could find.
 */
function wikiPageHeading(text: string): string | null {
	const heading = /^#\s+(.+?)\s*$/m.exec(text)?.[1]?.trim();
	return heading && heading.length > 0 ? heading : null;
}

function titleFromPage(name: string, text: string): string {
	return wikiPageHeading(text) ?? name;
}

export function wikiDir(cwd: string): string {
	return join(cwd, ".clio", "wiki");
}

export function listWikiPagesInDir(dir: string): WikiPage[] {
	const pages: WikiPage[] = [];
	for (const name of wikiPageFileNamesInDir(dir)) {
		let text = "";
		try {
			text = readFileSync(join(dir, name), "utf8");
		} catch {
			text = "";
		}
		pages.push({ path: name, title: titleFromPage(name, text) });
	}
	return pages;
}

export function listWikiPages(cwd: string): WikiPage[] {
	return listWikiPagesInDir(wikiDir(cwd));
}

export interface WikiPageBounds {
	/** Retained for compatibility; no longer enforced. */
	minPages?: number;
	/** Retained for compatibility; no longer enforced. */
	maxPages?: number;
	/** Retained for compatibility; no longer enforced. */
	minPageBytes?: number;
	/** When present, validate generated source citations and internal wiki links. */
	sourceRoot?: string;
}

function isWithin(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

const SOURCE_REFERENCE =
	/`((?:src|tests?|scripts|benchmarks|docs|packages|apps|lib|config|\.github)\/[^`\s:#]+)(?::(\d+)(?:-\d+)?)?(?::[A-Za-z_$][\w$.-]*)?`/g;

function resolveCitedSource(sourceRoot: string, cited: string): string | null {
	// Backticked globs and schematic placeholders describe a source family, not
	// one concrete citation. They cannot be checked with existsSync.
	if (/[*?{}<>]/.test(cited)) return null;
	const direct = normalize(join(sourceRoot, cited));
	if (!isWithin(sourceRoot, direct)) return direct;
	if (existsSync(direct)) return direct;
	// TypeScript's local imports intentionally use .js specifiers. Documentation
	// may name that wire/module path even though the authored source is .ts/.tsx.
	if (cited.endsWith(".js")) {
		for (const extension of [".ts", ".tsx"] as const) {
			const authored = normalize(join(sourceRoot, `${cited.slice(0, -3)}${extension}`));
			if (isWithin(sourceRoot, authored) && existsSync(authored)) return authored;
		}
	}
	return direct;
}

function validateWikiReferences(
	dir: string,
	pages: ReadonlyArray<string>,
	texts: ReadonlyMap<string, string>,
	sourceRoot: string,
): string[] {
	const problems: string[] = [];
	const pageSet = new Set(pages);
	const quickstart = texts.get("quickstart.md") ?? "";
	for (const page of pages) {
		if (page === "quickstart.md") continue;
		const escaped = page.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (!new RegExp(`\\[[^\\]]+\\]\\(${escaped}(?:#[^)]+)?\\)`).test(quickstart)) {
			problems.push(`quickstart.md does not link ${page}`);
		}
	}
	for (const [page, text] of texts) {
		for (const match of text.matchAll(/\[[^\]]+\]\((?![a-z]+:|#)([^/)#\s]+\.md)(?:#[^)]+)?\)/gi)) {
			const target = normalize(join(dir, match[1] ?? ""));
			if (!isWithin(dir, target) || !pageSet.has(relative(dir, target))) {
				problems.push(`${page} links missing wiki page ${match[1]}`);
			}
		}
		for (const match of text.matchAll(SOURCE_REFERENCE)) {
			const cited = match[1] ?? "";
			const target = resolveCitedSource(sourceRoot, cited);
			if (target === null) continue;
			if (!isWithin(sourceRoot, target) || !existsSync(target)) {
				problems.push(`${page} cites missing source path ${cited}`);
				continue;
			}
			const line = Number(match[2] ?? 0);
			if (line > 0) {
				try {
					const lines = readFileSync(target, "utf8").split(/\r?\n/).length;
					if (line > lines) problems.push(`${page} cites ${cited}:${line}, past end of file (${lines} lines)`);
				} catch {
					problems.push(`${page} cites unreadable source path ${cited}`);
				}
			}
		}
	}
	return problems;
}

export function validateWikiLayoutInDir(dir: string, bounds: WikiPageBounds = {}): WikiLayoutValidation {
	const pages = wikiPageFileNamesInDir(dir);
	const problems: string[] = [];
	const texts = new Map<string, string>();
	if (!existsSync(join(dir, "quickstart.md"))) {
		problems.push("quickstart.md is missing");
	}
	for (const page of pages) {
		try {
			const stat = statSync(join(dir, page));
			const text = readFileSync(join(dir, page), "utf8");
			texts.set(page, text);
			if (stat.size === 0 || text.trim().length === 0) {
				problems.push(`${page} is empty`);
			} else if (wikiPageHeading(text) === null) {
				// Without an H1 the page has no title, and `meta.json` records the
				// literal filename as one. That is checkable, so it is checked here
				// rather than asked for in a prompt sentence the writer may miss.
				problems.push(`${page} has no H1 title heading`);
			}
		} catch {
			problems.push(`${page} is unreadable`);
		}
	}
	if (bounds.sourceRoot !== undefined && existsSync(join(dir, "quickstart.md"))) {
		problems.push(...validateWikiReferences(dir, pages, texts, bounds.sourceRoot));
	}
	return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

export function validateWikiLayout(cwd: string, bounds: WikiPageBounds = {}): WikiLayoutValidation {
	return validateWikiLayoutInDir(wikiDir(cwd), bounds);
}
