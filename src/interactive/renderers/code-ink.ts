import { type ClioToken, clioTheme } from "../theme/index.js";

/**
 * Code ink: quiet syntax highlighting for fenced code blocks. Code inside a
 * fence is quoted material, not UI state: comments use supporting ink,
 * strings use terminal green, keywords action orange, and literals turquoise.
 * Everything else,
 * including identifiers, types, function names, and punctuation, stays plain.
 * The mapping is closed to extension. When the lexer is unsure it leaves text
 * plain: under-highlighting is correct behavior, mis-highlighting is a defect.
 */

type InkKind = "comment" | "string" | "keyword" | "number";

const INK_TOKEN: Record<InkKind, ClioToken> = {
	keyword: "syntaxKeyword",
	string: "syntaxString",
	number: "syntaxLiteral",
	comment: "syntaxComment",
};

/**
 * Lexer state carried from one line to the next inside a single fence. Only
 * constructs that legally span lines carry: block comments in the ts family,
 * template literals in the ts family, and triple-quoted strings in python.
 */
type Carry = { kind: "none" } | { kind: "blockComment" } | { kind: "template" } | { kind: "triple"; quote: string };

interface Span {
	start: number;
	end: number;
	kind: InkKind;
}

interface LangSpec {
	lineComment: string | null;
	/** Bash comments start only at the line head or after whitespace, so `${#x}` stays plain. */
	commentNeedsBoundary: boolean;
	blockComments: boolean;
	templates: boolean;
	triples: boolean;
	quotes: string;
	/** Dim a leading `$ ` shell prompt so pasted terminal sessions read as sessions. */
	shellPrompt: boolean;
	keywords: ReadonlySet<string>;
}

const TS_KEYWORDS: ReadonlySet<string> = new Set([
	"abstract",
	"as",
	"async",
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"declare",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"from",
	"function",
	"if",
	"implements",
	"import",
	"in",
	"instanceof",
	"interface",
	"let",
	"new",
	"null",
	"of",
	"private",
	"protected",
	"public",
	"readonly",
	"return",
	"satisfies",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"type",
	"typeof",
	"undefined",
	"var",
	"void",
	"while",
	"yield",
]);

const PYTHON_KEYWORDS: ReadonlySet<string> = new Set([
	"False",
	"None",
	"True",
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"try",
	"while",
	"with",
	"yield",
]);

const BASH_KEYWORDS: ReadonlySet<string> = new Set([
	"case",
	"coproc",
	"do",
	"done",
	"elif",
	"else",
	"esac",
	"fi",
	"for",
	"function",
	"if",
	"in",
	"select",
	"then",
	"time",
	"until",
	"while",
]);

const JSON_KEYWORDS: ReadonlySet<string> = new Set(["true", "false", "null"]);

const TS_SPEC: LangSpec = {
	lineComment: "//",
	commentNeedsBoundary: false,
	blockComments: true,
	templates: true,
	triples: false,
	quotes: `"'`,
	shellPrompt: false,
	keywords: TS_KEYWORDS,
};

const JSON_SPEC: LangSpec = {
	lineComment: null,
	commentNeedsBoundary: false,
	blockComments: false,
	templates: false,
	triples: false,
	quotes: `"`,
	shellPrompt: false,
	keywords: JSON_KEYWORDS,
};

const BASH_SPEC: LangSpec = {
	lineComment: "#",
	commentNeedsBoundary: true,
	blockComments: false,
	templates: false,
	triples: false,
	quotes: `"'`,
	shellPrompt: true,
	keywords: BASH_KEYWORDS,
};

const PYTHON_SPEC: LangSpec = {
	lineComment: "#",
	commentNeedsBoundary: false,
	blockComments: false,
	templates: false,
	triples: true,
	quotes: `"'`,
	shellPrompt: false,
	keywords: PYTHON_KEYWORDS,
};

/**
 * The supported fence tags are the five languages the design doc names plus
 * their obvious full-word spellings. Every other tag, and no tag, means plain.
 */
