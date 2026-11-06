/**
 * Which package scripts CI runs, followed through the programs it starts.
 *
 * A script counts as reached only when an invocation names it: a shell
 * command (`pnpm run lint`), or a process-start call in a program CI runs
 * whose argument vector names a package manager, `run`, and the script
 * (`spawn("pnpm", ["run", "lint"])`). A script name held in a variable
 * counts only when a binding that encloses the call gives that variable
 * literal values (`["typecheck", "lint"].map((step) => spawn("pnpm", ["run", step]))`).
 * Programs a reached program starts by path (`run(process.execPath,
 * ["scripts/check-release.mjs"])`) are read in turn. An invocation whose
 * target the scan cannot read is returned as unresolved: CI may run more than
 * the reached list shows, and a reader should not take absence as proof.
 *
 * The same scan says which code on that path runs: the programs it read, the
 * files they import, and within a program the functions something live names.
 */
import { readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

export interface CiReach {
	/** Package scripts a CI command reaches, in package.json order. */
	reached: string[];
	/** Invocations on CI's path whose script or program the scan could not resolve, as `source: invocation`. */
	unresolved: string[];
	/** Repository programs the commands start, in the order the scan reached them. */
	programs: string[];
}

const MAX_PROGRAM_BYTES = 512 * 1024;
const MAX_UNRESOLVED = 16;
const MAX_UNRESOLVED_CHARS = 200;
const PACKAGE_MANAGER_RE = /^(?:pnpm|npm|yarn|bun)(?:\.cmd|\.exe)?$/;
const RUNNER_RE = /^(?:node|nodejs|tsx|ts-node|bash|sh|zsh|python3?|bun|deno)(?:\.cmd|\.exe)?$/;
/** Calls that start a process from a command string or a program path, not from an argv array. */
const PROCESS_CALL_RE =
	/^(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork|execa|execaSync|execaCommand|execaCommandSync|run|runSync|sh|shell|system|call|check_call|check_output|Popen)$/;
const SHELL_PROGRAM_RE = /\.(?:sh|bash|zsh)$/;
/** A package manager told to run a script named by a shell or CI variable: `pnpm run "$TASK"`, `npm run ${{ matrix.task }}`. */
const SHELL_VARIABLE_RUN_RE = /\b(?:pnpm|npm|yarn|bun)\b[^;&|\n]*?(?<![-\w])run(?:-script)?\s+["']?\$/;
/** A program that starts itself again (a worker re-entry) adds no edge. */
const SELF_RE = /^(?:import\.meta\.filename|__filename|import\.meta\.url|fileURLToPath\(\s*import\.meta\.url\s*\))$/;
/** Arguments that pass the runtime's own flags through: `...process.execArgv`. */
const RUNTIME_FLAGS_RE = /^\.\.\.process\.execArgv$/;
const NOT_A_CALL = new Set(["if", "while", "switch", "catch", "return", "typeof", "await", "function"]);

function readProgram(root: string, path: string): string | null {
	try {
		const full = join(root, path);
		if (statSync(full).size > MAX_PROGRAM_BYTES) return null;
		const text = readFileSync(full, "utf8");
		return text.includes("\u0000") ? null : text;
	} catch {
		return null;
	}
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function oneLine(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > MAX_UNRESOLVED_CHARS ? `${line.slice(0, MAX_UNRESOLVED_CHARS - 1)}…` : line;
}

function normalizePath(word: string): string {
	return word.replace(/^["']|["']$/g, "").replace(/^\.\//, "");
}

/** Repository files a shell command names by path: `node scripts/release-candidate.mjs test`. */
function shellFiles(command: string, visible: ReadonlySet<string>): string[] {
	return command
		.split(/\s+/)
		.map(normalizePath)
		.filter((word) => visible.has(word));
}

interface Scan {
	text: string;
	/** Opening bracket index to its closing index, for `(`, `[` and `{` outside literals and comments. */
	close: Map<number, number>;
	/** Start to end (exclusive) of each string, template, regex literal and comment. */
	skip: Map<number, number>;
	calls: Array<{ callee: string; open: number; close: number }>;
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

/** Brackets, literals and call sites of a JavaScript, TypeScript or Python program, in one pass. */
function scanProgram(text: string, hashComments: boolean): Scan {
	const close = new Map<number, number>();
	const skip = new Map<number, number>();
	const stack: number[] = [];
	const lineEnd = (from: number): number => (text.indexOf("\n", from) < 0 ? text.length : text.indexOf("\n", from));
	let previous = "";
	let index = text.startsWith("#!") ? lineEnd(0) : 0;
	while (index < text.length) {
		const char = text[index] ?? "";
		const next = text[index + 1];
		const comment = (char === "/" && (next === "/" || next === "*")) || (hashComments && char === "#");
		let end = -1;
		if (comment && char === "/" && next === "*") {
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
	const calls: Scan["calls"] = [];
	for (const [open, end] of close) {
		if (text[open] !== "(") continue;
		const head = /(?:^|[^\w$])(function\s+)?([A-Za-z_$][\w$]*)\s*$/.exec(text.slice(Math.max(0, open - 80), open));
		const callee = head?.[2];
		if (!callee || head[1] || NOT_A_CALL.has(callee)) continue;
		calls.push({ callee, open, close: end });
	}
	return { text, close, skip, calls: calls.sort((a, b) => a.open - b.open) };
}

type Arg =
	| { kind: "literal"; value: string; start: number; end: number }
	| { kind: "template"; raw: string; start: number; end: number }
	| { kind: "array"; items: Arg[]; start: number; end: number }
	| { kind: "expression"; raw: string; start: number; end: number };

function stringValue(raw: string): string {
	return raw.slice(1, -1).replace(/\\(.)/g, "$1");
}

/** The top-level, comma-separated items between an opening bracket and its close. */
function splitItems(scan: Scan, open: number, end: number): Arg[] {
	const items: Arg[] = [];
	let start = open + 1;
	let index = start;
	const push = (stop: number): void => {
		const raw = scan.text.slice(start, stop);
		const lead = raw.length - raw.trimStart().length;
		const trimmed = raw.trim();
		if (trimmed.length > 0) items.push(classify(scan, start + lead, start + lead + trimmed.length));
	};
	while (index < end) {
		const skipped = scan.skip.get(index) ?? scan.close.get(index);
		if (skipped !== undefined) {
			index = scan.skip.has(index) ? skipped : skipped + 1;
			continue;
		}
		if (scan.text[index] === ",") {
			push(index);
			start = index + 1;
		}
		index += 1;
	}
	push(end);
	return items;
}

function classify(scan: Scan, start: number, end: number): Arg {
	const raw = scan.text.slice(start, end);
	const first = raw[0];
	if ((first === '"' || first === "'") && scan.skip.get(start) === end) {
		return { kind: "literal", value: stringValue(raw), start, end };
	}
	if (first === "`" && scan.skip.get(start) === end) {
		return raw.includes("${")
			? { kind: "template", raw, start, end }
			: { kind: "literal", value: stringValue(raw), start, end };
	}
	if (first === "[" && scan.close.get(start) === end - 1) {
		return { kind: "array", items: splitItems(scan, start, end - 1), start, end };
	}
	if (raw === "process.execPath" || raw === "sys.executable") return { kind: "literal", value: "node", start, end };
	return { kind: "expression", raw, start, end };
}

function baseName(command: string): string {
	return command.split(/[\\/]/).at(-1) ?? command;
}

/** The literal strings an array literal holds, or null when any item is computed. */
function literalItems(items: ReadonlyArray<Arg>): string[] | null {
	const values: string[] = [];
	for (const item of items) {
		if (item.kind !== "literal") return null;
		values.push(item.value);
	}
	return values;
}

/** The array literal an identifier is declared as, before `at`. */
function declaredArray(scan: Scan, name: string, at: number): string[] | null {
	const declaration = new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(name)}\\s*(?::[^=]+)?=\\s*\\[`, "g");
	const match = [...scan.text.slice(0, at).matchAll(declaration)].at(-1);
	if (!match) return null;
	const open = (match.index ?? 0) + match[0].length - 1;
	const end = scan.close.get(open);
	return end === undefined ? null : literalItems(splitItems(scan, open, end));
}

/** The literal values a receiver expression stands for: an array literal, or a name declared as one. */
function receiverValues(scan: Scan, start: number, end: number): string[] | null {
	const slice = scan.text.slice(start, end);
	const raw = slice.trim();
	const open = start + slice.length - slice.trimStart().length;
	const close = open + raw.length - 1;
	if (raw.startsWith("[") && scan.close.get(open) === close) return literalItems(splitItems(scan, open, close));
	return /^[A-Za-z_$][\w$]*$/.test(raw) ? declaredArray(scan, raw, start) : null;
}

/** The end of the single statement or block that follows a loop header. */
function loopBodyEnd(scan: Scan, headerClose: number): number {
	let index = headerClose + 1;
	while (/\s/.test(scan.text[index] ?? "")) index += 1;
	if (scan.text[index] === "{") return scan.close.get(index) ?? scan.text.length;
	while (index < scan.text.length) {
		const char = scan.text[index];
		const skipped = scan.skip.get(index) ?? scan.close.get(index);
		if (skipped !== undefined) {
			index = scan.skip.has(index) ? skipped : skipped + 1;
			continue;
		}
		if (char === ";" || char === "\n") return index;
		index += 1;
	}
	return index;
}

/**
 * The literal values a variable takes at `at`, from the nearest binding that
 * encloses it: a callback parameter of `.map`/`.forEach`/`.flatMap` over a
 * literal array, a `for … of` loop variable over one, or a declaration that
 * assigns only string literals. Null when no such binding exists.
 */
function boundValues(scan: Scan, name: string, at: number): string[] | null {
	const quoted = escapeRegExp(name);
	const callback = new RegExp(
		`^\\s*(?:async\\s+)?(?:\\(\\s*${quoted}\\s*(?:[,:)])|${quoted}\\s*=>|function\\s*\\w*\\s*\\(\\s*${quoted}\\b)`,
	);
	const loop = new RegExp(`^\\s*(?:const|let|var)\\s+${quoted}\\s+of\\s+`);
	// Calls arrive in source order, so the last enclosing binding is the innermost.
	let best: { values: string[] | null } | null = null;
	for (const call of scan.calls) {
		if (call.open > at) break;
		const inner = scan.text.slice(call.open + 1, call.close);
		if (call.callee === "for") {
			const header = loop.exec(inner);
			if (!header || at > loopBodyEnd(scan, call.close)) continue;
			best = { values: receiverValues(scan, call.open + 1 + header[0].length, call.close) };
			continue;
		}
		if (!/^(?:map|forEach|flatMap)$/.test(call.callee) || at > call.close || !callback.test(inner)) continue;
		const dot = scan.text.lastIndexOf(".", call.open);
		let receiverEnd = dot;
		while (receiverEnd > 0 && /\s/.test(scan.text[receiverEnd - 1] ?? "")) receiverEnd -= 1;
		let receiverStart = receiverEnd;
		if (scan.text[receiverEnd - 1] === "]") {
			const open = [...scan.close].find(([, end]) => end === receiverEnd - 1)?.[0];
			receiverStart = open ?? receiverEnd;
		} else {
			while (receiverStart > 0 && /[\w$]/.test(scan.text[receiverStart - 1] ?? "")) receiverStart -= 1;
		}
		best = { values: receiverValues(scan, receiverStart, receiverEnd) };
	}
	if (best) return best.values;
	const declaration = new RegExp(`\\b(?:const|let|var)\\s+${quoted}\\s*=\\s*([^;\\n]+)`, "g");
	const value = [...scan.text.slice(0, at).matchAll(declaration)].at(-1)?.[1];
	if (value === undefined) return null;
	const literals = [...value.matchAll(/(["'])((?:(?!\1)[^\\\n])*)\1/g)].map((literal) => literal[2] ?? "");
	const rest = value.replace(/(["'])(?:(?!\1)[^\\\n])*\1/g, "").replace(/[\s?:()]/g, "");
	return literals.length > 0 && /^[\w.!&|=<>]*$/.test(rest) ? [...new Set(literals)] : null;
}

interface Edges {
	scripts: string[];
	programs: string[];
	shell: string[];
	unresolved: string[];
}

/** The scripts and programs a shell command names, and the script names it leaves to a variable. */
function shellEdges(command: string, scripts: ReadonlyArray<string>, visible: ReadonlySet<string>): Edges {
	return {
		scripts: scripts.filter((name) => new RegExp(`\\brun\\s+${escapeRegExp(name)}(?:\\s|$)`).test(command)),
		programs: shellFiles(command, visible),
		shell: [],
		unresolved: SHELL_VARIABLE_RUN_RE.test(command) ? [command] : [],
	};
}

/** The scripts, programs and shell commands a program's process-start calls name. */
function programEdges(text: string, path: string, scripts: ReadonlyArray<string>, visible: ReadonlySet<string>): Edges {
	const edges: Edges = { scripts: [], programs: [], shell: [], unresolved: [] };
	if (SHELL_PROGRAM_RE.test(path)) {
		const body = text
			.split("\n")
			.filter((line) => !/^\s*#/.test(line))
			.join("\n");
		return shellEdges(body, scripts, visible);
	}
	const scan = scanProgram(text, path.endsWith(".py"));
	const scriptValues = (arg: Arg | undefined, site: string): void => {
		if (arg?.kind === "literal") {
			if (scripts.includes(arg.value)) edges.scripts.push(arg.value);
			return;
		}
		const values =
			arg?.kind === "expression" && /^[A-Za-z_$][\w$]*$/.test(arg.raw) ? boundValues(scan, arg.raw, arg.start) : null;
		if (values) edges.scripts.push(...values.filter((value) => scripts.includes(value)));
		else edges.unresolved.push(site);
	};
	for (const call of scan.calls) {
		const site = text.slice(call.open - call.callee.length, call.close + 1);
		const args = splitItems(scan, call.open, call.close);
		const [first, second] = args;
		if (!first) continue;
		if ((first.kind === "literal" || first.kind === "template") && second?.kind !== "array") {
			if (!PROCESS_CALL_RE.test(call.callee)) continue;
			if (first.kind === "literal" && !/\s/.test(first.value)) {
				const program = normalizePath(first.value);
				if (visible.has(program)) edges.programs.push(program);
				continue;
			}
			if (first.kind === "literal") {
				edges.shell.push(first.value);
				continue;
			}
			// A template command: its literal parts run as written, an interpolated script name needs a binding.
			const command = first.raw.slice(1, -1);
			for (const match of command.matchAll(/\brun\s+\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g)) {
				const values = boundValues(scan, match[1] ?? "", first.start + 1 + (match.index ?? 0));
				if (values) edges.scripts.push(...values.filter((value) => scripts.includes(value)));
				else edges.unresolved.push(site);
			}
			edges.shell.push(command.replace(/\$\{[^}]*\}/g, " "));
			continue;
		}
		const argv = first.kind === "array" ? first.items : [first, ...(second?.kind === "array" ? second.items : [])];
		const [command, ...rest] = argv;
		if (command?.kind !== "literal") {
			// An unknown program given `run <name>` may be a package manager; say so rather than guess.
			if (rest.some((arg) => arg.kind === "literal" && arg.value === "run")) edges.unresolved.push(site);
			continue;
		}
		const name = baseName(command.value);
		if (PACKAGE_MANAGER_RE.test(name)) {
			const runAt = rest.findIndex((arg) => arg.kind === "literal" && (arg.value === "run" || arg.value === "run-script"));
			if (runAt >= 0) scriptValues(rest[runAt + 1], site);
			continue;
		}
		if (RUNNER_RE.test(name)) {
			const shellAt = rest.findIndex((arg) => arg.kind === "literal" && arg.value === "-c");
			const shellArg = shellAt >= 0 ? rest[shellAt + 1] : undefined;
			if (shellArg?.kind === "literal") {
				edges.shell.push(shellArg.value);
				continue;
			}
			const target = rest.find((arg) =>
				arg.kind === "literal"
					? !arg.value.startsWith("-")
					: !(arg.kind === "expression" && RUNTIME_FLAGS_RE.test(arg.raw.trim())),
			);
			if (target?.kind === "expression" && SELF_RE.test(target.raw.trim())) continue;
			const program = rest
				.flatMap((arg) => (arg.kind === "literal" ? [normalizePath(arg.value)] : []))
				.find((value) => visible.has(value));
			if (program) edges.programs.push(program);
			else if (target && target.kind !== "literal") edges.unresolved.push(site);
			continue;
		}
		if (PROCESS_CALL_RE.test(call.callee) && visible.has(normalizePath(command.value))) {
			edges.programs.push(normalizePath(command.value));
		}
	}
	return edges;
}

/**
 * The package scripts CI reaches. Commands, script bodies and programs form
 * one work list, each visited once, so a program a reached program starts is
 * read as well (`node scripts/ci.mjs` starting `node scripts/checks.mjs`,
 * which starts `pnpm run lint`). With `prePost`, a reached script also reaches
 * the `pre<name>` and `post<name>` scripts npm runs around it.
 */
export function ciReach(
	root: string,
	ciCommands: ReadonlyArray<string>,
	scripts: Readonly<Record<string, string>>,
	visible: ReadonlySet<string>,
	options: { prePost?: boolean } = {},
): CiReach {
	const names = Object.keys(scripts);
	const reached = new Set<string>();
	const unresolved: string[] = [];
	const readPrograms = new Set<string>();
	const seenCommands = new Set<string>();
	const pending: Array<{ command: string; source: string } | { program: string }> = ciCommands.map((command) => ({
		command,
		source: "CI",
	}));
	const note = (source: string, invocation: string): void => {
		const entry = `${source}: ${oneLine(invocation)}`;
		if (!unresolved.includes(entry) && unresolved.length < MAX_UNRESOLVED) unresolved.push(entry);
	};
	const reach = (name: string): void => {
		if (reached.has(name) || scripts[name] === undefined) return;
		reached.add(name);
		pending.push({ command: scripts[name] ?? "", source: `script ${name}` });
		if (options.prePost) {
			reach(`pre${name}`);
			reach(`post${name}`);
		}
	};
	const follow = (edges: Edges, source: string): void => {
		for (const name of edges.scripts) reach(name);
		for (const program of edges.programs) pending.push({ program });
		for (const command of edges.shell) pending.push({ command, source });
		for (const invocation of edges.unresolved) note(source, invocation);
	};
	while (pending.length > 0) {
		const item = pending.shift();
		if (!item) break;
		if ("program" in item) {
			if (readPrograms.has(item.program)) continue;
			readPrograms.add(item.program);
			const text = readProgram(root, item.program);
			if (text !== null) follow(programEdges(text, item.program, names, visible), item.program);
			continue;
		}
		if (seenCommands.has(item.command)) continue;
		seenCommands.add(item.command);
		follow(shellEdges(item.command, names, visible), item.source);
	}
	return { reached: names.filter((name) => reached.has(name)), unresolved, programs: [...readPrograms] };
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
	const inLiteral = literalAt(scanProgram(text, false));
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
	const scan = scanProgram(text, false);
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
