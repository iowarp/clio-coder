/**
 * Per-page structured metadata for generated wiki pages.
 *
 * Every content page opens with a YAML block carrying the routing facts a
 * coding agent needs before it reads the prose: which source files the page
 * documents, which symbols it names, which tests prove the behavior, which
 * invariants hold, and the narrowest command that validates a change. The
 * assembly pass reads exactly these fields to generate quickstart's routing
 * table and each directory index, so the metadata is the retrieval layer
 * rather than decoration.
 *
 * The block is authored by the page writer and repaired here. Repair never
 * rejects: a page with no front matter, unparseable YAML, or a field of the
 * wrong type is rewritten from what its body can supply. A page is never lost
 * because its author got the metadata shape wrong, which is the whole reason
 * a small local model can be trusted to write one.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import { parse } from "yaml";

export interface WikiPageMetadata {
	/** Display name; the page's H1 is kept in sync with it. */
	title: string;
	/** One or two retrieval-optimized sentences. May be empty when the body has no prose. */
	summary: string;
	/** Repository-relative source files this page documents. Verified to exist. */
	sources: string[];
	/** Important symbols the page explains. */
	symbols: string[];
	/** Repository-relative focused tests. Verified to exist. */
	tests: string[];
	/** Externally observable contracts stated by the page. */
	invariants: string[];
	/** Narrowest non-destructive commands that check this area. */
	validate: string[];
}

export interface WikiPageDocument {
	metadata: WikiPageMetadata;
	/** Page body with the front-matter block removed. */
	body: string;
	/** Paths the author listed that do not resolve under the source root. */
	unresolvedPaths: string[];
}

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const LIST_FIELDS = ["sources", "symbols", "tests", "invariants", "validate"] as const;

/** Longest generated summary, so an index line stays one line. */
const SUMMARY_MAX_CHARS = 240;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usableString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	for (const entry of value) {
		const usable = usableString(entry);
		if (usable) seen.add(usable);
	}
	return [...seen];
}

