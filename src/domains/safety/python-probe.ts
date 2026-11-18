/**
 * Whether a short inline Python script provably only reads (c17-a), so `python3 -c '...'` or `python3 - <<'EOF'` that
 * prints a file's fields reads as inspection instead of a change. The proof is lexical and refuses anything it cannot
 * follow: imports come only from a fixed set of modules with no file-writing or code-running surface, `open` is a
 * direct call whose mode is a read-only literal, and no name that reaches the OS, runs code, or walks to the
 * interpreter's internals (`os`, `exec`, `getattr`, any dunder but `__name__`, any `_private` attribute) appears. A
 * module file shadowing one of those imports in the working directory is outside what text can prove.
 */

const SAFE_MODULES: ReadonlySet<string> = new Set([
	"json",
	"sys",
	"re",
	"math",
	"collections",
	"itertools",
	"functools",
	"textwrap",
	"string",
	"csv",
	"glob",
	"fnmatch",
	"difflib",
	"hashlib",
	"base64",
	"tomllib",
	"datetime",
	"time",
	"statistics",
	"pprint",
	"shlex",
	"ast",
	"keyword",
	"unicodedata",
	"decimal",
	"fractions",
	"random",
	"struct",
	"binascii",
	"typing",
	"enum",
	"heapq",
	"bisect",
]);

/** Names that reach the OS, run code, reflect into the interpreter, or evaluate annotation strings as code. */
const DENIED_NAMES: ReadonlySet<string> = new Set([
	"exec",
	"eval",
	"compile",
	"getattr",
	"setattr",
	"delattr",
	"globals",
	"locals",
	"vars",
	"breakpoint",
	"help",
	"os",
	"shutil",
	"subprocess",
	"pathlib",
	"io",
	"codecs",
	"tempfile",
	"builtins",
	"importlib",
	"ctypes",
	"posix",
	"nt",
	"socket",
	"inspect",
	"types",
	"CodeType",
	"FunctionType",
	"operator",
	"attrgetter",
	"methodcaller",
	"modules",
	"system",
	"popen",
	"remove",
	"unlink",
	"rmdir",
	"rename",
	"makedirs",
	"mkdir",
	"chmod",
	"symlink",
	"remote_exec",
	"activate_stack_trampoline",
	"get_type_hints",
	"get_annotations",
	"ForwardRef",
	"evaluate_forward_ref",
	"singledispatch",
	"singledispatchmethod",
]);

const OPEN_KEYWORDS: ReadonlySet<string> = new Set(["file", "mode", "encoding", "errors", "newline", "buffering"]);
const STRING_PREFIXES: ReadonlySet<string> = new Set(["r", "u", "b", "f", "t", "br", "rb", "fr", "rf", "tr", "rt"]);
const OPERATORS = [
	"**=",
	"//=",
	">>=",
	"<<=",
	"**",
	"//",
	"==",
	"!=",
	"<=",
	">=",
	"->",
	":=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"@=",
	"<<",
	">>",
];

interface PyToken {
	kind: "name" | "string" | "number" | "op" | "newline";
	value: string;
}

