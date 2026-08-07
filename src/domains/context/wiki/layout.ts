/**
 * Where wiki pages live and how they are discovered.
 *
 * The tree is nested: `quickstart.md` is the root entrypoint, content pages
 * live at paths like `domains/dispatch.md`, and every directory carries a
 * generated `index.md`. Page identity is the POSIX-relative path inside
 * `.clio/wiki`, which is what `code_nav mode=wiki` resolves and what
 * `meta.json` records.
 *
 * This module only finds and names pages. Nothing here can fail a run:
 * deciding what a staged tree is missing, and fixing it, belongs to the
 * assembly pass in `assemble.ts`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readWikiPage } from "./frontmatter.js";

export interface WikiPage {
	/** POSIX-relative path inside the wiki root, e.g. `domains/dispatch.md`. */
	path: string;
	title: string;
	/** One-line description drawn from the page's front matter. */
	summary?: string;
}

/** The generated root entrypoint. Assembled deterministically, never authored. */
export const WIKI_QUICKSTART = "quickstart.md";

/** The generated per-directory index. Assembled deterministically, never authored. */
export const WIKI_INDEX = "index.md";

/** Harness-owned working state inside a staging tree; never promoted as a page. */
export const WIKI_PLAN_FILE = "_plan.json";

/**
 * Files inside the wiki root that are not content pages. `meta.json` and the
 * staged plan are harness state; `index.md` files are generated navigation and
 * are excluded so a page count means content, not scaffolding.
 */
const NON_PAGE_FILES: ReadonlySet<string> = new Set(["meta.json", WIKI_PLAN_FILE]);

function compareStrings(a: string, b: string): number {
	return a.localeCompare(b);
}

export function wikiDir(cwd: string): string {
	return join(cwd, ".clio", "wiki");
}

/**
 * Every Markdown file under `dir`, as POSIX-relative paths, sorted. Recurses
 * into section directories; skips dot-directories and non-Markdown files.
 * Returns an empty list for a missing directory rather than throwing, so
 * callers can ask about a wiki that does not exist yet.
 */
export function wikiMarkdownFilesInDir(dir: string, prefix = ""): string[] {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(join(dir, prefix), { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const relPath = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			files.push(...wikiMarkdownFilesInDir(dir, relPath));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".md") && !NON_PAGE_FILES.has(entry.name)) {
			files.push(relPath);
		}
	}
	return files.sort(compareStrings);
}

/** True for a generated navigation file the writer must never author. */
export function isGeneratedWikiFile(relPath: string): boolean {
	return relPath === WIKI_QUICKSTART || relPath === WIKI_INDEX || relPath.endsWith(`/${WIKI_INDEX}`);
}

/**
 * Content pages under `dir`, with the title and summary carried by each page's
 * own front matter. Directory indexes are excluded; `quickstart.md` is
 * included because it is a page an agent reads and resolves by name.
 */
export function listWikiPagesInDir(dir: string): WikiPage[] {
	const pages: WikiPage[] = [];
	for (const relPath of wikiMarkdownFilesInDir(dir)) {
		if (relPath !== WIKI_QUICKSTART && isGeneratedWikiFile(relPath)) continue;
		let content = "";
		try {
			content = readFileSync(join(dir, relPath), "utf8");
		} catch {
			content = "";
		}
		const { metadata } = readWikiPage({ pagePath: relPath, content });
		pages.push({
			path: relPath,
			title: metadata.title,
			...(metadata.summary.length > 0 ? { summary: metadata.summary } : {}),
		});
	}
	return pages;
}

export function listWikiPages(cwd: string): WikiPage[] {
	return listWikiPagesInDir(wikiDir(cwd));
}
