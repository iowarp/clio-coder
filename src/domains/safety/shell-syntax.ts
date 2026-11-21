/**
 * A bash parser for the part of the language the safety rails reason about
 * (row 287): a flat list of and-or chains of pipelines of simple commands,
 * with words, quoting, parameter and command substitution, redirections and
 * here-documents. It is a proof domain, not a shell: anything outside that
 * grammar (a compound command, a function definition, a subshell or brace
 * group, a reserved word, an array or named-descriptor form, an unterminated
 * quote) parses to null, and a caller that grants anything on a reading grants
 * nothing then. Nothing is expanded or executed; {@link staticWordValue} only
 * reads a word whose value the text alone fixes.
 */

/** One piece of a word. `quoted` is true inside quotes or after a backslash, where the shell splits and globs nothing. */
export type ShellWordPart =
	| { kind: "literal"; text: string; quoted: boolean }
	| { kind: "param"; name: string; quoted: boolean; start: number; end: number }
	| { kind: "command"; script: string; quoted: boolean }
	/** Arithmetic, `${...}` with an operator, an ANSI-C string with escapes, a process substitution: never static. */
	| { kind: "opaque"; quoted: boolean };

export interface ShellWord {
	parts: ShellWordPart[];
	start: number;
	end: number;
}

export interface ShellHeredoc {
	delimiter: string;
	/** Any quote or backslash in the delimiter word: the body is read as written, with no expansion. */
	quoted: boolean;
	stripTabs: boolean;
	body: string;
	/** The body's lines and its delimiter line, as offsets into the source. */
	bodyStart: number;
	bodyEnd: number;
}

export interface ShellRedirect {
	fd: number | null;
	op: string;
	target: ShellWord;
	heredoc?: ShellHeredoc;
	start: number;
	end: number;
}

export interface ShellAssignment {
	name: string;
	append: boolean;
	value: ShellWord;
	start: number;
	end: number;
}

export interface ShellSimpleCommand {
	assignments: ShellAssignment[];
	words: ShellWord[];
	redirects: ShellRedirect[];
	start: number;
	end: number;
}

export interface ShellPipeline {
	negated: boolean;
	commands: ShellSimpleCommand[];
}

/** `pipelines[i]` runs after `ops[i - 1]` (`&&` or `||`) joins it to the one before. */
export interface ShellAndOr {
	pipelines: ShellPipeline[];
	ops: Array<"&&" | "||">;
}

export interface ShellListItem {
	andOr: ShellAndOr;
	background: boolean;
}

export interface ShellScript {
	items: ShellListItem[];
	heredocs: ShellHeredoc[];
}