/** The script's tokens, or null when it holds anything the reader will not follow (non-ASCII code, a coding cookie). */
function pythonTokens(script: string): PyToken[] | null {
	const tokens: PyToken[] = [];
	let depth = 0;
	let index = 0;
	while (index < script.length) {
		const char = script[index] as string;
		if (char === "\n") {
			if (depth === 0) tokens.push({ kind: "newline", value: "\n" });
			index += 1;
			continue;
		}
		if (char === " " || char === "\t" || char === "\r" || char === "\f") {
			index += 1;
			continue;
		}
		if (char === "\\" && script[index + 1] === "\n") {
			index += 2;
			continue;
		}
		if (char === "#") {
			const end = script.indexOf("\n", index);
			const comment = script.slice(index, end === -1 ? script.length : end);
			if (/coding[:=]/u.test(comment)) return null;
			index = end === -1 ? script.length : end;
			continue;
		}
		const word = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(script.slice(index))?.[0];
		if (word !== undefined) {
			const quote = script[index + word.length];
			if ((quote === "'" || quote === '"') && STRING_PREFIXES.has(word.toLowerCase())) {
				const literal = stringLiteral(script, index + word.length);
				if (literal === null) return null;
				const formatted = /[ft]/iu.test(word);
				if (formatted && !formattedOnlyReads(literal.body)) return null;
				tokens.push({ kind: "string", value: formatted ? "\0" : literal.body });
				index = literal.end;
				continue;
			}
			tokens.push({ kind: "name", value: word });
			index += word.length;
			continue;
		}
		if (char === "'" || char === '"') {
			const literal = stringLiteral(script, index);
			if (literal === null) return null;
			tokens.push({ kind: "string", value: literal.body });
			index = literal.end;
			continue;
		}
		const number = /^[0-9][0-9A-Za-z_.]*/u.exec(script.slice(index))?.[0];
		if (number !== undefined) {
			tokens.push({ kind: "number", value: number });
			index += number.length;
			continue;
		}
		if (char.charCodeAt(0) > 0x7e || char.charCodeAt(0) < 0x20) return null;
		const operator = OPERATORS.find((candidate) => script.startsWith(candidate, index)) ?? char;
		if (operator === "(" || operator === "[" || operator === "{") depth += 1;
		if (operator === ")" || operator === "]" || operator === "}") depth = Math.max(0, depth - 1);
		tokens.push({ kind: "op", value: operator });
		index += operator.length;
	}
	return tokens;
}

/** The literal opening at `start` (a quote), its body and where it ends; null when unterminated. */
function stringLiteral(script: string, start: number): { body: string; end: number } | null {
	const quote = script[start] as string;
	const triple = script.startsWith(quote.repeat(3), start);
	const delimiter = triple ? quote.repeat(3) : quote;
	let index = start + delimiter.length;
	while (index < script.length) {
		if (script[index] === "\\") {
			index += 2;
			continue;
		}
		if (!triple && script[index] === "\n") return null;
		if (script.startsWith(delimiter, index))
			return { body: script.slice(start + delimiter.length, index), end: index + delimiter.length };
		index += 1;
	}
	return null;
}

/**
 * Whether an f-string's replacement fields only read: braces balance, and no field names anything denied, `open`,
 * `import`, a `_private` or dunder name, or holds a backslash or non-ASCII text the word scan cannot see past.
 */
function formattedOnlyReads(body: string): boolean {
	const text = body.replaceAll("{{", "").replaceAll("}}", "");
	let depth = 0;
	let start = 0;
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] === "{") {
			if (depth === 0) start = index + 1;
			depth += 1;
		} else if (text[index] === "}") {
			depth -= 1;
			if (depth < 0) return false;
			if (depth === 0) {
				const field = text.slice(start, index);
				if (/[\\\u0080-\uffff]/u.test(field)) return false;
				for (const name of field.match(/[A-Za-z_][A-Za-z0-9_]*/gu) ?? [])
					if (DENIED_NAMES.has(name) || name === "open" || name === "import" || name.startsWith("_")) return false;
			}
		}
	}
	return depth === 0;
}

function isBoundary(token: PyToken | undefined): boolean {
	return token === undefined || token.kind === "newline" || token.value === ";" || token.value === ":";
}

/** Whether the dotted module path between `from` and `to` starts at an allowed top-level module. */
function safeModule(tokens: ReadonlyArray<PyToken>, from: number, to: number): boolean {
	const first = tokens[from];
	return first?.kind === "name" && SAFE_MODULES.has(first.value) && dotted(tokens, from, to);
}

