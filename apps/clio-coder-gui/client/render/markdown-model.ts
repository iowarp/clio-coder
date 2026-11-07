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

import { Marked, type Token } from "marked";

export type MarkdownToken = Token;

export interface MathToken {
	type: "math";
	raw: string;
	text: string;
	displayMode: boolean;
}

/** `[^label]` in running text; it points at a definition, wherever in the message that sits. */
export interface FootnoteRefToken {
	type: "footnoteRef";
	raw: string;
	label: string;
}

/** `[^label]: text` as its own block. It renders where it was written, which is where readers expect notes. */
export interface FootnoteToken {
	type: "footnote";
	raw: string;
	label: string;
	tokens: Token[];
}

const FOOTNOTE_LABEL = "[^\\]\\s]{1,40}";
const FOOTNOTE_START = new RegExp(`^ {0,3}\\[\\^${FOOTNOTE_LABEL}\\]:`, "mu");
const FOOTNOTE_BLOCK = new RegExp(
	`^ {0,3}\\[\\^(${FOOTNOTE_LABEL})\\]:[^\\S\\n]*(\\S[^\\n]*(?:\\n(?: {2,}|\\t)[^\\n]*\\S[^\\n]*)*)(?:\\n|$)`,
	"u",
);
const FOOTNOTE_REF = new RegExp(`^\\[\\^(${FOOTNOTE_LABEL})\\](?!:)`, "u");

/** Where inline math could start: `$`, or the LaTeX delimiters `\(` and `\[` that many models write. */
function firstMathDelimiter(source: string): number | undefined {
	let first = -1;
	for (const delimiter of ["$", "\\(", "\\["]) {
		const index = source.indexOf(delimiter);
		if (index >= 0 && (first < 0 || index < first)) first = index;
	}
	return first < 0 ? undefined : first;
}

