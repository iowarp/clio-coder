/**
 * The deterministic pass that turns a tree of written pages into a wiki.
 *
 * Everything here used to be a reason to throw the whole run away. A missing
 * `quickstart.md`, a page with no H1, a link to a page that was never written,
 * a citation to a path that does not exist: each is mechanically fixable, and
 * failing a fifteen-minute generation over one of them destroyed work that was
 * otherwise good. So this pass repairs and reports; it never rejects.
 *
 * It runs after every generation, including one that ended early, which is what
 * makes a partial wiki coherent enough to promote. Because it regenerates
 * quickstart and every directory index from the pages actually on disk, those
 * files cannot drift, cannot miss a page, and are never something a model has
 * to remember to update.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize, posix, relative } from "node:path";
import { readWikiPage, renderWikiPage, resolveSourcePath, type WikiPageMetadata } from "./frontmatter.js";
import {
	isGeneratedWikiFile,
	listWikiPagesInDir,
	WIKI_INDEX,
	WIKI_QUICKSTART,
	type WikiPage,
	wikiMarkdownFilesInDir,
} from "./layout.js";
import type { WikiPlan } from "./plan.js";

/**
 * A backticked repository path in prose, optionally with `:line` or a trailing
 * `:symbol`. This is the citation form the page fragments ask for, so it is the
 * form checked here.
 */
const SOURCE_CITATION =
	/`((?:src|tests?|scripts|benchmarks|docs|packages|apps|lib|config|\.github)\/[^`\s:#]+)(?::(\d+)(?:-\d+)?)?(?::[A-Za-z_$][\w$.-]*)?`/g;

/** A relative Markdown link to another page, ignoring external and anchor-only hrefs. */
const INTERNAL_LINK = /\[[^\]]*\]\((?![a-z][a-z\d+.-]*:|\/\/|#)([^)\s]+\.md)(?:#[^)\s]*)?\)/gi;

/** Marker line carrying a page's unrepaired references; regenerated every pass. */
const REPAIR_NOTE = /^<!-- (?:clio-coder|clio):wiki .*-->$/gm;

export interface WikiPageIssue {
	page: string;
	kind: "link" | "citation";
	reference: string;
}

export interface WikiAssemblyReport {
	pages: WikiPage[];
	/** Pages whose front matter or heading had to be rebuilt. */
	repaired: number;
	/** Pages removed because they held no content. */
	dropped: string[];
	issues: WikiPageIssue[];
}

function readText(filePath: string): string {
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return "";
	}
}

function writeText(filePath: string, text: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, text, "utf8");
}

function stripRepairNotes(body: string): string {
	return body.replace(REPAIR_NOTE, "").replace(/\n{3,}/g, "\n\n");
}

function renderRepairNote(issues: ReadonlyArray<WikiPageIssue>): string {
	const links = issues.filter((issue) => issue.kind === "link").map((issue) => issue.reference);
	const citations = issues.filter((issue) => issue.kind === "citation").map((issue) => issue.reference);
	const parts: string[] = [];
	if (links.length > 0) parts.push(`unresolved links: ${[...new Set(links)].join(", ")}`);
	if (citations.length > 0) parts.push(`unresolved sources: ${[...new Set(citations)].join(", ")}`);
	return parts.length === 0 ? "" : `\n<!-- clio-coder:wiki ${parts.join("; ")} -->\n`;
}

/**
 * Repair one page in place and report what it still points at that is not
 * there. Prose is never rewritten: an unresolved reference is recorded in a
 * marker comment and dropped from the machine-readable metadata, so the next
 * update run gets a precise repair list without this pass editing sentences it
 * cannot understand.
 */