/** Whether each `import` in the script imports only allowed modules, as `import a.b as c, d` or `from a import x`. */
function importsAreSafe(tokens: ReadonlyArray<PyToken>, at: number): boolean {
	let back = at - 1;
	while (back >= 0 && (tokens[back]?.kind === "name" || tokens[back]?.value === ".") && tokens[back]?.value !== "from")
		back -= 1;
	if (tokens[back]?.value === "from" && back < at - 1 && isBoundary(tokens[back - 1])) {
		if (tokens[at + 1]?.value === "*") return false;
		return safeModule(tokens, back + 1, at);
	}
	if (!isBoundary(tokens[at - 1])) return false;
	let index = at + 1;
	for (;;) {
		const start = index;
		while (tokens[index]?.kind === "name" && tokens[index + 1]?.value === ".") index += 2;
		if (tokens[index]?.kind !== "name") return false;
		index += 1;
		if (!safeModule(tokens, start, index)) return false;
		if (tokens[index]?.value === "as") {
			if (tokens[index + 1]?.kind !== "name") return false;
			index += 2;
		}
		if (tokens[index]?.value !== ",") return isBoundary(tokens[index]);
		index += 1;
	}
}

function dotted(tokens: ReadonlyArray<PyToken>, from: number, to: number): boolean {
	for (let index = from; index < to; index += 1) {
		const expected = (index - from) % 2 === 0 ? "name" : ".";
		const token = tokens[index];
		if (expected === "name" ? token?.kind !== "name" : token?.value !== ".") return false;
	}
	return (to - from) % 2 === 1;
}

/** Whether `open(` at `at` opens for reading only: at most two positional arguments, a literal read mode, no unpacking. */
function openOnlyReads(tokens: ReadonlyArray<PyToken>, at: number): boolean {
	if (tokens[at + 1]?.value !== "(" || tokens[at - 1]?.value === ".") return false;
	const args: PyToken[][] = [[]];
	let depth = 0;
	let index = at + 2;
	for (; index < tokens.length; index += 1) {
		const token = tokens[index] as PyToken;
		if (token.kind === "op" && (token.value === "(" || token.value === "[" || token.value === "{")) depth += 1;
		if (token.kind === "op" && (token.value === ")" || token.value === "]" || token.value === "}")) {
			if (depth === 0) break;
			depth -= 1;
		}
		if (depth === 0 && token.value === ",") args.push([]);
		else args.at(-1)?.push(token);
	}
	if (index >= tokens.length) return false;
	const readMode = (arg: ReadonlyArray<PyToken>) =>
		arg.length === 1 && arg[0]?.kind === "string" && /^[rbt]*$/u.test(arg[0].value);
	let positional = 0;
	for (const arg of args) {
		if (arg.length === 0) continue;
		if (arg[0]?.value === "*" || arg[0]?.value === "**") return false;
		if (arg[0]?.kind === "name" && arg[1]?.value === "=") {
			if (!OPEN_KEYWORDS.has(arg[0].value)) return false;
			if (arg[0].value === "mode" && !readMode(arg.slice(2))) return false;
			continue;
		}
		positional += 1;
		if (positional > 2 || (positional === 2 && !readMode(arg))) return false;
	}
	return true;
}

/** Whether `script` provably only reads files and prints; see the module comment for what that proof refuses. */
export function pythonScriptOnlyReads(script: string): boolean {
	const tokens = pythonTokens(script);
	if (tokens === null) return false;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] as PyToken;
		if (token.kind !== "name") continue;
		const name = token.value;
		const attribute = tokens[index - 1]?.value === ".";
		if (DENIED_NAMES.has(name)) return false;
		if (name.startsWith("__") && name !== "__name__") return false;
		if (attribute && (name.startsWith("_") || /^(?:f|gi|cr|ag|tb)_/u.test(name))) return false;
		if (name === "open" && !openOnlyReads(tokens, index)) return false;
		if (name === "import" && !importsAreSafe(tokens, index)) return false;
	}
	return true;
}
