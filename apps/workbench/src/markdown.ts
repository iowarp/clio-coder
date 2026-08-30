/**
 * Markdown as untrusted content.
 *
 * Clio Coder's narrative is lexed with marked's GFM lexer and rendered from the
 * token tree by React. No HTML string from the parser ever reaches the DOM: raw
 * HTML tokens are shown as text, only http(s) and mailto links are live, and
 * images are never fetched. Streaming text is lexed incrementally: everything
 * before the last safe block boundary is settled once, and only the tail is
 * re-lexed as tokens arrive.
 */

import { Lexer, type Token, type TokensList } from "marked";

export type MarkdownToken = Token;

const LEXER_OPTIONS = { gfm: true, breaks: false, pedantic: false, async: false } as const;

export function lexMarkdown(source: string): readonly MarkdownToken[] {
	const tokens: TokensList = Lexer.lex(source, LEXER_OPTIONS);
	return tokens;
}

/** Live link protocols. Everything else, including relative paths, renders as text. */
export function safeHref(href: string): string | null {
	const trimmed = href.trim();
	if (trimmed.length === 0 || trimmed.length > 2_048) return null;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return url.href;
	return null;
}

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/u;
const CLOSING_FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})\s*$/u;

/**
 * The index up to which `source` can be lexed on its own. A boundary sits after
 * a blank line that is outside any fenced code block and is followed by a line
 * that starts a new block by itself. `from` must be a line start.
 */
export function settledBoundary(source: string, from = 0): number {
	let boundary = from;
	let index = from;
	let fence: { readonly char: string; readonly length: number } | null = null;
	while (index < source.length) {
		const lineEnd = source.indexOf("\n", index);
		if (lineEnd < 0) break;
		const line = source.slice(index, lineEnd);
		const opening = FENCE_PATTERN.exec(line);
		if (opening !== null) {
			const run = opening[1] ?? "";
			if (fence === null) fence = { char: run[0] ?? "`", length: run.length };
			else if (run[0] === fence.char && run.length >= fence.length && CLOSING_FENCE_PATTERN.test(line)) fence = null;
		}
		index = lineEnd + 1;
		if (fence !== null || line.trim().length !== 0) continue;
		// Only the first character of the next line matters, so a line that is
		// still arriving can be judged as soon as it has one.
		const nextEnd = source.indexOf("\n", index);
		const next = source.slice(index, nextEnd < 0 ? source.length : nextEnd);
		if (next.length === 0 || (nextEnd >= 0 && next.trim().length === 0)) continue;
		if (/^\s/u.test(next) || next.startsWith("|")) continue;
		boundary = index;
	}
	return boundary;
}

export interface MarkdownSplit {
	/** Tokens whose source can no longer change. The array identity is stable until more text settles. */
	readonly settled: readonly MarkdownToken[];
	/** Tokens for the text after the last boundary, re-lexed on every update. */
	readonly tail: readonly MarkdownToken[];
	readonly settledLength: number;
}

const EMPTY_TOKENS: readonly MarkdownToken[] = Object.freeze([]);

/** Incremental lexer for one growing narrative. */
export class IncrementalMarkdown {
	#settledSource = "";
	#settledTokens: readonly MarkdownToken[] = EMPTY_TOKENS;
	#tailSource: string | null = null;
	#tail: readonly MarkdownToken[] = EMPTY_TOKENS;