const LATEX_INLINE = /^\\\(([\s\S]+?)\\\)/u;
const LATEX_DISPLAY = /^\\\[([\s\S]+?)\\\]/u;
const DOUBLED_DOLLAR = /^\$\$((?:\\[\s\S]|[^\\$])+?)\$\$/u;
const SINGLE_DOLLAR = /^\$(?![\s$])((?:\\.|[^\\$`\n])+?)\$(?!\d)/u;

/**
 * Inline math in its four spellings. `$…$` keeps its currency guards (no space inside the
 * delimiters, no digit after). `$$…$$` and `\[…\]` inside a sentence are set as display math, the
 * way GitHub and the model's own preview set them; `\(…\)` is inline. None crosses a blank line.
 */
function inlineMath(source: string): MathToken | undefined {
	for (const [pattern, displayMode] of [
		[LATEX_INLINE, false],
		[LATEX_DISPLAY, true],
		[DOUBLED_DOLLAR, true],
	] as const) {
		const match = pattern.exec(source);
		if (match?.[1] === undefined) continue;
		if (!match[1].trim() || /\n\s*\n/u.test(match[1])) return undefined;
		// `\[12\]` is far more often an escaped citation than an equation.
		if (pattern === LATEX_DISPLAY && /^\s*\d+(?:\s*[,–-]\s*\d+)*\s*$/u.test(match[1])) return undefined;
		return { type: "math", raw: match[0], text: match[1].trim(), displayMode };
	}
	const match = SINGLE_DOLLAR.exec(source);
	if (match?.[1] && !/\s$/u.test(match[1])) return { type: "math", raw: match[0], text: match[1], displayMode: false };
	return undefined;
}

const lexer = new Marked(
	{ gfm: true, breaks: false, pedantic: false, async: false },
	{
		extensions: [
			{
				name: "footnote",
				level: "block",
				start: (source) => FOOTNOTE_START.exec(source)?.index,
				tokenizer(source): FootnoteToken | undefined {
					const match = FOOTNOTE_BLOCK.exec(source);
					if (!match?.[1] || match[2] === undefined) return undefined;
					const text = match[2].replace(/\n[ \t]+/gu, " ");
					return { type: "footnote", raw: match[0], label: match[1], tokens: this.lexer.inlineTokens(text) };
				},
			},
			{
				name: "footnoteRef",
				level: "inline",
				start: (source) => {
					const index = source.indexOf("[^");
					return index < 0 ? undefined : index;
				},
				tokenizer(source): FootnoteRefToken | undefined {
					const match = FOOTNOTE_REF.exec(source);
					if (match?.[1]) return { type: "footnoteRef", raw: match[0], label: match[1] };
				},
			},
			{
				name: "math",
				level: "block",
				start: (source) => /^ {0,3}(?:\$\$|\\\[)/mu.exec(source)?.index,
				tokenizer(source): MathToken | undefined {
					const match =
						/^ {0,3}\$\$((?:\\[\s\S]|[^\\])+?)\$\$[^\S\n]*(?:\n|$)/u.exec(source) ??
						/^ {0,3}\\\[([\s\S]+?)\\\][^\S\n]*(?:\n|$)/u.exec(source);
					if (match?.[1]?.trim()) return { type: "math", raw: match[0], text: match[1].trim(), displayMode: true };
				},
			},
			{
				name: "math",
				level: "inline",
				start: (source) => firstMathDelimiter(source),
				tokenizer(source): MathToken | undefined {
					return inlineMath(source);
				},
			},
		],
	},
);

export type DiffLineKind = "add" | "remove" | "hunk" | "meta" | "context";

/** How a line of a unified diff reads: file headers and hunk ranges are not changes, and `+++`/`---` are headers. */
export function diffLineKind(line: string): DiffLineKind {
	if (line.startsWith("@@")) return "hunk";
	if (line.startsWith("\\ ")) return "meta";
	if (
		/^(?:\+\+\+|---)(?: |$)|^(?:diff |index |new file mode|deleted file mode|similarity |rename (?:from|to) )/u.test(line)
	)
		return "meta";
	if (line.startsWith("+")) return "add";
	if (line.startsWith("-")) return "remove";
	return "context";
}

export interface DiffLine {
	readonly kind: DiffLineKind;
	readonly old: number | null;
	readonly new: number | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

/**
 * Reads a unified diff line by line, numbering each line in the old and new file from its hunk header. A
 * hunk's counts decide where it ends, so a removed line that reads `--- x` is a change, not a header, and
 * a diff without `@@` ranges carries no numbers at all.
 */
export function diffLines(code: string): DiffLine[] {
	const out: DiffLine[] = [];
	let oldAt = 0;
	let newAt = 0;
	let oldLeft = 0;
	let newLeft = 0;
	for (const line of code.split("\n")) {
		if (oldLeft > 0 || newLeft > 0) {
			const sign = line[0];
			if (sign === "-" && oldLeft > 0) {
				out.push({ kind: "remove", old: oldAt++, new: null });
				oldLeft--;
				continue;
			}
			if (sign === "+" && newLeft > 0) {
				out.push({ kind: "add", old: null, new: newAt++ });
				newLeft--;
				continue;
			}
			if ((sign === " " || line === "") && oldLeft > 0 && newLeft > 0) {
				out.push({ kind: "context", old: oldAt++, new: newAt++ });
				oldLeft--;
				newLeft--;
				continue;
			}
			oldLeft = 0;
			newLeft = 0;
		}
		const hunk = HUNK_HEADER.exec(line);
		if (hunk) {
			oldAt = Number(hunk[1]);
			newAt = Number(hunk[3]);
			oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
			newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
		}
		out.push({ kind: diffLineKind(line), old: null, new: null });
	}
	return out;
}

/** Without a directory, `a.b` is as likely a member access (`process.env`) as a file, so only these extensions count. */
const FILE_EXTENSIONS: ReadonlySet<string> = new Set(
	(
		"ts tsx mts cts js jsx mjs cjs json jsonc md mdx txt yml yaml toml ini cfg conf lock py pyi rb go rs java kt " +
		"swift c h cc cpp hpp cs php sh bash zsh fish ps1 sql html htm css scss less vue svelte xml svg png jpg jpeg gif " +
		"webp pdf csv tsv diff patch proto graphql gradle make cmake dockerfile tf lua r jl ex exs erl hs ml dart zig nix"
	).split(" "),
);

/**
 * A code span that names a workspace file, optionally at a line: `src/a.ts`, `src/a.ts:42`, `a.ts:42:7`, `a.ts#L42`.
 * Only a path with a directory or a file extension counts, so a bare word in backticks stays code.
 */
export function pathReference(text: string): { path: string; line: number | null } | null {
	if (text.length > 512) return null;
	const match = /^((?:~|\.{1,2})?\/?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)?$/u.exec(
		text,
	);
	if (!match?.[1]) return null;
	const path = match[1];
	const extension = /\.([a-z][\w]{0,9})$/iu.exec(path)?.[1]?.toLowerCase();
	const named = path.includes("/")
		? extension !== undefined || /^[.~]/u.test(path)
		: FILE_EXTENSIONS.has(extension ?? "");
	if (!named || /^\d+(?:\.\d+)+$/u.test(path) || path.endsWith(".")) return null;
	const line = match[2] ?? match[3];
	return { path, line: line === undefined ? null : Number(line) };
}

export function lexMarkdown(source: string): readonly MarkdownToken[] {
	return lexer.lexer(source);
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
	// The delimiter that closes the display math block a line opened, while one is open.
	let displayMath: "$$" | "\\]" | null = null;
	let fence: { readonly char: string; readonly length: number } | null = null;
	while (index < source.length) {
		const lineEnd = source.indexOf("\n", index);
		if (lineEnd < 0) break;
		const line = source.slice(index, lineEnd);
		if (fence === null && displayMath === null && /^ {0,3}\\\[/u.test(line)) {
			if (!/\\\]/u.test(line.slice(line.indexOf("\\[") + 2))) displayMath = "\\]";
			index = lineEnd + 1;
			continue;
		}
		if (fence === null && displayMath === "\\]") {
			if (line.includes("\\]")) displayMath = null;
			index = lineEnd + 1;
			continue;
		}
		if (fence === null && (displayMath === "$$" || /^ {0,3}\$\$/u.test(line))) {
			const delimiters = line.replace(/\\./gu, "").match(/\$\$/gu)?.length ?? 0;
			if (delimiters % 2 !== 0) displayMath = displayMath === null ? "$$" : null;
			index = lineEnd + 1;
			continue;
		}
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
	// The languages of scientific code, by the names and file extensions people put on a fence.
	ipython: "python",
	py3: "python",
	pyi: "python",
	pyx: "python",
	cython: "python",
	sage: "python",
	h: "cpp",
	hpp: "cpp",
	hh: "cpp",
	hxx: "cpp",
	cc: "cpp",
	cxx: "cpp",
	cu: "cpp",
	cuh: "cpp",
	cuda: "cpp",
	f: "fortran",
	for: "fortran",
	ftn: "fortran",
	f77: "fortran",
	f95: "fortran",
	f03: "fortran",
	f08: "fortran",
	f18: "fortran",
	fortran90: "fortran",
	rscript: "r",
	octave: "matlab",
	slurm: "slurm",
	sbatch: "slurm",
	pbs: "slurm",
	qsub: "slurm",
	lsf: "slurm",
	bsub: "slurm",
	cmake: "cmake",
	cmakelists: "cmake",
	log: "log",
	logs: "log",
	stdout: "log",
	stderr: "log",
	terminal: "shell-session",
	jsonl: "json",
	ndjson: "json",
	geojson: "json",
	ipynb: "json",
	cfg: "ini",
	conf: "ini",
	mk: "makefile",
};

export const MERMAID_LANGUAGE = "mermaid";

export interface CodeLanguage {
	/** The label shown to the reader, or null when the fence carried no usable info string. */
	readonly label: string | null;
	/** The Prism grammar id, or null when the language is unknown or the block is a diagram. */
	readonly grammar: string | null;
	readonly mermaid: boolean;
	/** A ```math fence: display TeX, as GitHub and GitLab read it. */
	readonly math: boolean;
}

export function codeLanguage(info: string | undefined): CodeLanguage {
	const word = (info ?? "").trim().split(/\s+/u, 1)[0] ?? "";
	const label = word.replace(/[^A-Za-z0-9_+#.-]/gu, "").slice(0, 24);
	if (label.length === 0) return { label: null, grammar: null, mermaid: false, math: false };
	const key = label.toLocaleLowerCase("en-US");
	if (key === MERMAID_LANGUAGE) return { label: "mermaid", grammar: null, mermaid: true, math: false };
	if (key === "math") return { label: "math", grammar: "latex", mermaid: false, math: true };
	return { label, grammar: LANGUAGE_ALIASES[key] ?? null, mermaid: false, math: false };
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

/**
 * A count, an amount or a measurement: digits with an optional sign, currency mark, separators, an
 * uncertainty (`0.93 ± 0.02`) and a short unit.
 */
const NUMERIC_CELL =
	/^[+\-−±~≈<>]?\s?[$€£¥]?\d[\d,._\u00a0 ]*(?:[eE][+-]?\d+)?(?:\s?(?:±|\+\/-)\s?\d[\d,.]*(?:[eE][+-]?\d+)?)?\s?(?:%|‰|×|x|[A-Za-zµ°/]{1,6})?$/u;

/**
 * Which columns hold only numbers, so they can be set right-aligned in tabular figures and compared
 * by eye. A column with no value at all is not numeric, and an empty cell or a dash does not disqualify one.
 */
export function numericColumns(rows: readonly (readonly string[])[], columns: number): readonly boolean[] {
	return Array.from({ length: columns }, (_, column) => {
		let seen = 0;
		for (const row of rows) {
			const cell = (row[column] ?? "").trim();
			if (cell === "" || cell === "-" || cell === "–" || cell === "—") continue;
			if (!NUMERIC_CELL.test(cell)) return false;
			seen += 1;
		}
		return seen > 0;
	});
}

/** The table as tab-separated text, which pastes into a spreadsheet as cells. */
export function tableText(header: readonly string[], rows: readonly (readonly string[])[]): string {
	const clean = (cell: string) => cell.replace(/[\t\n\r]+/gu, " ").trim();
	return [header, ...rows].map((row) => row.map(clean).join("\t")).join("\n");
}
