import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { resolvePackageRoot } from "../core/package-root.js";
import { ToolNames } from "../core/tool-names.js";
import type { ToolResult, ToolSpec } from "./registry.js";

// Model-free retrieval over the bundled docs/*.md set. Mirrors code-nav: the
// parsed section index is cached in-module and keyed by the resolved docs
// directory so a single process answers "how does Clio work / how is it
// configured / how are agents triggered" without any model call, network, or
// filesystem write. Scoring is case-insensitive term frequency over each
// markdown section with a boost when a query term lands in the heading, so a
// hit carries a citable passage (file + heading + snippet).

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
// Snippet bound keeps each cited passage small enough to survive the bounded
// read result policy in bootstrap.ts; the leading window centers the snippet
// on the first matched term.
const SNIPPET_MAX = 280;
const SNIPPET_LEAD = 48;
// A heading match is worth this many body occurrences. Sections titled for the
// query (for example a "Safety" or "Autonomy" heading) sort above sections that
// merely mention the term in passing.
const HEADING_BOOST = 6;

interface IndexedSection {
	/** Repo-relative citation path, for example `docs/safety-model.md`. */
	file: string;
	heading: string;
	body: string;
	/** Lowercased body token frequencies, precomputed once at index time. */
	bodyCounts: Map<string, number>;
	headingTokens: Set<string>;
}

interface DocsIndex {
	dir: string;
	sections: IndexedSection[];
}

let cachedIndex: DocsIndex | null = null;

function tokenize(text: string): string[] {
	return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function uniqueTerms(terms: ReadonlyArray<string>): string[] {
	return [...new Set(terms)];
}

/**
 * Split one markdown document into heading-delimited sections. Content before
 * the first heading becomes an `(overview)` section. Fenced code blocks are
 * tracked so a `#` inside a fence never starts a spurious section.
 */
function parseSections(file: string, markdown: string): Array<{ file: string; heading: string; body: string }> {
	const lines = markdown.split(/\r?\n/);
	const sections: Array<{ file: string; heading: string; body: string }> = [];
	let heading = "(overview)";
	let buffer: string[] = [];
	let inFence = false;
	const flush = (): void => {
		const body = buffer.join("\n").trim();
		if (body.length > 0 || heading !== "(overview)") sections.push({ file, heading, body });
		buffer = [];
	};
	for (const line of lines) {
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		const headingMatch = inFence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (headingMatch) {
			flush();
			heading = (headingMatch[2] ?? "").trim();
			continue;
		}
		buffer.push(line);
	}
	flush();
	return sections;
}

function indexSection(section: { file: string; heading: string; body: string }): IndexedSection {
	const bodyCounts = new Map<string, number>();
	for (const token of tokenize(section.body)) bodyCounts.set(token, (bodyCounts.get(token) ?? 0) + 1);
	return {
		file: section.file,
		heading: section.heading,
		body: section.body,
		bodyCounts,
		headingTokens: new Set(tokenize(section.heading)),
	};
}

function loadDocsIndex(): { ok: true; sections: IndexedSection[] } | { ok: false; message: string } {
	let dir: string;
	try {
		dir = join(resolvePackageRoot(), "docs");
	} catch (err) {
		return { ok: false, message: `docs_search: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (cachedIndex && cachedIndex.dir === dir) return { ok: true, sections: cachedIndex.sections };
	let names: string[];
	try {
		names = readdirSync(dir)
			.filter((name) => name.toLowerCase().endsWith(".md"))
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return { ok: false, message: `docs_search: bundled docs directory not found at ${dir}` };
	}
	const sections: IndexedSection[] = [];
	for (const name of names) {
		let raw: string;
		try {
			raw = readFileSync(join(dir, name), "utf8");
		} catch {
			continue;
		}
		for (const section of parseSections(`docs/${name}`, raw)) sections.push(indexSection(section));
	}
	cachedIndex = { dir, sections };
	return { ok: true, sections };
}

function scoreSection(section: IndexedSection, terms: ReadonlyArray<string>): number {
	let score = 0;
	for (const term of terms) {
		score += section.bodyCounts.get(term) ?? 0;
		if (section.headingTokens.has(term)) score += HEADING_BOOST;
	}
	return score;
}

function snippetFor(section: IndexedSection, terms: ReadonlyArray<string>): string {
	const body = section.body.replace(/\s+/g, " ").trim();
	if (body.length === 0) return "";
	const lower = body.toLowerCase();
	let pos = -1;
	for (const term of terms) {
		const at = lower.indexOf(term);
		if (at !== -1 && (pos === -1 || at < pos)) pos = at;
	}
	const start = pos <= SNIPPET_LEAD ? 0 : pos - SNIPPET_LEAD;
	let snippet = body.slice(start, start + SNIPPET_MAX);
	if (start > 0) snippet = `...${snippet}`;
	if (start + SNIPPET_MAX < body.length) snippet = `${snippet}...`;
	return snippet;
}

function clampLimit(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.min(Math.floor(value), MAX_LIMIT);
	return DEFAULT_LIMIT;
}

function renderJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

export const docsSearchTool: ToolSpec = {
	name: ToolNames.DocsSearch,
	description:
		"Search Clio's bundled documentation (docs/*.md) with model-free term-frequency retrieval over markdown sections. Answers how Clio works, how it is configured, and how agents are triggered, covering targets, autonomy, fleet dispatch, settings, and safety. Returns the top sections as JSON with file, heading, snippet, and score so each answer carries a cited passage.",
	parameters: Type.Object({
		query: Type.String({ description: "Search terms, for example 'fleet dispatch' or 'autonomy levels'." }),
		limit: Type.Optional(Type.Number({ description: `Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` })),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args): Promise<ToolResult> {
		const query = typeof args.query === "string" ? args.query.trim() : "";
		if (query.length === 0) return { kind: "error", message: "docs_search: query is required" };
		const terms = uniqueTerms(tokenize(query));
		if (terms.length === 0) return { kind: "error", message: "docs_search: query has no searchable terms" };
		const loaded = loadDocsIndex();
		if (!loaded.ok) return { kind: "error", message: loaded.message };
		const limit = clampLimit(args.limit);
		const ranked = loaded.sections
			.map((section) => ({ section, score: scoreSection(section, terms) }))
			.filter((entry) => entry.score > 0)
			.sort(
				(a, b) =>
					b.score - a.score ||
					a.section.file.localeCompare(b.section.file) ||
					a.section.heading.localeCompare(b.section.heading),
			)
			.slice(0, limit);
		const results = ranked.map(({ section, score }) => ({
			file: section.file,
			heading: section.heading,
			snippet: snippetFor(section, terms),
			score,
		}));
		const output = renderJson({ query, results });
		return results.length === 0 ? { kind: "ok", output: `${output}\n[no matches]` } : { kind: "ok", output };
	},
};