/** Words that open or close a compound command, or change how one is run, in command position. */
const RESERVED = new Set([
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"do",
	"done",
	"while",
	"until",
	"for",
	"case",
	"esac",
	"select",
	"function",
	"in",
	"time",
	"coproc",
	"{",
	"}",
	"[[",
	"]]",
	"!",
]);
const BLANK = /[ \t]/u;
const WORD_END = /[ \t\n;&|<>()]/u;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SPECIAL_PARAM = /^(?:[0-9]+|[@*#?$!-])$/u;
const MAX_DEPTH = 4;

class Unsupported extends Error {}

function fail(): never {
	throw new Unsupported();
}

interface PendingHeredoc {
	redirect: ShellRedirect;
	delimiter: string;
	quoted: boolean;
	stripTabs: boolean;
}

class Parser {
	private pos = 0;
	private readonly pending: PendingHeredoc[] = [];
	readonly heredocs: ShellHeredoc[] = [];

	constructor(private readonly src: string) {}

	private peek(offset = 0): string {
		return this.src[this.pos + offset] ?? "";
	}

	private atEnd(): boolean {
		return this.pos >= this.src.length;
	}

	/** Blanks and a comment that starts a word; never a newline. */
	private skipBlanks(): void {
		for (;;) {
			const char = this.peek();
			if (BLANK.test(char)) this.pos += 1;
			else if (char === "#") {
				while (!this.atEnd() && this.peek() !== "\n") this.pos += 1;
			} else return;
		}
	}

	/** A newline outside any word: the here-document bodies its line opened start after it. */
	private newline(): void {
		this.pos += 1;
		for (const doc of this.pending.splice(0)) this.readBody(doc);
	}

	private skipNewlines(): void {
		for (;;) {
			this.skipBlanks();
			if (this.peek() !== "\n") return;
			this.newline();
		}
	}

	private readBody(doc: PendingHeredoc): void {
		const bodyStart = this.pos;
		const lines: string[] = [];
		while (!this.atEnd()) {
			const newline = this.src.indexOf("\n", this.pos);
			const lineEnd = newline === -1 ? this.src.length : newline;
			const raw = this.src.slice(this.pos, lineEnd);
			const line = doc.stripTabs ? raw.replace(/^\t+/u, "") : raw;
			this.pos = newline === -1 ? this.src.length : newline + 1;
			if (line === doc.delimiter) break;
			lines.push(line);
		}
		const heredoc: ShellHeredoc = {
			delimiter: doc.delimiter,
			quoted: doc.quoted,
			stripTabs: doc.stripTabs,
			body: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
			bodyStart,
			bodyEnd: this.pos,
		};
		doc.redirect.heredoc = heredoc;
		this.heredocs.push(heredoc);
	}

	parseScript(): ShellScript {
		const items: ShellListItem[] = [];
		for (;;) {
			this.skipNewlines();
			if (this.atEnd()) break;
			const andOr = this.parseAndOr();
			this.skipBlanks();
			const char = this.peek();
			let background = false;
			if (char === ";") {
				if (this.peek(1) === ";" || this.peek(1) === "&") fail();
				this.pos += 1;
			} else if (char === "&") {
				background = true;
				this.pos += 1;
			} else if (char === "\n") this.newline();
			else if (!this.atEnd()) fail();
			items.push({ andOr, background });
		}
		// A here-document with no line after its operator has an empty body, as in bash.
		for (const doc of this.pending.splice(0)) this.readBody(doc);
		if (items.length === 0) fail();
		return { items, heredocs: this.heredocs };
	}

	private parseAndOr(): ShellAndOr {
		const pipelines = [this.parsePipeline()];
		const ops: Array<"&&" | "||"> = [];
		for (;;) {
			this.skipBlanks();
			const two = this.src.slice(this.pos, this.pos + 2);
			if (two !== "&&" && two !== "||") return { pipelines, ops };
			this.pos += 2;
			ops.push(two);
			this.skipNewlines();
			pipelines.push(this.parsePipeline());
		}
	}

	private parsePipeline(): ShellPipeline {
		this.skipBlanks();
		let negated = false;
		if (this.peek() === "!" && (BLANK.test(this.peek(1)) || this.peek(1) === "")) {
			negated = true;
			this.pos += 1;
		}
		const commands = [this.parseSimple()];
		for (;;) {
			this.skipBlanks();
			if (this.peek() !== "|" || this.peek(1) === "|") return { negated, commands };
			// `|&` also pipes stderr; the stages are the same commands.
			this.pos += this.peek(1) === "&" ? 2 : 1;
			this.skipNewlines();
			commands.push(this.parseSimple());
		}
	}

	private parseSimple(): ShellSimpleCommand {
		this.skipBlanks();
		const start = this.pos;
		const command: ShellSimpleCommand = { assignments: [], words: [], redirects: [], start, end: start };
		for (;;) {
			this.skipBlanks();
			const char = this.peek();
			if (this.atEnd() || char === "\n" || char === ";" || char === "|") break;
			if (char === "&" && this.peek(1) !== ">") break;
			if (char === "(" || char === ")") fail();
			const redirect = this.tryRedirect();
			if (redirect !== null) {
				command.redirects.push(redirect);
				continue;
			}
			if (command.words.length === 0) {
				const assignment = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/u.exec(this.src.slice(this.pos));
				if (assignment !== null) {
					const assignStart = this.pos;
					this.pos += assignment[0].length;
					if (this.peek() === "(") fail();
					const value = this.readWord(true);
					command.assignments.push({
						name: assignment[1] as string,
						append: assignment[2] === "+",
						value,
						start: assignStart,
						end: this.pos,
					});
					continue;
				}
				// A subscripted assignment (`B[0]=x`) is an array form this grammar does not model.
				if (/^[A-Za-z_][A-Za-z0-9_]*\[/u.test(this.src.slice(this.pos))) fail();
			}
			const word = this.readWord(false);
			if (command.words.length === 0 && command.assignments.length === 0) {
				const raw = this.src.slice(word.start, word.end);
				if (RESERVED.has(raw)) fail();
			}
			// `name()` is a function definition.
			if (command.words.length === 0 && this.peek() === "(") fail();
			command.words.push(word);
		}
		command.end = this.pos;
		if (command.words.length === 0 && command.assignments.length === 0 && command.redirects.length === 0) fail();
		return command;
	}

	private tryRedirect(): ShellRedirect | null {
		const start = this.pos;
		const rest = this.src.slice(this.pos);
		if (/^\{[^}\s]*\}[<>]/u.test(rest)) fail();
		// A process substitution is a word, not a redirection.
		if (/^[<>]\(/u.test(rest)) return null;
		const match = /^(\d*)(&>>|&>|<<<|<<-|<<|<>|<&|>&|>>|>\||<|>)/u.exec(rest);
		if (match === null) return null;
		const [whole, digits = "", op = ""] = match;
		if (digits !== "" && op.startsWith("&")) fail();
		this.pos += whole.length;
		this.skipBlanks();
		const char = this.peek();
		if (this.atEnd() || WORD_END.test(char)) fail();
		const target = this.readWord(false);
		const redirect: ShellRedirect = {
			fd: digits === "" ? null : Number(digits),
			op,
			target,
			start,
			end: this.pos,
		};
		if (op === "<<" || op === "<<-") {
			const raw = this.src.slice(target.start, target.end);
			// bash removes only quotes from a delimiter: `$'EOF'` ends at a line `$EOF`, which this reading would not see.
			if (raw.includes("$") || raw.includes("`")) fail();
			const quoted = /['"\\]/u.test(raw);
			if (target.parts.some((part) => part.kind !== "literal")) fail();
			const delimiter = target.parts.map((part) => (part.kind === "literal" ? part.text : "")).join("");
			this.pending.push({ redirect, delimiter, quoted, stripTabs: op === "<<-" });
		}
		return redirect;
	}

	private readWord(allowEmpty: boolean): ShellWord {
		const start = this.pos;
		const parts: ShellWordPart[] = [];
		const literal = (text: string, quoted: boolean): void => {
			const last = parts.at(-1);
			if (last?.kind === "literal" && last.quoted === quoted) last.text += text;
			else parts.push({ kind: "literal", text, quoted });
		};
		for (;;) {
			const char = this.peek();
			if (this.atEnd() || WORD_END.test(char)) break;
			if (char === "\\") {
				const next = this.peek(1);
				if (next === "") fail();
				this.pos += 2;
				literal(next, true);
			} else if (char === "'") {
				const close = this.src.indexOf("'", this.pos + 1);
				if (close === -1) fail();
				literal(this.src.slice(this.pos + 1, close), true);
				this.pos = close + 1;
			} else if (char === '"') {
				this.pos += 1;
				this.readDoubleQuoted(parts, literal);
			} else if (char === "`") {
				parts.push({ kind: "command", script: this.readBacktick(), quoted: false });
			} else if (char === "$") {
				this.readDollar(parts, literal, false);
			} else {
				literal(char, false);
				this.pos += 1;
			}
		}
		if (parts.length === 0 && !allowEmpty && this.pos === start) fail();
		return { parts, start, end: this.pos };
	}

	private readDoubleQuoted(parts: ShellWordPart[], literal: (text: string, quoted: boolean) => void): void {
		const before = parts.length;
		for (;;) {
			if (this.atEnd()) fail();
			const char = this.peek();
			if (char === '"') {
				this.pos += 1;
				// `""` is still a word.
				if (parts.length === before) literal("", true);
				return;
			}
			if (char === "\\") {
				const next = this.peek(1);
				if (next === "") fail();
				this.pos += 2;
				literal(/[$`"\\]/u.test(next) ? next : `\\${next}`, true);
			} else if (char === "`") parts.push({ kind: "command", script: this.readBacktick(), quoted: true });
			else if (char === "$") this.readDollar(parts, literal, true);
			else {
				literal(char, true);
				this.pos += 1;
			}
		}
	}

	private readBacktick(): string {
		let script = "";
		this.pos += 1;
		for (;;) {
			if (this.atEnd()) fail();
			const char = this.peek();
			if (char === "`") {
				this.pos += 1;
				return script;
			}
			if (char === "\\" && /[$`\\]/u.test(this.peek(1))) {
				script += this.peek(1);
				this.pos += 2;
				continue;
			}
			script += char;
			this.pos += 1;
		}
	}

	private readDollar(parts: ShellWordPart[], literal: (text: string, quoted: boolean) => void, quoted: boolean): void {
		const start = this.pos;
		const next = this.peek(1);
		if (next === "(") {
			if (this.peek(2) === "(") {
				this.pos = this.matchClose(this.pos + 1, "(", ")");
				parts.push({ kind: "opaque", quoted });
				return;
			}
			const end = this.matchClose(this.pos + 1, "(", ")");
			const script = this.src.slice(this.pos + 2, end - 1);
			this.pos = end;
			parts.push({ kind: "command", script, quoted });
			return;
		}
		if (next === "[" || next === "{") {
			// Quotes, escapes or a nested expansion inside move where the shell ends the form: outside the grammar.
			const close = this.src.indexOf(next === "[" ? "]" : "}", this.pos + 2);
			const inner = close === -1 ? "" : this.src.slice(this.pos + 2, close);
			if (close === -1 || /['"`$\\{[\n]/u.test(inner)) fail();
			const end = close + 1;
			this.pos = end;
			if (next === "[") {
				parts.push({ kind: "opaque", quoted });
				return;
			}
			if (NAME.test(inner) || SPECIAL_PARAM.test(inner)) parts.push({ kind: "param", name: inner, quoted, start, end });
			else parts.push({ kind: "opaque", quoted });
			return;
		}
		if (next === "'" && !quoted) {
			// An ANSI-C string ends at the first quote no backslash escapes: `$'\''` is one quote character.
			const close = ansiCClose(this.src, this.pos + 2);
			if (close === -1) fail();
			const text = this.src.slice(this.pos + 2, close);
			this.pos = close + 1;
			// An escape in an ANSI-C string can spell any name; only a plain one is read.
			if (text.includes("\\")) parts.push({ kind: "opaque", quoted: true });
			else literal(text, true);
			return;
		}
		if (next === '"' && !quoted) {
			// A locale string is translated through the message catalog TEXTDOMAIN and TEXTDOMAINDIR name, so its text
			// never fixes the word: read it to find its end, and keep only that it is opaque.
			this.pos += 2;
			this.readDoubleQuoted([], () => {});
			parts.push({ kind: "opaque", quoted: true });
			return;
		}
		const name = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(this.src.slice(this.pos + 1))?.[0];
		if (name !== undefined) {
			this.pos += 1 + name.length;
			parts.push({ kind: "param", name, quoted, start, end: this.pos });
			return;
		}
		if (next !== "" && SPECIAL_PARAM.test(next)) {
			this.pos += 2;
			parts.push({ kind: "param", name: next, quoted, start, end: this.pos });
			return;
		}
		literal("$", quoted);
		this.pos += 1;
	}

	/**
	 * The offset after the bracket that closes the one at `open`. Quotes and nested substitutions are skipped; a
	 * here-document or a `case` inside a substitution, whose `)` the count cannot place, is outside the grammar.
	 */
	private matchClose(open: number, opener: string, closer: string): number {
		let depth = 0;
		let index = open;
		while (index < this.src.length) {
			const char = this.src[index] as string;
			if (char === "\\") {
				index += 2;
				continue;
			}
			if (char === "#") fail();
			if (char === "$" && this.src[index + 1] === "'") {
				const close = ansiCClose(this.src, index + 2);
				if (close === -1) fail();
				index = close + 1;
				continue;
			}
			if (char === "'") {
				const close = this.src.indexOf("'", index + 1);
				if (close === -1) fail();
				index = close + 1;
				continue;
			}
			if (char === '"') {
				// A substitution or an operator expansion nested in these quotes has its own quoting this count cannot
				// follow; a plain `$NAME` or `${NAME}` holds no quote or bracket.
				index += 1;
				while (index < this.src.length && this.src[index] !== '"') {
					if (this.src[index] === "`") fail();
					if (this.src[index] === "$") {
						const plain = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/u.exec(this.src.slice(index));
						if (plain === null) fail();
						index += plain[0].length;
						continue;
					}
					index += this.src[index] === "\\" ? 2 : 1;
				}
				if (index >= this.src.length) fail();
				index += 1;
				continue;
			}
			if (char === "`") {
				const close = this.src.indexOf("`", index + 1);
				if (close === -1 || this.src.slice(index + 1, close).includes("\\")) fail();
				index = close + 1;
				continue;
			}
			if (opener === "(" && (this.src.startsWith("<<", index) || /\bcase\b/u.test(this.src.slice(index, index + 5))))
				fail();
			if (char === opener) depth += 1;
			else if (char === closer) {
				depth -= 1;
				if (depth === 0) return index + 1;
			}
			index += 1;
		}
		return fail();
	}
}

/** The offset of the quote that closes an ANSI-C string whose text starts at `from`, past backslash escapes; -1 when none. */
function ansiCClose(src: string, from: number): number {
	for (let index = from; index < src.length; index += 1) {
		if (src[index] === "\\") index += 1;
		else if (src[index] === "'") return index;
	}
	return -1;
}

/** The script a command string is, or null outside the grammar this module reads. */
export function parseShellScript(source: string, depth = 0): ShellScript | null {
	// A line continuation is removed before bash splits words, so it can join or split any token: outside the grammar.
	if (depth > MAX_DEPTH || source.includes("\\\n")) return null;
	try {
		return new Parser(source).parseScript();
	} catch (error) {
		if (error instanceof Unsupported) return null;
		throw error;
	}
}

/** A value for a parameter the caller vouches for, or undefined when its value is not known from the text. */
export type ShellParamLookup = (name: string) => string | undefined;

const NO_PARAMS: ShellParamLookup = () => undefined;

/**
 * The single word the shell passes for `word`, or null when the text does not fix it: a substitution, an opaque
 * expansion, a parameter the lookup does not know (or one that would split or glob unquoted, or vanish empty), an
 * unquoted glob or brace pattern, or an unquoted tilde.
 */
export function staticWordValue(word: ShellWord, lookup: ShellParamLookup = NO_PARAMS): string | null {
	let value = "";
	for (const part of word.parts) {
		if (part.kind === "literal") {
			// bash also expands a tilde after `=` or `:` in a word shaped like an assignment, so any unquoted one is unread.
			if (!part.quoted && /[*?[{~]/u.test(part.text)) return null;
			value += part.text;
		} else if (part.kind === "param") {
			const known = lookup(part.name);
			if (known === undefined) return null;
			if (!part.quoted && (known === "" || /[\s*?[{]/u.test(known))) return null;
			value += known;
		} else return null;
	}
	return value;
}

/** A command word with no expansion at all: what the shell looks up, after quote removal. */
export function staticCommandName(command: ShellSimpleCommand): string | null {
	const first = command.words[0];
	return first === undefined ? null : staticWordValue(first);
}

/** Whether any word, assignment value or redirect target of the command holds a part of the given kinds. */
export function commandHasPart(command: ShellSimpleCommand, kinds: ReadonlyArray<ShellWordPart["kind"]>): boolean {
	const words = [
		...command.words,
		...command.assignments.map((assignment) => assignment.value),
		...command.redirects.map((redirect) => redirect.target),
	];
	return words.some((word) => word.parts.some((part) => kinds.includes(part.kind)));
}

/** The builtins bash runs in-process: each one may read or change shell state no external program can. */
export const BASH_BUILTINS: ReadonlySet<string> = new Set([
	".",
	":",
	"[",
	"alias",
	"bg",
	"bind",
	"break",
	"builtin",
	"caller",
	"cd",
	"command",
	"compgen",
	"complete",
	"compopt",
	"continue",
	"declare",
	"dirs",
	"disown",
	"echo",
	"enable",
	"eval",
	"exec",
	"exit",
	"export",
	"false",
	"fc",
	"fg",
	"getopts",
	"hash",
	"help",
	"history",
	"jobs",
	"kill",
	"let",
	"local",
	"logout",
	"mapfile",
	"popd",
	"printf",
	"pushd",
	"pwd",
	"read",
	"readarray",
	"readonly",
	"return",
	"set",
	"shift",
	"shopt",
	"source",
	"suspend",
	"test",
	"times",
	"trap",
	"true",
	"type",
	"typeset",
	"ulimit",
	"umask",
	"unalias",
	"unset",
	"wait",
]);
