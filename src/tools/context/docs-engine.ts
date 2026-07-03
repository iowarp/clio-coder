import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";

// Deterministic, dependency-free retrieval over Clio's bundled human docs,
// serving context(scope=docs). This intentionally avoids embeddings or network
// calls so docs retrieval works in a packaged offline CLI, but it is still
// richer than grep: it builds a section index with heading hierarchy, line
// ranges, light stemming, controlled Clio vocabulary aliases, phrase boosts,
// and BM25-style body scoring.

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 12;
const SNIPPET_MAX = 360;
const SNIPPET_CONTEXT_LINES = 2;

const BODY_K1 = 1.2;
const BODY_B = 0.75;
const HEADING_WEIGHT = 3.5;
const TITLE_WEIGHT = 2.0;
const PHRASE_BODY_BOOST = 3.0;
const PHRASE_HEADING_BOOST = 7.0;
const COVERAGE_BOOST = 4.0;
const EXPANDED_TERM_WEIGHT = 0.45;

const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"can",
	"for",
	"from",
	"how",
	"in",
	"into",
	"is",
	"it",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"what",
	"when",
	"where",
	"with",
]);

const VOCABULARY_ALIASES: ReadonlyArray<{ triggers: ReadonlyArray<string>; expansions: ReadonlyArray<string> }> = [
	{
		triggers: ["approval", "confirm", "confirmation", "deny", "permission", "permissions", "prompt"],
		expansions: ["autonomy", "ask", "deny", "safety", "policy", "full-auto", "read-only"],
	},
	{
		triggers: ["agent", "agents", "dispatch", "fleet", "worker", "workers", "run"],
		expansions: ["agent", "dispatch", "fleet", "profile", "worker", "receipt", "run"],
	},
	{
		triggers: ["model", "models", "provider", "runtime", "target", "targets", "endpoint"],
		expansions: ["catalog", "model", "probe", "provider", "runtime", "target", "wireModels"],
	},
	{
		triggers: ["auth", "credential", "credentials", "login", "oauth", "subscription"],
		expansions: ["auth", "credential", "login", "oauth", "target", "runtime"],
	},
	{
		triggers: ["memory", "evidence", "receipt", "receipts", "audit", "accountability", "provenance"],
		expansions: ["accountability", "evidence", "findings", "memory", "receipt", "run", "audit"],
	},
	{
		triggers: ["validate", "validated", "validation", "verify", "verified", "test", "tests", "rigor"],
		expansions: ["validation", "verify", "evidence", "rigor", "finish", "contract", "check"],
	},
	{
		triggers: ["bash", "command", "commands", "shell", "terminal", "tool", "tools"],
		expansions: ["bash", "command", "tool", "registry", "safety", "result", "cap"],
	},
	{
		triggers: ["context", "compact", "compaction", "token", "tokens", "cache", "prompt"],
		expansions: ["context", "compaction", "prompt", "token", "cache", "window"],
	},
	{
		triggers: ["hook", "hooks", "middleware", "component", "components", "budget"],
		expansions: ["middleware", "hook", "effect", "component", "budget", "registration"],
	},
	{
		triggers: ["install", "upgrade", "uninstall", "doctor", "lifecycle", "reset", "paths"],
		expansions: ["install", "lifecycle", "doctor", "reset", "state", "config", "paths"],
	},
	{
		triggers: ["skill", "skills", "marketplace"],
		expansions: ["skill", "skills", "marketplace", "discovery", "context"],
	},
	{
		triggers: ["docs", "documentation", "manual", "self"],
		expansions: ["documentation", "docs", "context", "blueprint", "guide"],
	},
];

interface RawSection {
	file: string;
	title: string;
	heading: string;
	breadcrumb: string;
	level: number;
	anchor: string;
	startLine: number;
	bodyStartLine: number;
	endLine: number;
	body: string;
	bodyLines: string[];
}

interface IndexedSection extends RawSection {
	bodyCounts: Map<string, number>;
	headingCounts: Map<string, number>;
	titleCounts: Map<string, number>;
	bodyLength: number;
	terms: Set<string>;
	normalizedBody: string;
	normalizedHeading: string;
}

