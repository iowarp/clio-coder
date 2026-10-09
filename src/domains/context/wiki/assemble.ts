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
import { basename, dirname, join, posix, relative } from "node:path";
import type { WikiLinkInventory } from "./evidence.js";
import { repairWikiLinks, validateWikiPageEvidence, wikiLinkInventory } from "./evidence.js";
import { mapWikiProse, readWikiPage, renderWikiPage, resolveSourcePath, type WikiPageMetadata } from "./frontmatter.js";
import {
	isGeneratedWikiFile,
	listWikiPagesInDir,
	WIKI_INDEX,
	WIKI_QUICKSTART,
	type WikiPage,
	wikiMarkdownFilesInDir,
} from "./layout.js";
import type { WikiPlan, WikiPlanPage } from "./plan.js";

/**
 * A backticked repository path in prose, optionally with `:line` or a trailing
 * `:symbol`. This is the citation form the page fragments ask for, so it is the
 * form checked here.
 */
const SOURCE_CITATION =
	/`((?:src|tests?|scripts|benchmarks|docs|packages|apps|lib|config|\.github)\/[^`\s:#]+)(?::(\d+)(?:-\d+)?)?(?::[A-Za-z_$][\w$.-]*)?`/g;

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
 * there. An unresolved reference is recorded in a
 * marker comment and dropped from the machine-readable metadata, so the next
 * update run gets a precise repair list without this pass editing sentences it
 * cannot understand.
 */
function repairPage(
	dir: string,
	sourceRoot: string,
	relPath: string,
	knownPages: WikiLinkInventory,
): { metadata: WikiPageMetadata; changed: boolean; issues: WikiPageIssue[] } {
	const filePath = join(dir, relPath);
	const original = readText(filePath);
	const parsed = readWikiPage({ pagePath: relPath, content: original, sourceRoot });
	let body = stripRepairNotes(parsed.body);
	const issues: WikiPageIssue[] = [];
	const evidence = validateWikiPageEvidence({ pagePath: relPath, content: original, sourceRoot });
	const resolvedCitations = evidence.resolvedCitations ?? {};
	body = mapWikiProse(body, (line) =>
		line.replace(/`([^`\s]+)`/g, (token: string, cited: string) =>
			Object.hasOwn(resolvedCitations, cited) ? `\`${resolvedCitations[cited]}\`` : token,
		),
	);
	for (const cited of parsed.unresolvedPaths) {
		issues.push({ page: relPath, kind: "citation", reference: cited });
	}
	for (const match of body.matchAll(SOURCE_CITATION)) {
		const cited = match[1] ?? "";
		if (resolveSourcePath(sourceRoot, cited) === null) {
			// The publication gate also understands imports and verified test
			// selectors. Assembly must not relabel their evidence as unresolved.
			if (!evidence.ok) issues.push({ page: relPath, kind: "citation", reference: cited });
		}
	}
	const links = repairWikiLinks(relPath, body, knownPages);
	for (const href of links.unresolved) issues.push({ page: relPath, kind: "link", reference: href });

	const rebuilt = `${renderWikiPage(parsed.metadata, links.body).trimEnd()}\n${renderRepairNote(issues)}`;
	if (rebuilt !== original) writeText(filePath, rebuilt);
	return { metadata: parsed.metadata, changed: rebuilt !== original, issues };
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
	status: WikiPlanPage["status"];
}