function repairPage(
	dir: string,
	sourceRoot: string,
	relPath: string,
	knownPages: ReadonlySet<string>,
): { metadata: WikiPageMetadata; changed: boolean; issues: WikiPageIssue[]; empty: boolean } {
	const filePath = join(dir, relPath);
	const original = readText(filePath);
	const parsed = readWikiPage({ pagePath: relPath, content: original, sourceRoot });
	const body = stripRepairNotes(parsed.body);
	if (body.replace(/^#.*$/gm, "").trim().length === 0) {
		return { metadata: parsed.metadata, changed: false, issues: [], empty: true };
	}

	const issues: WikiPageIssue[] = [];
	for (const cited of parsed.unresolvedPaths) {
		issues.push({ page: relPath, kind: "citation", reference: cited });
	}
	for (const match of body.matchAll(SOURCE_CITATION)) {
		const cited = match[1] ?? "";
		if (resolveSourcePath(sourceRoot, cited) === null) {
			issues.push({ page: relPath, kind: "citation", reference: cited });
		}
	}
	for (const match of body.matchAll(INTERNAL_LINK)) {
		const href = match[1] ?? "";
		const target = posix.normalize(posix.join(posix.dirname(relPath), href));
		if (target.startsWith("..") || !knownPages.has(target)) {
			issues.push({ page: relPath, kind: "link", reference: href });
		}
	}

	const rebuilt = `${renderWikiPage(parsed.metadata, body).trimEnd()}\n${renderRepairNote(issues)}`;
	if (rebuilt !== original) writeText(filePath, rebuilt);
	return { metadata: parsed.metadata, changed: rebuilt !== original, issues, empty: false };
}

function linkTo(fromDir: string, target: string): string {
	const href = posix.relative(fromDir === "." ? "" : fromDir, target);
	return href.length > 0 ? href : posix.basename(target);
}

function escapeCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function codeList(values: ReadonlyArray<string>, limit: number): string {
	if (values.length === 0) return "—";
	const shown = values.slice(0, limit).map((value) => `\`${escapeCell(value)}\``);
	return values.length > limit ? `${shown.join(", ")}, …` : shown.join(", ");
}

interface AssembledPage {
	path: string;
	metadata: WikiPageMetadata;
}

/**
 * Generate `quickstart.md`: the repository summary, a navigation tree over
 * every page, and the task-routing table that compresses the path from an
 * engineering intent to the owning sources, symbols, tests, and validation
 * command. Every row is drawn from a page's own front matter, so the table
 * cannot describe a page that is not there.
 */
function renderQuickstart(sourceRoot: string, plan: WikiPlan, pages: ReadonlyArray<AssembledPage>): string {
	const content = pages.filter((page) => page.path !== WIKI_QUICKSTART);
	const lines = [`# ${basename(sourceRoot)} wiki`, ""];
	if (plan.overview.trim().length > 0) lines.push(plan.overview.trim(), "");
	lines.push(
		`This wiki is generated by \`clio-coder context wiki\` from ${content.length} page${content.length === 1 ? "" : "s"}. ` +
			"Each page opens with front matter naming the sources, symbols, and tests it documents.",
		"",
		"## Pages",
		"",
	);
	let currentSection: string | null = null;
	for (const page of content) {
		const section = posix.dirname(page.path);
		if (section !== "." && section !== currentSection) {
			lines.push(`- **${section}/**`);
			currentSection = section;
		}
		const indent = section === "." ? "" : "  ";
		const summary = page.metadata.summary.length > 0 ? ` — ${page.metadata.summary}` : "";
		lines.push(`${indent}- [${page.metadata.title}](${page.path})${summary}`);
	}
	const routable = content.filter(
		(page) => page.metadata.sources.length > 0 || page.metadata.symbols.length > 0 || page.metadata.tests.length > 0,
	);
	if (routable.length > 0) {
		lines.push(
			"",
			"## Task routing",
			"",
			"| Area | Page | Sources | Symbols | Tests | Validate |",
			"| --- | --- | --- | --- | --- | --- |",
		);
		for (const page of routable) {
			lines.push(
				`| ${escapeCell(page.metadata.title)} | [${escapeCell(page.metadata.title)}](${page.path}) ` +
					`| ${codeList(page.metadata.sources, 3)} | ${codeList(page.metadata.symbols, 3)} ` +
					`| ${codeList(page.metadata.tests, 2)} | ${codeList(page.metadata.validate, 1)} |`,
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

/** Generate one directory's `index.md` from the pages and sections beneath it. */
function renderIndex(dir: string, pages: ReadonlyArray<AssembledPage>, sections: ReadonlyArray<string>): string {
	const title = dir === "." ? "Wiki" : dir.split("/").join(" / ");
	const lines = [`# ${title}`, ""];
	if (pages.length > 0) {
		for (const page of pages) {
			const summary = page.metadata.summary.length > 0 ? ` — ${page.metadata.summary}` : "";
			lines.push(`- [${page.metadata.title}](${linkTo(dir, page.path)})${summary}`);
		}
		lines.push("");
	}
	if (sections.length > 0) {
		lines.push("## Sections", "");
		for (const section of sections)
			lines.push(`- [${posix.basename(section)}/](${linkTo(dir, `${section}/${WIKI_INDEX}`)})`);
		lines.push("");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

export interface AssembleWikiInput {
	/** Directory holding the staged or live wiki tree. */
	dir: string;
	/** Repository root, used to check cited source paths. */
	sourceRoot: string;
	plan: WikiPlan;
}

/**
 * Repair every page, regenerate navigation, and report what remains
 * unresolved. Always succeeds: the returned report is diagnostics for the
 * operator and the next update run, not a verdict on the run.
 */
export function assembleWikiTree(input: AssembleWikiInput): WikiAssemblyReport {
	const { dir, sourceRoot } = input;
	const authored = wikiMarkdownFilesInDir(dir).filter((relPath) => !isGeneratedWikiFile(relPath));
	const knownPages = new Set([...authored, WIKI_QUICKSTART]);
	const assembled: AssembledPage[] = [];
	const issues: WikiPageIssue[] = [];
	const dropped: string[] = [];
	let repaired = 0;

	for (const relPath of authored) {
		const result = repairPage(dir, sourceRoot, relPath, knownPages);
		if (result.empty) {
			// An empty page is not a wiki page. Removing it lets the plan record
			// the page as still owed rather than shipping a stub that reads as
			// documented coverage.
			rmSync(join(dir, relPath), { force: true });
			dropped.push(relPath);
			continue;
		}
		if (result.changed) repaired += 1;
		issues.push(...result.issues);
		assembled.push({ path: relPath, metadata: result.metadata });
	}

	writeText(join(dir, WIKI_QUICKSTART), renderQuickstart(sourceRoot, input.plan, assembled));

	const directories = new Set<string>(["."]);
	for (const page of assembled) {
		let section = posix.dirname(page.path);
		while (section !== "." && section.length > 0) {
			directories.add(section);
			section = posix.dirname(section);
		}
	}
	for (const directory of directories) {
		const pagesHere = assembled.filter((page) => posix.dirname(page.path) === directory);
		const sectionsHere = [...directories]
			.filter((candidate) => candidate !== "." && posix.dirname(candidate) === directory)
			.sort();
		const indexPath = directory === "." ? WIKI_INDEX : `${directory}/${WIKI_INDEX}`;
		writeText(join(dir, indexPath), renderIndex(directory, pagesHere, sectionsHere));
	}

	// Clear indexes left by a section that no longer has pages, so navigation
	// never advertises an empty directory.
	for (const relPath of wikiMarkdownFilesInDir(dir)) {
		if (!isGeneratedWikiFile(relPath) || relPath === WIKI_QUICKSTART) continue;
		const directory = posix.dirname(relPath);
		if (!directories.has(directory)) rmSync(join(dir, relPath), { force: true });
	}

	return { pages: listWikiPagesInDir(dir), repaired, dropped, issues };
}

/** Repository-relative paths a page tree cites, for update scoping. */
export function pageSourceIndex(dir: string, sourceRoot: string): Map<string, string[]> {
	const index = new Map<string, string[]>();
	for (const relPath of wikiMarkdownFilesInDir(dir)) {
		if (isGeneratedWikiFile(relPath)) continue;
		const { metadata } = readWikiPage({ pagePath: relPath, content: readText(join(dir, relPath)), sourceRoot });
		index.set(relPath, [...metadata.sources, ...metadata.tests]);
	}
	return index;
}

/** Normalize a repository path for comparison against recorded page sources. */
export function normalizeRepoPath(sourceRoot: string, candidate: string): string {
	const resolved = normalize(join(sourceRoot, candidate));
	const rel = relative(sourceRoot, resolved);
	return rel.split("\\").join("/");
}