	update(source: string): MarkdownSplit {
		if (!source.startsWith(this.#settledSource)) {
			this.#settledSource = "";
			this.#settledTokens = EMPTY_TOKENS;
			this.#tailSource = null;
			this.#tail = EMPTY_TOKENS;
		}
		const boundary = settledBoundary(source, this.#settledSource.length);
		if (boundary > this.#settledSource.length) {
			const delta = lexMarkdown(source.slice(this.#settledSource.length, boundary));
			this.#settledTokens = [...this.#settledTokens, ...delta];
			this.#settledSource = source.slice(0, boundary);
		}
		const tailSource = source.slice(this.#settledSource.length);
		if (tailSource !== this.#tailSource) {
			this.#tail = tailSource.length === 0 ? EMPTY_TOKENS : lexMarkdown(tailSource);
			this.#tailSource = tailSource;
		}
		return { settled: this.#settledTokens, tail: this.#tail, settledLength: this.#settledSource.length };
	}
}

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
	javascript: "javascript",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "jsx",
	typescript: "typescript",
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "tsx",
	python: "python",
	py: "python",
	python3: "python",
	bash: "bash",
	sh: "bash",
	shell: "bash",
	zsh: "bash",
	console: "shell-session",
	"shell-session": "shell-session",
	yaml: "yaml",
	yml: "yaml",
	markdown: "markdown",
	md: "markdown",
	markup: "markup",
	html: "markup",
	xml: "markup",
	svg: "markup",
	c: "c",
	cpp: "cpp",
	"c++": "cpp",
	rust: "rust",
	rs: "rust",
	go: "go",
	golang: "go",
	sql: "sql",
	diff: "diff",
	patch: "diff",
	json: "json",
	jsonc: "json",
	json5: "json",
	toml: "toml",
	css: "css",
	docker: "docker",
	dockerfile: "docker",
	makefile: "makefile",
	make: "makefile",
	latex: "latex",
	tex: "latex",
	ini: "ini",
	r: "r",
	julia: "julia",
	jl: "julia",
	matlab: "matlab",
	fortran: "fortran",
	f90: "fortran",
};

export const MERMAID_LANGUAGE = "mermaid";

export interface CodeLanguage {
	/** The label shown to the reader, or null when the fence carried no usable info string. */
	readonly label: string | null;
	/** The Prism grammar id, or null when the language is unknown or the block is a diagram. */
	readonly grammar: string | null;
	readonly mermaid: boolean;
}

export function codeLanguage(info: string | undefined): CodeLanguage {
	const word = (info ?? "").trim().split(/\s+/u, 1)[0] ?? "";
	const label = word.replace(/[^A-Za-z0-9_+#.-]/gu, "").slice(0, 24);
	if (label.length === 0) return { label: null, grammar: null, mermaid: false };
	const key = label.toLocaleLowerCase("en-US");
	if (key === MERMAID_LANGUAGE) return { label: "mermaid", grammar: null, mermaid: true };
	return { label, grammar: LANGUAGE_ALIASES[key] ?? null, mermaid: false };
}

export const HIGHLIGHT_MAX_CHARS = 60_000;
export const MERMAID_MAX_SOURCE_BYTES = 16 * 1024;
export const MERMAID_MAX_LINES = 400;

const encoder = new TextEncoder();

/** Why a diagram source will not be handed to Mermaid, or null when it is within bounds. */
export function mermaidSourceProblem(source: string): string | null {
	if (source.trim().length === 0) return "The diagram is empty.";
	if (encoder.encode(source).byteLength > MERMAID_MAX_SOURCE_BYTES) {
		return `The diagram source is larger than ${MERMAID_MAX_SOURCE_BYTES / 1024} KiB, so it is shown as text.`;
	}
	const lines = source.split("\n").length;
	if (lines > MERMAID_MAX_LINES) return `The diagram has ${lines} lines; the GUI renders at most ${MERMAID_MAX_LINES}.`;
	return null;
}

/** Plain-text flattening for copy actions and accessible names. */
export function tokenText(tokens: readonly MarkdownToken[]): string {
	let text = "";
	for (const token of tokens) {
		const record = token as { text?: string; tokens?: MarkdownToken[]; raw: string; type: string };
		if (record.type === "text" || record.type === "codespan" || record.type === "escape") text += record.text ?? "";
		else if (record.tokens !== undefined) text += tokenText(record.tokens);
		else if (record.type === "space") text += " ";
		else text += record.text ?? "";
	}
	return text;
}