function resolveSpec(tag: string): LangSpec | "diff" | null {
	switch (tag) {
		case "ts":
		case "tsx":
		case "js":
		case "jsx":
		case "typescript":
		case "javascript":
			return TS_SPEC;
		case "json":
			return JSON_SPEC;
		case "bash":
		case "sh":
		case "shell":
			return BASH_SPEC;
		case "python":
		case "py":
			return PYTHON_SPEC;
		case "diff":
			return "diff";
		default:
			return null;
	}
}

const NUMBER_RE = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?n?)/;

function isIdentPart(ch: string): boolean {
	return ch.length === 1 && /[A-Za-z0-9_$]/.test(ch);
}

function isIdentStart(ch: string): boolean {
	return ch.length === 1 && /[A-Za-z_$]/.test(ch);
}

/** Index of the closing quote, honoring backslash escapes when the language has them. */
function findQuoteEnd(line: string, from: number, quote: string, allowEscapes: boolean): number {
	for (let i = from; i < line.length; i++) {
		const ch = line[i] ?? "";
		if (allowEscapes && ch === "\\") {
			i += 1;
			continue;
		}
		if (ch === quote) return i;
	}
	return -1;
}

function scanLine(line: string, spec: LangSpec, carry: Carry): { spans: Span[]; carry: Carry } {
	const spans: Span[] = [];
	let i = 0;

	if (carry.kind === "blockComment") {
		const close = line.indexOf("*/");
		if (close < 0) {
			if (line.length > 0) spans.push({ start: 0, end: line.length, kind: "comment" });
			return { spans, carry };
		}
		spans.push({ start: 0, end: close + 2, kind: "comment" });
		i = close + 2;
	} else if (carry.kind === "template") {
		const close = findQuoteEnd(line, 0, "`", true);
		if (close < 0) {
			if (line.length > 0) spans.push({ start: 0, end: line.length, kind: "string" });
			return { spans, carry };
		}
		spans.push({ start: 0, end: close + 1, kind: "string" });
		i = close + 1;
	} else if (carry.kind === "triple") {
		const close = line.indexOf(carry.quote);
		if (close < 0) {
			if (line.length > 0) spans.push({ start: 0, end: line.length, kind: "string" });
			return { spans, carry };
		}
		spans.push({ start: 0, end: close + carry.quote.length, kind: "string" });
		i = close + carry.quote.length;
	}

	while (i < line.length) {
		const ch = line[i] ?? "";
		const prev = i > 0 ? (line[i - 1] ?? "") : "";
		if (
			spec.lineComment !== null &&
			line.startsWith(spec.lineComment, i) &&
			(!spec.commentNeedsBoundary || i === 0 || /\s/.test(prev))
		) {
			spans.push({ start: i, end: line.length, kind: "comment" });
			break;
		}
		if (spec.blockComments && line.startsWith("/*", i)) {
			const close = line.indexOf("*/", i + 2);
			if (close < 0) {
				spans.push({ start: i, end: line.length, kind: "comment" });
				return { spans, carry: { kind: "blockComment" } };
			}
			spans.push({ start: i, end: close + 2, kind: "comment" });
			i = close + 2;
			continue;
		}
		if (spec.triples && (line.startsWith('"""', i) || line.startsWith("'''", i))) {
			const quote = line.slice(i, i + 3);
			const close = line.indexOf(quote, i + 3);
			if (close < 0) {
				spans.push({ start: i, end: line.length, kind: "string" });
				return { spans, carry: { kind: "triple", quote } };
			}
			spans.push({ start: i, end: close + 3, kind: "string" });
			i = close + 3;
			continue;
		}
		if (spec.templates && ch === "`") {
			const close = findQuoteEnd(line, i + 1, "`", true);
			if (close < 0) {
				spans.push({ start: i, end: line.length, kind: "string" });
				return { spans, carry: { kind: "template" } };
			}
			spans.push({ start: i, end: close + 1, kind: "string" });
			i = close + 1;
			continue;
		}
		if (ch.length === 1 && spec.quotes.includes(ch)) {
			// Bash single quotes take no escapes; everything else honors backslash.
			const allowEscapes = !(spec.shellPrompt && ch === "'");
			const close = findQuoteEnd(line, i + 1, ch, allowEscapes);
			// An unterminated single-line string colors to the end of the line and
			// does not carry: only templates and triples legally span lines.
			const end = close < 0 ? line.length : close + 1;
			spans.push({ start: i, end, kind: "string" });
			i = end;
			continue;
		}
		if (spec.shellPrompt && ch === "-" && (i === 0 || /\s/u.test(prev))) {
			const flag = /^--?[\w-]+/u.exec(line.slice(i));
			if (flag) {
				spans.push({ start: i, end: i + flag[0].length, kind: "number" });
				i += flag[0].length;
				continue;
			}
		}
		if (/\d/.test(ch) && !isIdentPart(prev)) {
			const match = NUMBER_RE.exec(line.slice(i));
			if (match) {
				spans.push({ start: i, end: i + match[0].length, kind: "number" });
				i += match[0].length;
				continue;
			}
		}
		if (isIdentStart(ch)) {
			let end = i + 1;
			while (end < line.length && isIdentPart(line[end] ?? "")) end += 1;
			const word = line.slice(i, end);
			// A word reached through a property access is a member name, never a
			// language keyword, so `token.type` and `promise.catch` stay plain.
			if (spec.keywords.has(word) && prev !== ".") {
				spans.push({ start: i, end, kind: "keyword" });
			}
			i = end;
			continue;
		}
		i += 1;
	}
	return { spans, carry: { kind: "none" } };
}

