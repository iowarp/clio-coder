/**
 * Which package scripts and repository programs a set of shell commands runs,
 * read only where the reading is certain.
 *
 * A command reaches a script when a package manager is told to run it by a
 * literal name at command position (`pnpm run lint`, `npm test`), directly or
 * from the body of a script it reaches. It runs a repository file when the
 * file is the command (`./scripts/gate.sh`), or the program or a preload a
 * runner is given (`node --import tsx scripts/check-hygiene.ts`). Programs
 * are not read for the processes they start: telling a real process start
 * from an argument that only looks like one, or from a call in a function
 * nothing calls, takes more than a pattern can certify. A name or path held
 * in a variable (`pnpm run "$TASK"`, `${{ matrix.task }}`) is not resolved, so
 * an absent script is not verified as run, never shown not to run.
 *
 * The same scan says which code in a running JavaScript program is live.
 */
import { posix } from "node:path";

export interface CommandReach {
	/** Package scripts the commands run, in package.json order. */
	scripts: string[];
	/** Repository files the commands run as a program or preload, in the order found. */
	programs: string[];
}

const PACKAGE_MANAGER_RE = /^(?:pnpm|npm|yarn|bun)(?:\.cmd|\.exe)?$/;
const RUNNER_RE = /^(?:node|nodejs|tsx|ts-node|bash|sh|zsh|python3?|bun|deno)(?:\.cmd|\.exe)?$/;
/** Package-manager flags that leave which script runs unchanged. */
const QUIET_FLAGS = new Set(["-s", "--silent", "--if-present"]);
/** Runner flags after which the runner evaluates text or a module, not a repository file. */
const EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c", "-m"]);
/** Runner flags whose next word is a module the runner loads first. */
const PRELOAD_FLAGS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader"]);
/** Reserved words and assignments a command may start with before its command word. */
const LEAD_WORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{", "time", "exec"]);

interface Word {
	/** The word with quotes removed and expansions dropped. */
	text: string;
	/** False when the word holds an expansion, so what it says is known only at run time. */
	literal: boolean;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The end of a `$NAME`, `${…}`, `$(…)` or backquoted expansion that starts at `start`. */
function expansionEnd(line: string, start: number): number {
	const open = line[start] === "`" ? "`" : line[start + 1];
	if (open === "`") {
		let index = start + 1;
		while (index < line.length && line[index] !== "`") index += line[index] === "\\" ? 2 : 1;
		return index + 1;
	}
	if (open !== "(" && open !== "{") return start + 1 + (/^(?:\w+|[^\w\s])/.exec(line.slice(start + 1))?.[0].length ?? 0);
	const close = open === "(" ? ")" : "}";
	let depth = 0;
	let index = start + 1;
	while (index < line.length) {
		const char = line[index];
		if (char === "\\") index += 1;
		else if (char === "'") index = line.indexOf("'", index + 1) < 0 ? line.length : line.indexOf("'", index + 1);
		else if (char === '"') {
			index += 1;
			while (index < line.length && line[index] !== '"') index += line[index] === "\\" ? 2 : 1;
		} else if (char === open) depth += 1;
		else if (char === close && --depth === 0) return index + 1;
		index += 1;
	}
	return line.length;
}

/**
 * The simple commands of a shell command line, split at `&&`, `||`, `;`, `|`,
 * `&`, newlines and parentheses outside quotes, each as its words.
 */
export function shellCommands(line: string): Word[][] {
	const commands: Word[][] = [];
	let words: Word[] = [];
	let word: Word | null = null;
	const part = (text: string, literal = true): void => {
		word = { text: (word?.text ?? "") + text, literal: (word?.literal ?? true) && literal };
	};
	const endWord = (): void => {
		if (word) words.push(word);
		word = null;
	};
	const endCommand = (): void => {
		endWord();
		if (words.length > 0) commands.push(words);
		words = [];
	};
	let index = 0;
	while (index < line.length) {
		const char = line[index] ?? "";
		if (char === "\\") {
			if (line[index + 1] !== "\n") part(line[index + 1] ?? "");
			index += 2;
		} else if (char === "'") {
			const end = line.indexOf("'", index + 1) < 0 ? line.length : line.indexOf("'", index + 1);
			part(line.slice(index + 1, end));
			index = end + 1;
		} else if (char === '"') {
			part("");
			index += 1;
			while (index < line.length && line[index] !== '"') {
				const inner = line[index] ?? "";
				if (inner === "$" || inner === "`") {
					part("", false);
					index = expansionEnd(line, index);
				} else if (inner === "\\") {
					part(line[index + 1] ?? "");
					index += 2;
				} else {
					part(inner);
					index += 1;
				}
			}
			index += 1;
		} else if (char === "$" || char === "`") {
			part("", false);
			index = expansionEnd(line, index);
		} else if (char === "#" && word === null) {
			const end = line.indexOf("\n", index);
			index = end < 0 ? line.length : end;
		} else if ("&|;()\n".includes(char)) {
			endCommand();
			index += 1;
		} else if (/\s/.test(char)) {
			endWord();
			index += 1;
		} else {
			part(char);
			index += 1;
		}
	}
	endCommand();
	return commands;
}

function repoPath(word: Word | undefined, visible: ReadonlySet<string>): string | null {
	if (!word?.literal) return null;
	const path = word.text.replace(/^\.\//, "");
	return visible.has(path) ? path : null;
}

/** The command word of a simple command, past reserved words and variable assignments. */
function commandWordAt(words: ReadonlyArray<Word>): number {
	let at = 0;
	while (at < words.length && (LEAD_WORDS.has(words[at]?.text ?? "") || /^[A-Za-z_]\w*=/.test(words[at]?.text ?? ""))) {
		at += 1;
	}
	return at;
}

/** Whether a simple command changes directory, after which `pnpm run` may read another package.json. */
function movesDirectory(words: ReadonlyArray<Word>): boolean {
	const command = words[commandWordAt(words)]?.text;
	return command === "cd" || command === "pushd";
}

/** Whether a command line changes directory anywhere. */
export function changesDirectory(line: string): boolean {
	return shellCommands(line).some(movesDirectory);
}

/** The script a simple command runs through a package manager, or the repository files it runs. */
function commandTarget(
	words: ReadonlyArray<Word>,
	scripts: Readonly<Record<string, string>>,
	visible: ReadonlySet<string>,
): { script?: string; programs: string[] } {
	const at = commandWordAt(words);
	const command = words[at];
	if (!command?.literal) return { programs: [] };
	const name = command.text.split(/[\\/]/).at(-1) ?? command.text;
	const rest = words.slice(at + 1);
	if (PACKAGE_MANAGER_RE.test(name)) {
		let index = 0;
		const skipQuiet = (): void => {
			while (rest[index]?.literal && QUIET_FLAGS.has(rest[index]?.text ?? "")) index += 1;
		};
		skipQuiet();
		const sub = rest[index];
		if (!sub?.literal) return { programs: [] };
		if (sub.text === "test") return scripts.test === undefined ? { programs: [] } : { script: "test", programs: [] };
		if (sub.text !== "run" && sub.text !== "run-script") return { programs: [] };
		index += 1;
		skipQuiet();
		const target = rest[index];
		return target?.literal && scripts[target.text] !== undefined
			? { script: target.text, programs: [] }
			: { programs: [] };
	}
	const self = repoPath(command, visible);
	if (self) return { programs: [self] };
	if (!RUNNER_RE.test(name)) return { programs: [] };
	const programs: string[] = [];
	for (let index = 0; index < rest.length; index += 1) {
		const word = rest[index];
		if (!word?.literal || EVAL_FLAGS.has(word.text)) break;
		const preload = /^(--[\w-]+)=(.*)$/.exec(word.text);
		if (preload && PRELOAD_FLAGS.has(preload[1] ?? "")) {
			const path = repoPath({ text: preload[2] ?? "", literal: true }, visible);
			if (path) programs.push(path);
			continue;
		}
		if (PRELOAD_FLAGS.has(word.text)) {
			const path = repoPath(rest[index + 1], visible);
			if (path) programs.push(path);
			index += 1;
			continue;
		}
		if (word.text.startsWith("-")) continue;
		const program = repoPath(word, visible);
		if (program) programs.push(program);
		break;
	}
	return { programs };
}

/**
 * The package scripts and repository files the commands run. Commands and the
 * bodies of reached scripts form one work list, each visited once; a command
 * stops being read at a `cd`, which points the rest at another package. With
 * `prePost`, a reached script also reaches the `pre<name>` and `post<name>`
 * scripts npm runs around it.
 */
export function commandReach(
	commands: ReadonlyArray<string>,
	scripts: Readonly<Record<string, string>>,
	visible: ReadonlySet<string>,
	options: { prePost?: boolean } = {},
): CommandReach {
	const reached = new Set<string>();
	const programs: string[] = [];
	const pending = [...commands];
	const seen = new Set<string>();
	const reach = (name: string): void => {
		if (reached.has(name) || scripts[name] === undefined) return;
		reached.add(name);
		pending.push(scripts[name] ?? "");
		if (options.prePost) {
			reach(`pre${name}`);
			reach(`post${name}`);
		}
	};
	for (let command = pending.shift(); command !== undefined; command = pending.shift()) {
		if (seen.has(command)) continue;
		seen.add(command);
		for (const words of shellCommands(command)) {
			// What follows a `cd` runs against another directory: none of it is certain.
			if (movesDirectory(words)) break;
			const target = commandTarget(words, scripts, visible);
			if (target.script) reach(target.script);
			for (const program of target.programs) if (!programs.includes(program)) programs.push(program);
		}
	}
	return { scripts: Object.keys(scripts).filter((name) => reached.has(name)), programs };
}

interface Scan {
	text: string;
	/** Opening bracket index to its closing index, for `(`, `[` and `{` outside literals and comments. */
	close: Map<number, number>;
	/** Start to end (exclusive) of each string, template, regex literal and comment. */
	skip: Map<number, number>;
}

function quotedEnd(text: string, start: number): number {
	const quote = text[start];
	let index = start + 1;
	while (index < text.length) {
		const char = text[index];
		if (char === "\\") {
			index += 2;
			continue;
		}
		if (char === quote) return index + 1;
		if (quote !== "`" && char === "\n") return index;
		if (quote === "`" && char === "$" && text[index + 1] === "{") {
			let depth = 1;
			index += 2;
			while (index < text.length && depth > 0) {
				const inner = text[index];
				if (inner === '"' || inner === "'" || inner === "`") {
					index = quotedEnd(text, index);
					continue;
				}
				if (inner === "{") depth += 1;
				else if (inner === "}") depth -= 1;
				index += 1;
			}
			continue;
		}
		index += 1;
	}
	return text.length;
}

function regexEnd(text: string, start: number): number {
	let index = start + 1;
	let inClass = false;
	while (index < text.length && text[index] !== "\n") {
		const char = text[index];
		if (char === "\\") index += 1;
		else if (char === "[") inClass = true;
		else if (char === "]") inClass = false;
		else if (char === "/" && !inClass) return index + 1;
		index += 1;
	}
	return index;
}

/** Whether a slash opens a regex literal: after an operator or a keyword, not after a value. */
function startsRegex(text: string, index: number, previous: string): boolean {
	if (previous === "" || "(,=:[!&|?{};+-*%<>~^".includes(previous)) return true;
	const word = /([A-Za-z_$][\w$]*)\s*$/.exec(text.slice(Math.max(0, index - 24), index))?.[1];
	return word !== undefined && /^(?:return|typeof|case|in|of|yield|await|void|delete|throw|instanceof)$/.test(word);
}

/** Brackets and literals of a JavaScript or TypeScript program, in one pass. */
function scanProgram(text: string): Scan {
	const close = new Map<number, number>();
	const skip = new Map<number, number>();
	const stack: number[] = [];
	const lineEnd = (from: number): number => (text.indexOf("\n", from) < 0 ? text.length : text.indexOf("\n", from));
	let previous = "";
	let index = text.startsWith("#!") ? lineEnd(0) : 0;
	while (index < text.length) {
		const char = text[index] ?? "";
		const next = text[index + 1];
		const comment = char === "/" && (next === "/" || next === "*");
		let end = -1;
		if (comment && next === "*") {
			const stop = text.indexOf("*/", index + 2);
			end = stop < 0 ? text.length : stop + 2;
		} else if (comment) end = lineEnd(index);
		else if (char === '"' || char === "'" || char === "`") end = quotedEnd(text, index);
		else if (char === "/" && startsRegex(text, index, previous)) end = regexEnd(text, index);
		if (end >= 0) {
			skip.set(index, end);
			// A comment leaves the token before it in place; a literal is a value.
			if (!comment) previous = char;
			index = end;
			continue;
		}
		if (char === "(" || char === "[" || char === "{") stack.push(index);
		else if (char === ")" || char === "]" || char === "}") {
			const open = stack.pop();
			if (open !== undefined) close.set(open, index);
		}
		if (!/\s/.test(char)) previous = char;
		index += 1;
	}
	return { text, close, skip };
}

const JS_PROGRAM_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** A named function declaration up to its parameter list: `export async function checkX(`. */
const FUNCTION_RE =
	/(?<![\w$.])(export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/g;
/** Text that makes a following `function` an expression, whose name binds only inside it. */
const EXPRESSION_BEFORE_RE = /(?:[=(,:?[!&|]|\b(?:return|yield|await|void|typeof|new))\s*$/;
/** A relative static or dynamic import: `from "../tests/check.js"`, `import("./x")`, `require("./x")`. */
const IMPORT_RE = /\b(?:from|import|require)\s*\(?\s*(["'])(\.{1,2}\/[^"'\n]+)\1/g;

/** Whether an offset lies in a string, comment or regex, outside a template's `${…}`. */
function literalAt(scan: Scan): (at: number) => boolean {
	const ranges = [...scan.skip].sort((a, b) => a[0] - b[0]);
	return (at) => {
		let low = 0;
		let high = ranges.length - 1;
		let found = -1;
		while (low <= high) {
			const middle = (low + high) >> 1;
			if ((ranges[middle]?.[0] ?? 0) <= at) {
				found = middle;
				low = middle + 1;
			} else high = middle - 1;
		}
		const range = found >= 0 ? ranges[found] : undefined;
		if (!range || at >= range[1]) return false;
		if (scan.text[range[0]] !== "`") return true;
		const inner = scan.text.slice(range[0], at);
		return inner.lastIndexOf("${") <= inner.lastIndexOf("}");
	};
}

interface DeclaredFunction {
	name: string;
	/** From `export`/`function` through the body's closing brace. */
	start: number;
	end: number;
	exported: boolean;
}

/** The brace that opens a function body after its parameter list, past a return type annotation. */
function bodyOpen(scan: Scan, paramsClose: number): number | null {
	let previous = ")";
	let index = paramsClose + 1;
	const limit = Math.min(scan.text.length, paramsClose + 400);
	while (index < limit) {
		const char = scan.text[index] ?? "";
		const skipped = scan.skip.get(index);
		if (skipped !== undefined) {
			index = skipped;
			previous = char;
			continue;
		}
		if (char === ";") return null;
		const close = "{([".includes(char) ? scan.close.get(index) : undefined;
		if (char === "{" && !":|&<,(".includes(previous)) return close === undefined ? null : index;
		if (close !== undefined) {
			index = close + 1;
			previous = scan.text[close] ?? "";
			continue;
		}
		if (!/\s/.test(char)) previous = char;
		index += 1;
	}
	return null;
}

/** The repository files a JavaScript or TypeScript program imports by relative path. */
export function staticImports(text: string, path: string, visible: ReadonlySet<string>): string[] {
	if (!JS_PROGRAM_RE.test(path)) return [];
	const inLiteral = literalAt(scanProgram(text));
	const found: string[] = [];
	for (const match of text.matchAll(IMPORT_RE)) {
		if (inLiteral(match.index ?? 0)) continue;
		const target = posix.normalize(posix.join(posix.dirname(path), match[2] ?? ""));
		const resolved = [
			target,
			target.replace(/\.js$/, ".ts"),
			target.replace(/\.js$/, ".tsx"),
			target.replace(/\.mjs$/, ".mts"),
			target.replace(/\.cjs$/, ".cts"),
			`${target}.ts`,
			`${target}.js`,
			`${target}/index.ts`,
			`${target}/index.js`,
		].find((candidate) => visible.has(candidate));
		if (resolved && !found.includes(resolved)) found.push(resolved);
	}
	return found;
}

/**
 * A JavaScript or TypeScript program with each top-level named function that
 * nothing live names blanked out, newlines kept. Top-level code names a
 * function by calling it or by listing it (`["case-portable-paths",
 * checkCasePortablePaths]`); a function a live function names is live; an
 * exported one is live when `importers` names it. A check whose definition
 * stayed after its invocation was removed then reports nothing. Other
 * languages are returned whole.
 */
export function liveCode(text: string, path: string, importers: string): string {
	if (!JS_PROGRAM_RE.test(path)) return text;
	const scan = scanProgram(text);
	const inLiteral = literalAt(scan);
	const declared: DeclaredFunction[] = [];
	for (const match of text.matchAll(FUNCTION_RE)) {
		const start = match.index ?? 0;
		if (inLiteral(start) || EXPRESSION_BEFORE_RE.test(text.slice(Math.max(0, start - 40), start))) continue;
		const paramsClose = scan.close.get(start + match[0].length - 1);
		const open = paramsClose === undefined ? null : bodyOpen(scan, paramsClose);
		const end = open === null ? undefined : scan.close.get(open);
		if (end !== undefined) declared.push({ name: match[2] ?? "", start, end, exported: match[1] !== undefined });
	}
	const functions = declared.filter(
		(inner) => !declared.some((outer) => outer !== inner && outer.start < inner.start && inner.end <= outer.end),
	);
	const owner = (at: number) => functions.find((fn) => fn.start <= at && at <= fn.end);
	const live = new Set<DeclaredFunction>();
	const namedBy = new Map<DeclaredFunction, DeclaredFunction[]>();
	for (const fn of functions) {
		// A property access (`report.checkX`) is not a reference; a spread (`...checkX(`) is.
		const reference = new RegExp(`(?<![\\w$])(?<!(?:^|[^.])\\.)${escapeRegExp(fn.name)}(?![\\w$])`, "g");
		if (fn.exported && new RegExp(reference.source).test(importers)) live.add(fn);
		for (const match of text.matchAll(reference)) {
			const at = match.index ?? 0;
			if (inLiteral(at)) continue;
			const from = owner(at);
			if (from === fn) continue;
			if (!from) live.add(fn);
			else namedBy.set(from, [...(namedBy.get(from) ?? []), fn]);
		}
	}
	const pending = [...live];
	for (let fn = pending.shift(); fn; fn = pending.shift()) {
		for (const named of namedBy.get(fn) ?? []) {
			if (live.has(named)) continue;
			live.add(named);
			pending.push(named);
		}
	}
	let result = text;
	for (const fn of functions) {
		if (live.has(fn)) continue;
		result = `${result.slice(0, fn.start)}${result.slice(fn.start, fn.end + 1).replace(/[^\n]/g, " ")}${result.slice(fn.end + 1)}`;
	}
	return result;
}