function completionSummary(pages: ReadonlyArray<WikiPlanPage>): string {
	const complete = pages.filter((page) => page.status === "written").length;
	return `${complete} complete, ${pages.length - complete} pending.`;
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
			"Front matter may name sources, symbols, tests, and validation commands.",
		completionSummary(plan.pages),
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
		lines.push(
			`${indent}- [${page.metadata.title}](${page.path})${page.status === "written" ? "" : " (pending draft)"}${summary}`,
		);
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
				`| ${escapeCell(page.metadata.title)} | [${escapeCell(page.metadata.title)}](${page.path})${page.status === "written" ? "" : " (pending draft)"} ` +
					`| ${codeList(page.metadata.sources, 3)} | ${codeList(page.metadata.symbols, 3)} ` +
					`| ${codeList(page.metadata.tests, 2)} | ${codeList(page.metadata.validate, 1)} |`,
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

/** Generate one directory's `index.md` from the pages and sections beneath it. */
function renderIndex(
	dir: string,
	pages: ReadonlyArray<AssembledPage>,
	sections: ReadonlyArray<string>,
	statuses: ReadonlyArray<WikiPlanPage>,
): string {
	const title = dir === "." ? "Wiki" : dir.split("/").join(" / ");
	const lines = [`# ${title}`, "", completionSummary(statuses), ""];
	if (pages.length > 0) {
		for (const page of pages) {
			const summary = page.metadata.summary.length > 0 ? ` — ${page.metadata.summary}` : "";
			lines.push(
				`- [${page.metadata.title}](${linkTo(dir, page.path)})${page.status === "written" ? "" : " (pending draft)"}${summary}`,
			);
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
	/** Updated in place with assembly downgrades before the caller publishes metadata. */
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
	const knownPages = wikiLinkInventory(dir);
	const assembled: AssembledPage[] = [];
	const issues: WikiPageIssue[] = [];
	const dropped: string[] = [];
	let repaired = 0;

	for (const relPath of authored) {
		if (!knownPages.targets.has(relPath)) {
			// An empty page is not a wiki page. Removing it lets the plan record
			// the page as still owed rather than shipping a stub that reads as
			// documented coverage.
			rmSync(join(dir, relPath), { force: true });
			dropped.push(relPath);
			continue;
		}
		const result = repairPage(dir, sourceRoot, relPath, knownPages);
		if (result.changed) repaired += 1;
		issues.push(...result.issues);
		assembled.push({ path: relPath, metadata: result.metadata, status: "pending" });
	}

	const onDisk = new Set(assembled.map((page) => page.path));
	input.plan.pages = input.plan.pages.map((page) => {
		if (page.status !== "written") return page;
		const broken = issues.filter((issue) => issue.page === page.path && issue.kind === "link");
		if (onDisk.has(page.path) && broken.length === 0) return page;
		return {
			...page,
			status: "pending",
			lastFailure: {
				phase: "validation",
				detail: (broken.length > 0
					? `Unresolved wiki links: ${broken.map((issue) => issue.reference).join(", ")}`
					: "Wiki page is empty or missing after assembly."
				).slice(0, 500),
			},
		};
	});
	const statuses = new Map(input.plan.pages.map((page) => [page.path, page]));
	for (const page of assembled) {
		page.status = statuses.get(page.path)?.status ?? "pending";
		if (!statuses.has(page.path))
			statuses.set(page.path, {
				path: page.path,
				title: page.metadata.title,
				intent: "",
				sources: [],
				status: "pending",
				attempts: 0,
			});
	}
	const effectivePlan = { ...input.plan, pages: [...statuses.values()] };
	writeText(join(dir, WIKI_QUICKSTART), renderQuickstart(sourceRoot, effectivePlan, assembled));

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
		writeText(
			join(dir, indexPath),
			renderIndex(
				directory,
				pagesHere,
				sectionsHere,
				effectivePlan.pages.filter((page) => directory === "." || page.path.startsWith(`${directory}/`)),
			),
		);
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
		const { metadata, unresolvedPaths } = readWikiPage({
			pagePath: relPath,
			content: readText(join(dir, relPath)),
			sourceRoot,
		});
		index.set(relPath, [
			...new Set(
				[...metadata.sources, ...metadata.tests, ...unresolvedPaths].map((cited) => {
					const resolved = resolveSourcePath(sourceRoot, cited);
					return resolved ? relative(sourceRoot, resolved).replace(/\\/g, "/") : cited;
				}),
			),
		]);
	}
	return index;
}