/** The page's own H1, or null when it has none. */
export function wikiPageHeading(text: string): string | null {
	return usableString(/^#\s+(.+?)\s*$/m.exec(stripFrontmatter(text).body)?.[1]);
}

/** A readable title from a page path, used only when the body supplies none. */
export function titleFromPagePath(pagePath: string): string {
	const base = pagePath.replace(/^.*\//, "").replace(/\.md$/i, "");
	const spaced = base.replace(/[-_]+/g, " ").trim();
	return spaced.length > 0 ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : base;
}

export function stripFrontmatter(content: string): { block: string | null; body: string } {
	const match = FRONTMATTER_BLOCK.exec(content);
	if (!match) return { block: null, body: content };
	return { block: match[1] ?? "", body: content.slice(match[0].length) };
}

/**
 * The first real paragraph of a body, collapsed to one line. Used as a fallback
 * summary when the author supplied none, so a directory index still says
 * something about the page. Headings, table rows, fenced blocks, and list items
 * are skipped: a Mermaid diagram or a routing table rendered into an index line
 * is worse than no summary at all.
 */
function summaryFromBody(body: string): string {
	const skipped = ["#", "|", "```", "-", "*", ">", "<!--"];
	const paragraphs = body
		.split(/\r?\n\s*\r?\n/)
		.map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
		.filter((paragraph) => paragraph.length > 0 && !skipped.some((prefix) => paragraph.startsWith(prefix)));
	const first = paragraphs[0] ?? "";
	return first.length > SUMMARY_MAX_CHARS ? `${first.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…` : first;
}

function isWithin(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve a cited repository path. TypeScript's local imports intentionally
 * use `.js` specifiers, so a page may name the wire path of a module whose
 * authored source is `.ts` or `.tsx`; that spelling resolves rather than being
 * reported as a dangling citation.
 */
export function resolveSourcePath(sourceRoot: string, cited: string): string | null {
	if (cited.length === 0 || isAbsolute(cited) || /[*?{}<>]/.test(cited)) return null;
	const direct = normalize(join(sourceRoot, cited));
	if (!isWithin(sourceRoot, direct)) return null;
	if (existsSync(direct)) return direct;
	if (cited.endsWith(".js")) {
		for (const extension of [".ts", ".tsx"] as const) {
			const authored = normalize(join(sourceRoot, `${cited.slice(0, -3)}${extension}`));
			if (isWithin(sourceRoot, authored) && existsSync(authored)) return authored;
		}
	}
	return null;
}

export interface ReadWikiPageInput {
	/** Wiki-relative page path, used for the title fallback. */
	pagePath: string;
	content: string;
	/**
	 * Repository root. When supplied, `sources` and `tests` entries that do not
	 * resolve are dropped from the metadata and reported in `unresolvedPaths`,
	 * so the machine-readable routing layer never points at a file that is not
	 * there. Prose is never rewritten by this.
	 */
	sourceRoot?: string;
}

/**
 * Parse a page into repaired metadata plus its body. Total: every input,
 * including one with no front matter at all, yields a usable document.
 */
export function readWikiPage(input: ReadWikiPageInput): WikiPageDocument {
	const { block, body } = stripFrontmatter(input.content);
	let fields: unknown;
	if (block !== null) {
		try {
			fields = parse(`\n${block}`, { schema: "core", uniqueKeys: true }) as unknown;
		} catch {
			fields = undefined;
		}
	}
	const authored = isRecord(fields) ? fields : {};
	const metadata: WikiPageMetadata = {
		title: usableString(authored.title) ?? wikiPageHeading(body) ?? titleFromPagePath(input.pagePath),
		summary: usableString(authored.summary) ?? summaryFromBody(body),
		sources: [],
		symbols: stringList(authored.symbols),
		tests: [],
		invariants: stringList(authored.invariants),
		validate: stringList(authored.validate),
	};
	const unresolvedPaths: string[] = [];
	for (const field of ["sources", "tests"] as const) {
		for (const cited of stringList(authored[field])) {
			if (input.sourceRoot === undefined || resolveSourcePath(input.sourceRoot, cited) !== null) {
				metadata[field].push(cited);
			} else {
				unresolvedPaths.push(cited);
			}
		}
	}
	return { metadata, body, unresolvedPaths };
}

function renderList(name: string, values: ReadonlyArray<string>): string[] {
	if (values.length === 0) return [];
	return [`${name}:`, ...values.map((value) => `  - ${JSON.stringify(value)}`)];
}

/** Render a deterministic front-matter block. Empty lists are omitted. */
export function renderFrontmatter(metadata: WikiPageMetadata): string {
	const lines = [`title: ${JSON.stringify(metadata.title)}`];
	if (metadata.summary.length > 0) lines.push(`summary: ${JSON.stringify(metadata.summary)}`);
	for (const field of LIST_FIELDS) lines.push(...renderList(field, metadata[field]));
	return `---\n${lines.join("\n")}\n---\n`;
}

/**
 * Rebuild a page from repaired metadata and its body, guaranteeing the body
 * opens with an H1 that matches the metadata title. Without the H1 the page
 * reads as a fragment and every title fallback in the codebase records the
 * filename instead of a name.
 */
export function renderWikiPage(metadata: WikiPageMetadata, body: string): string {
	const trimmed = body.replace(/^\s+/, "").replace(/\s+$/, "");
	// Matched directly rather than through `wikiPageHeading`, which strips a
	// leading front-matter block: this body has none, and a page opening on a
	// `---` horizontal rule would otherwise have its first section eaten.
	const hasHeading = /^#\s+\S/m.test(trimmed);
	const withHeading = hasHeading ? trimmed : `# ${metadata.title}\n\n${trimmed}`;
	return `${renderFrontmatter(metadata)}\n${withHeading}\n`;
}