function paintLine(line: string, spans: ReadonlyArray<Span>, theme: ReturnType<typeof clioTheme>): string {
	if (spans.length === 0) return line;
	let out = "";
	let cursor = 0;
	for (const span of spans) {
		if (span.start > cursor) out += line.slice(cursor, span.start);
		out += theme.fg(INK_TOKEN[span.kind], line.slice(span.start, span.end));
		cursor = span.end;
	}
	if (cursor < line.length) out += line.slice(cursor);
	return out;
}

/**
 * Diff fences color by what a line does, not what it lexes as: added lines
 * success, removed lines error, hunk headers dim. The `+++`/`---` file headers
 * are neither added nor removed content, so they stay plain.
 */
function inkDiffLine(line: string, theme: ReturnType<typeof clioTheme>): string {
	if (line.startsWith("@@")) return theme.fg("toolMetadata", line);
	if (line.startsWith("+++") || line.startsWith("---")) return line;
	if (line.startsWith("+")) return theme.fg("success", line);
	if (line.startsWith("-")) return theme.fg("error", line);
	return line;
}

/**
 * Style the raw lines of one fenced code block for the given fence language
 * tag. This is the only module that composes code color; every consumer feeds
 * fences through here and nothing post-processes the result.
 */
export function codeInk(lang: string | undefined, lines: ReadonlyArray<string>): string[] {
	const lexer = codeInkLexer(lang);
	return lexer === null ? [...lines] : lexer.ink(lines, lexer.start);
}

/** The lexer's position between two lines of one fence. Opaque to callers. */
export type CodeInkCarry = Carry;

/**
 * Line-at-a-time access to the same lexer, for text that grows while it is on
 * screen. A streamed file advances the carry once per completed line and paints
 * only the rows in view from the carry recorded before the first of them, so a
 * frame costs the rows it shows, not the file it belongs to.
 */
export interface CodeInkLexer {
	readonly start: CodeInkCarry;
	advance(line: string, carry: CodeInkCarry): CodeInkCarry;
	ink(lines: ReadonlyArray<string>, carry: CodeInkCarry): string[];
}