interface DocsIndex {
	dir: string;
	files: string[];
	sections: IndexedSection[];
	docCount: number;
	avgBodyLength: number;
	documentFrequency: Map<string, number>;
}

interface WeightedTerm {
	term: string;
	source: "query" | "alias";
	weight: number;
}

interface QueryPlan {
	query: string;
	originalTokens: string[];
	weightedTerms: WeightedTerm[];
	expandedTerms: string[];
	phrases: string[];
}

interface ScoredSection {
	section: IndexedSection;
	score: number;
	matchedTerms: string[];
	signals: string[];
	coverage: number;
}

let cachedIndex: DocsIndex | null = null;

function normalizeText(text: string): string {
	return text
		.toLowerCase()
		.replace(/[`'"’]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function rawTokens(text: string): string[] {
	return normalizeText(text).split(" ").filter(Boolean);
}

function stemToken(token: string): string {
	if (token.length <= 3) return token;
	if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
	if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
	if (token.endsWith("ed") && token.length > 4) return token.slice(0, -2);
	if (token.endsWith("es") && token.length > 4) return token.slice(0, -2);
	if (token.endsWith("s") && token.length > 4) return token.slice(0, -1);
	return token;
}

function tokenize(text: string, options: { keepStopWords?: boolean } = {}): string[] {
	const tokens = rawTokens(text).map(stemToken);
	return options.keepStopWords ? tokens : tokens.filter((token) => !STOP_WORDS.has(token));
}

function countTerms(tokens: ReadonlyArray<string>): Map<string, number> {
	const counts = new Map<string, number>();
	for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
	return counts;
}

function unique<T>(items: ReadonlyArray<T>): T[] {
	return [...new Set(items)];
}

function slugify(heading: string): string {
	return normalizeText(heading).replace(/\s+/g, "-") || "section";
}

function titleFromFile(name: string): string {
	return basename(name, ".md")
		.split(/[-_]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

/**
 * Split one markdown document into heading-delimited sections. Content before
 * the first heading becomes an `(overview)` section. Fenced code blocks are
 * tracked so a `#` inside a fence never starts a spurious section.
 */
function parseSections(file: string, markdown: string): RawSection[] {
	const lines = markdown.split(/\r?\n/);
	const sections: RawSection[] = [];
	let title = titleFromFile(file);
	let heading = "(overview)";
	let level = 0;
	let headingLine = 1;
	let bodyStartLine = 1;
	let buffer: string[] = [];
	let inFence = false;
	const stack: Array<{ level: number; text: string }> = [];

	const breadcrumbFor = (): string => {
		const parts = stack.map((entry) => entry.text);
		if (heading === "(overview)") return title;
		return parts.length > 0 ? parts.join(" > ") : heading;
	};

	const flush = (endLine: number): void => {
		const body = buffer.join("\n").trim();
		if (body.length > 0 || heading !== "(overview)") {
			sections.push({
				file,
				title,
				heading,
				breadcrumb: breadcrumbFor(),
				level,
				anchor: heading === "(overview)" ? "" : `#${slugify(heading)}`,
				startLine: headingLine,
				bodyStartLine,
				endLine: Math.max(headingLine, endLine),
				body,
				bodyLines: [...buffer],
			});
		}
		buffer = [];
	};

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		const headingMatch = inFence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (headingMatch) {
			flush(i);
			level = (headingMatch[1] ?? "").length;
			heading = (headingMatch[2] ?? "").trim();
			if (level === 1) title = heading;
			while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
			stack.push({ level, text: heading });
			headingLine = i + 1;
			bodyStartLine = i + 2;
			continue;
		}
		buffer.push(line);
	}
	flush(lines.length);
	return sections;
}

function indexSection(section: RawSection): IndexedSection {
	const headingText = `${section.title} ${section.breadcrumb} ${section.heading}`;
	const bodyTokens = tokenize(section.body);
	const headingTokens = tokenize(headingText);
	const titleTokens = tokenize(section.title);
	const bodyCounts = countTerms(bodyTokens);
	const headingCounts = countTerms(headingTokens);
	const titleCounts = countTerms(titleTokens);
	const terms = new Set([...bodyCounts.keys(), ...headingCounts.keys(), ...titleCounts.keys()]);
	return {
		...section,
		bodyCounts,
		headingCounts,
		titleCounts,
		bodyLength: Math.max(1, bodyTokens.length),
		terms,
		normalizedBody: normalizeText(section.body),
		normalizedHeading: normalizeText(headingText),
	};
}

function candidateDocFiles(root: string): string[] {
	const docsDir = join(root, "docs");
	const files: string[] = [];
	try {
		for (const name of readdirSync(docsDir).sort((a, b) => a.localeCompare(b))) {
			if (name.toLowerCase().endsWith(".md")) files.push(join("docs", name));
		}
	} catch {
		// The caller reports a missing docs directory below if nothing can load.
	}
	for (const name of ["README.md", "CHANGELOG.md", "CLIO.md"]) {
		if (existsSync(join(root, name))) files.push(name);
	}
	return files;
}

function buildDocumentFrequency(sections: ReadonlyArray<IndexedSection>): Map<string, number> {
	const df = new Map<string, number>();
	for (const section of sections) {
		for (const term of section.terms) df.set(term, (df.get(term) ?? 0) + 1);
	}
	return df;
}

function loadDocsIndex(): { ok: true; index: DocsIndex } | { ok: false; message: string } {
	let root: string;
	try {
		root = resolvePackageRoot();
	} catch (err) {
		return { ok: false, message: err instanceof Error ? err.message : String(err) };
	}
	const docsDir = join(root, "docs");
	if (cachedIndex && cachedIndex.dir === docsDir) return { ok: true, index: cachedIndex };
	const files = candidateDocFiles(root);
	if (files.length === 0) return { ok: false, message: `bundled docs directory not found at ${docsDir}` };

	const sections: IndexedSection[] = [];
	const indexedFiles: string[] = [];
	let docCount = 0;
	for (const file of files) {
		let raw: string;
		try {
			raw = readFileSync(join(root, file), "utf8");
		} catch {
			continue;
		}
		docCount += 1;
		indexedFiles.push(file);
		for (const section of parseSections(file, raw)) sections.push(indexSection(section));
	}
	if (sections.length === 0) return { ok: false, message: `no markdown sections found under ${docsDir}` };
	const totalLength = sections.reduce((sum, section) => sum + section.bodyLength, 0);
	cachedIndex = {
		dir: docsDir,
		files: indexedFiles,
		sections,
		docCount,
		avgBodyLength: totalLength / sections.length,
		documentFrequency: buildDocumentFrequency(sections),
	};
	return { ok: true, index: cachedIndex };
}

function makeQueryPlan(query: string): QueryPlan {
	const originalTokens = unique(tokenize(query));
	const originalSet = new Set(originalTokens);
	const expanded: string[] = [];
	for (const rule of VOCABULARY_ALIASES) {
		const triggerTokens = rule.triggers.flatMap((trigger) => tokenize(trigger));
		if (!triggerTokens.some((token) => originalSet.has(token))) continue;
		expanded.push(...rule.expansions.flatMap((term) => tokenize(term)));
	}
	const expandedTerms = unique(expanded).filter((term) => !originalSet.has(term));
	const weightedTerms: WeightedTerm[] = [
		...originalTokens.map((term) => ({ term, source: "query" as const, weight: 1 })),
		...expandedTerms.map((term) => ({ term, source: "alias" as const, weight: EXPANDED_TERM_WEIGHT })),
	];
	const normalizedQuery = normalizeText(query);
	const phraseCandidates = [
		normalizedQuery,
		...rawTokens(query)
			.slice(0, -1)
			.map((token, index, tokens) => `${token} ${tokens[index + 1] ?? ""}`.trim()),
	];
	const phrases = unique(phraseCandidates.filter((phrase) => phrase.includes(" ") && phrase.length >= 5));
	return { query, originalTokens, weightedTerms, expandedTerms, phrases };
}

function idf(index: DocsIndex, term: string): number {
	const df = index.documentFrequency.get(term) ?? 0;
	return Math.log(1 + (index.sections.length - df + 0.5) / (df + 0.5));
}

function bm25(count: number, sectionLength: number, avgLength: number): number {
	if (count <= 0) return 0;
	return (count * (BODY_K1 + 1)) / (count + BODY_K1 * (1 - BODY_B + BODY_B * (sectionLength / avgLength)));
}

function phraseSignals(section: IndexedSection, phrases: ReadonlyArray<string>): { score: number; signals: string[] } {
	let score = 0;
	const signals: string[] = [];
	for (const phrase of phrases) {
		if (section.normalizedHeading.includes(phrase)) {
			score += PHRASE_HEADING_BOOST;
			signals.push(`heading phrase: ${phrase}`);
		}
		if (section.normalizedBody.includes(phrase)) {
			score += PHRASE_BODY_BOOST;
			signals.push(`body phrase: ${phrase}`);
		}
	}
	return { score, signals };
}

function scoreSection(index: DocsIndex, section: IndexedSection, plan: QueryPlan): ScoredSection | null {
	let score = 0;
	const matchedTerms: string[] = [];
	const signals: string[] = [];
	let originalHits = 0;
	for (const weighted of plan.weightedTerms) {
		const bodyCount = section.bodyCounts.get(weighted.term) ?? 0;
		const headingCount = section.headingCounts.get(weighted.term) ?? 0;
		const titleCount = section.titleCounts.get(weighted.term) ?? 0;
		if (bodyCount + headingCount + titleCount === 0) continue;
		const termIdf = idf(index, weighted.term);
		const bodyScore = termIdf * bm25(bodyCount, section.bodyLength, index.avgBodyLength);
		const headingScore = headingCount > 0 ? termIdf * HEADING_WEIGHT : 0;
		const titleScore = titleCount > 0 ? termIdf * TITLE_WEIGHT : 0;
		score += weighted.weight * (bodyScore + headingScore + titleScore);
		matchedTerms.push(weighted.term);
		if (weighted.source === "query") originalHits += 1;
		if (headingCount > 0) signals.push(`heading: ${weighted.term}`);
		else if (titleCount > 0) signals.push(`title: ${weighted.term}`);
	}
	const phrases = phraseSignals(section, plan.phrases);
	score += phrases.score;
	signals.push(...phrases.signals);
	const coverage = plan.originalTokens.length === 0 ? 0 : originalHits / plan.originalTokens.length;
	score += coverage * COVERAGE_BOOST;
	if (score <= 0) return null;
	return {
		section,
		score,
		matchedTerms: unique(matchedTerms).slice(0, 12),
		signals: unique(signals).slice(0, 6),
		coverage,
	};
}

function lineHasNeedle(line: string, needles: ReadonlyArray<string>): boolean {
	const normalized = normalizeText(line);
	return needles.some((needle) => normalized.includes(needle));
}

function cleanSnippet(text: string): string {
	return text
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

function snippetFor(section: IndexedSection, plan: QueryPlan): { text: string; startLine: number; endLine: number } {
	const needles = unique([...plan.phrases, ...plan.originalTokens, ...plan.expandedTerms.slice(0, 8)]).filter(
		(needle) => needle.length > 0,
	);
	let hitLine = section.bodyLines.findIndex((line) => lineHasNeedle(line, needles));
	if (hitLine < 0) hitLine = section.bodyLines.findIndex((line) => line.trim().length > 0);
	if (hitLine < 0) {
		return {
			text: section.heading === "(overview)" ? section.title : section.heading,
			startLine: section.startLine,
			endLine: section.startLine,
		};
	}
	const from = Math.max(0, hitLine - SNIPPET_CONTEXT_LINES);
	const to = Math.min(section.bodyLines.length - 1, hitLine + SNIPPET_CONTEXT_LINES);
	let snippet = cleanSnippet(section.bodyLines.slice(from, to + 1).join(" "));
	if (snippet.length > SNIPPET_MAX) snippet = `${snippet.slice(0, SNIPPET_MAX - 3).trimEnd()}...`;
	return {
		text: snippet,
		startLine: section.bodyStartLine + from,
		endLine: section.bodyStartLine + to,
	};
}

export function clampDocsLimit(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.min(Math.floor(value), MAX_LIMIT);
	return DEFAULT_LIMIT;
}

function resultPayload(index: DocsIndex, plan: QueryPlan, scored: ReadonlyArray<ScoredSection>) {
	const results = scored.map((entry, i) => {
		const snippet = snippetFor(entry.section, plan);
		return {
			rank: i + 1,
			file: entry.section.file,
			heading: entry.section.heading,
			breadcrumb: entry.section.breadcrumb,
			anchor: entry.section.anchor,
			lines: { start: entry.section.startLine, end: entry.section.endLine },
			snippetLines: { start: snippet.startLine, end: snippet.endLine },
			snippet: snippet.text,
			score: Number(entry.score.toFixed(3)),
			coverage: Number(entry.coverage.toFixed(2)),
			matchedTerms: entry.matchedTerms,
			signals: entry.signals,
		};
	});
	return {
		version: 2,
		query: plan.query,
		corpus: {
			docs: index.docCount,
			sections: index.sections.length,
			files: index.files,
			excludes: ["docs/html/**"],
		},
		terms: {
			query: plan.originalTokens,
			expanded: plan.expandedTerms,
			phrases: plan.phrases,
		},
		resultCount: results.length,
		results,
		followUp:
			results.length > 0
				? "Use read with the cited file and line range when you need the full section."
				: "Try Clio vocabulary such as target, autonomy, dispatch, evidence, middleware, context, validation, install, or model catalog.",
	};
}

export type DocsCorpusOutcome =
	| { ok: true; payload: Record<string, unknown>; fileCount: number }
	| { ok: false; message: string };

/**
 * List the bundled-docs corpus without running a query: the file set plus the
 * doc/section counts a successful search already carries under `corpus`. This
 * is what the model wants when it sends `scope=docs` with no query — an index
 * to pick a search term from — and it saves the wasted round the old
 * `requires query` error forced. Bounded: the corpus is a handful of files.
 */
export function listDocsCorpus(): DocsCorpusOutcome {
	const loaded = loadDocsIndex();
	if (!loaded.ok) return { ok: false, message: loaded.message };
	const index = loaded.index;
	const payload = {
		version: 2,
		corpus: {
			docs: index.docCount,
			sections: index.sections.length,
			files: index.files,
			excludes: ["docs/html/**"],
		},
		followUp:
			"Pass query=<terms> to search these docs; each result cites the file and line range to read. " +
			"Try Clio vocabulary such as target, autonomy, dispatch, evidence, middleware, context, validation, install, or model catalog.",
	};
	return { ok: true, payload, fileCount: index.files.length };
}

export type DocsSearchOutcome =
	| {
			ok: true;
			payload: Record<string, unknown>;
			/** Sections returned after ranking and the limit. */
			resultCount: number;
			/** Sections that scored at all; the omitted count is total - result. */
			rankedTotal: number;
			/** Exact continuation suggestion for empty results. */
			next: string | null;
	  }
	| { ok: false; message: string };

/**
 * Rank bundled-doc sections for a query. Pure retrieval: the caller (the
 * context tool) owns argument validation, the observation envelope, and JSON
 * rendering of the returned payload.
 */
export function searchDocs(query: string, limitArg: unknown): DocsSearchOutcome {
	const plan = makeQueryPlan(query);
	if (plan.originalTokens.length === 0) return { ok: false, message: "query has no searchable terms" };
	const loaded = loadDocsIndex();
	if (!loaded.ok) return { ok: false, message: loaded.message };
	const limit = clampDocsLimit(limitArg);
	const ranked = loaded.index.sections
		.map((section) => scoreSection(loaded.index, section, plan))
		.filter((entry): entry is ScoredSection => entry !== null)
		.sort(
			(a, b) =>
				b.score - a.score ||
				b.coverage - a.coverage ||
				a.section.file.localeCompare(b.section.file) ||
				a.section.startLine - b.section.startLine ||
				a.section.heading.localeCompare(b.section.heading),
		);
	const shown = ranked.slice(0, limit);
	// Empty results still carry an exact continuation: retry with the closest
	// vocabulary expansion when one triggered, otherwise a broad known term.
	const next = shown.length === 0 ? `query=${plan.expandedTerms[0] ?? "overview"}` : null;
	const payload = {
		...resultPayload(loaded.index, plan, shown),
		omitted: ranked.length - shown.length,
		...(next !== null ? { next } : {}),
	};
	return { ok: true, payload, resultCount: shown.length, rankedTotal: ranked.length, next };
}