export function codeInkLexer(lang: string | undefined): CodeInkLexer | null {
	const spec = resolveSpec((lang ?? "").trim().toLowerCase());
	if (spec === null) return null;
	const start: Carry = { kind: "none" };
	if (spec === "diff") {
		return {
			start,
			advance: (_line, carry) => carry,
			ink: (lines) => {
				const theme = clioTheme();
				return lines.map((line) => inkDiffLine(line, theme));
			},
		};
	}
	const promptLine = (line: string, carry: Carry): boolean =>
		spec.shellPrompt && carry.kind === "none" && line.startsWith("$ ");
	return {
		start,
		advance: (line, carry) => scanLine(promptLine(line, carry) ? line.slice(2) : line, spec, carry).carry,
		ink: (lines, from) => {
			const theme = clioTheme();
			let carry = from;
			const out: string[] = [];
			for (const line of lines) {
				if (promptLine(line, carry)) {
					const rest = line.slice(2);
					const scanned = scanLine(rest, spec, carry);
					carry = scanned.carry;
					out.push(`${theme.fg("toolMetadata", "$")} ${paintLine(rest, scanned.spans, theme)}`);
					continue;
				}
				const scanned = scanLine(line, spec, carry);
				carry = scanned.carry;
				out.push(paintLine(line, scanned.spans, theme));
			}
			return out;
		},
	};
}

const INK_LANG_BY_EXTENSION: Readonly<Record<string, string>> = {
	ts: "ts",
	tsx: "ts",
	mts: "ts",
	cts: "ts",
	js: "ts",
	jsx: "ts",
	mjs: "ts",
	cjs: "ts",
	json: "json",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	py: "python",
	diff: "diff",
	patch: "diff",
};

/** The fence language a file's extension names, when code ink knows it. */
export function codeInkLangForPath(path: string): string | undefined {
	const dot = path.lastIndexOf(".");
	if (dot < 0 || dot < path.lastIndexOf("/")) return undefined;
	return INK_LANG_BY_EXTENSION[path.slice(dot + 1).toLowerCase()];
}

/** Shell syntax, with Python ink for a declared `python -c` source argument. */
export function shellCommandInk(command: string): string[] {
	const tokens = command.matchAll(/'[^']*'|"(?:\\[\s\S]|[^"\\])*"|[|;&()<>]+|[^\s'"|;&()<>]+|\s+|./gu);
	let python = false;
	let sourceArgument = false;
	let expectCommand = true;
	let cursor = 0;
	const theme = clioTheme();
	const painted: string[] = [];
	for (const match of tokens) {
		const token = match[0];
		if (/^\s+$/u.test(token)) {
			if (token.includes("\n")) expectCommand = true;
			continue;
		}
		const quote = token[0];
		const quoted = (quote === "'" || quote === '"') && token.endsWith(quote) && token.length >= 2;
		if (python && sourceArgument && quoted) {
			painted.push(codeInk("bash", command.slice(cursor, match.index).split("\n")).join("\n"));
			const source = token.slice(1, -1);
			painted.push(
				theme.fg("syntaxString", quote),
				codeInk("python", source.split("\n")).join("\n"),
				theme.fg("syntaxString", quote),
			);
			cursor = match.index + token.length;
			python = false;
		}
		if (/^[|;&()<>]+$/u.test(token)) {
			python = false;
			expectCommand = true;
		} else if (expectCommand && !/^[A-Za-z_][\w]*=/u.test(token)) {
			python = /(?:^|\/)python(?:[23](?:\.\d+)?)?$/u.test(token);
			expectCommand = token === "env";
		}
		sourceArgument = python && token === "-c";
	}
	painted.push(codeInk("bash", command.slice(cursor).split("\n")).join("\n"));
	return painted.join("").split("\n");
}

/** Explicit code fences in tool evidence keep syntax ink and their exact rows. */
export function toolOutputInk(text: string): string[] {
	const lines = text.split("\n");
	const output: string[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const fence = /^ {0,3}(`{3,}|~{3,})\s*([^\s]*)/u.exec(line);
		if (!fence) {
			output.push(line);
			continue;
		}
		const mark = fence[1] ?? "```";
		const closing = new RegExp(`^ {0,3}${mark[0]}{${mark.length},}\\s*$`, "u");
		const start = index + 1;
		let end = start;
		while (end < lines.length && !closing.test(lines[end] ?? "")) end += 1;
		output.push(clioTheme().fg("toolMetadata", line), ...codeInk(fence[2], lines.slice(start, end)));
		if (end < lines.length) output.push(clioTheme().fg("toolMetadata", lines[end] ?? ""));
		index = end;
	}
	return output;
}
