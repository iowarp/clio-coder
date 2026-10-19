import { homedir } from "node:os";
import path from "node:path";
import { canonicalizeRawPath } from "../../core/path-canonical.js";
import { SHELL_MOVES } from "./command-readings.js";
import { type ShellToken, scanShellLike, scanShellLikeDeep, shellCommandSteps } from "./protected-artifacts.js";

/**
 * What the floor's script scan knows about the shell that runs a scanned
 * script (#419, #407), carried from line to line so a delete is judged where
 * it lands. Like the delete judge's own walk, a cd adds where it lands and never
 * removes a directory: it may fail, run in a branch or a subshell, or sit in
 * a body that runs later.
 */
export interface ScriptShell {
	/** Directories the script may be in, or null once a move cannot be placed. */
	cwds: string[] | null;
	/** Variables holding one literal value from an unconditional assignment. */
	vars: Map<string, string>;
	exported: Set<string>;
	/** Variables set where the scan cannot follow; they are never known again. */
	poisoned: Set<string>;
}

/** Where a line runs: at the top, in a branch, in a loop body, or in a function body that runs later. */
export type ScriptContext = "plain" | "branch" | "loop" | "function";

const CONTEXT_RANK: Record<ScriptContext, number> = { plain: 0, branch: 1, loop: 2, function: 3 };

function deeperContext(left: ScriptContext, right: ScriptContext): ScriptContext {
	return CONTEXT_RANK[left] >= CONTEXT_RANK[right] ? left : right;
}

/** More directories than this and the script's place is treated as unknown. */
const MAX_SCRIPT_CWDS = 32;

/** Variables that change how the shell expands `~`, resolves a cd or splits words. */
const SHELL_LAYOUT_VARIABLES: ReadonlySet<string> = new Set(["HOME", "CDPATH", "IFS"]);

export function newScriptShell(cwds: string[] | null): ScriptShell {
	return {
		cwds: cwds === null ? null : [...cwds],
		vars: new Map([["HOME", homedir()]]),
		exported: new Set(["HOME"]),
		poisoned: new Set(),
	};
}

/**
 * The shell a script run through `bash`, `sh` or `exec` starts with: the same
 * directories, unknown ones when the call sits in a function body, and only
 * the exported variables. Nothing it does comes back.
 */
export function childScriptShell(shell: ScriptShell, context: ScriptContext): ScriptShell {
	return {
		cwds: context === "function" || shell.cwds === null ? null : [...shell.cwds],
		vars: new Map([...shell.vars].filter(([name]) => shell.exported.has(name))),
		exported: new Set(shell.exported),
		poisoned: new Set(shell.poisoned),
	};
}

/** Compound commands open around a line of one file. */
type Frame = "branch" | "loop" | "function" | "case-head" | "case-pattern" | "case-body";

/** How one file is being read: its open compound commands, pending here-document ends, and where it was sourced. */
export interface ScriptReader {
	frames: Frame[];
	heredocs: string[];
	base: ScriptContext;
	/** `$0` and `${BASH_SOURCE[0]}` as the shell holds them for this file, or null when unknown. */
	names: ScriptNames;
}

/** The words `$0` and `${BASH_SOURCE[0]}` expand to while a file runs. */
export interface ScriptNames {
	zero: string | null;
	source: string | null;
}

const UNKNOWN_NAMES: ScriptNames = { zero: null, source: null };

export function newScriptReader(base: ScriptContext, names: ScriptNames = UNKNOWN_NAMES): ScriptReader {
	return { frames: [], heredocs: [], base, names };
}

export interface ScriptLine {
	/** Here-document body or comment: data the shell does not run as commands here. */
	data: boolean;
	context: ScriptContext;
	/** The line with every variable known at this point replaced by its value. */
	expanded: string;
	/** Directories to judge the line from; null when they cannot be placed. */
	bases: string[] | null;
}

/** Reads one logical line against the shell state before it runs. */
export function readScriptLine(reader: ScriptReader, shell: ScriptShell, line: string): ScriptLine {
	const pending = reader.heredocs[0];
	if (pending !== undefined) {
		if (line.trim() === pending) reader.heredocs.shift();
		return { data: true, context: reader.base, expanded: line, bases: shell.cwds };
	}
	if (line.trim().startsWith("#") || line.trim() === "")
		return { data: true, context: reader.base, expanded: line, bases: shell.cwds };
	const context = deeperContext(reader.base, lineContext(reader, scanShellLike(line)));
	// A loop body repeats and a function body runs at its call, so values and
	// directories known here may not be the ones it sees; only HOME holds.
	const deferred = context === "loop" || context === "function";
	const vars = deferred ? new Map([["HOME", shell.vars.get("HOME") ?? homedir()]]) : shell.vars;
	return {
		data: false,
		context,
		expanded: expandKnownVariables(line, vars, reader.names),
		bases: context === "function" ? null : shell.cwds,
	};
}

/**
 * Applies a line's moves, assignments and compound words to the shell state.
 * Returns why the script cannot be followed past it, or null.
 */
export function advanceScriptShell(
	reader: ScriptReader,
	shell: ScriptShell,
	line: string,
	read: ScriptLine,
): string | null {
	if (read.data) return null;
	const tokens = scanShellLike(line);
	reader.heredocs.push(...hereDocumentEnds(tokens));
	const problem = trackFrames(reader, tokens);
	if (problem !== null) return problem;
	const steps = shellCommandSteps(read.expanded, homedir());
	if (steps.some((step) => step.executable === "eval")) return "it runs eval, whose words the scan cannot place";
	if (
		steps.some(
			(step) => /^(?:declare|typeset|local)$/u.test(step.executable) && step.args.some((arg) => /^-\w*n/u.test(arg)),
		)
	)
		return "it declares a name reference";
	const assigned = assignmentOnly(scanShellLike(read.expanded));
	const plain = read.context === "plain" && assigned !== null;
	const prefixed = commandPrefixAssignments(tokens);
	for (const name of setNames(line, steps)) {
		if (plain && assigned.has(name)) continue;
		if (SHELL_LAYOUT_VARIABLES.has(name)) {
			// `IFS= read -r line` sets IFS for that command alone.
			if (prefixed.has(name)) continue;
			return `it sets ${name}`;
		}
		shell.poisoned.add(name);
		shell.vars.delete(name);
	}
	if (plain) {
		for (const [name, value] of assigned) {
			if (SHELL_LAYOUT_VARIABLES.has(name)) return `it sets ${name}`;
			const literal = literalValue(value, shell);
			if (literal === null || shell.poisoned.has(name)) shell.vars.delete(name);
			else shell.vars.set(name, literal);
		}
	}
	for (const step of steps) {
		if (step.executable !== "export" && step.executable !== "readonly") continue;
		for (const arg of step.args) {
			const name = /^([A-Za-z_]\w*)(?:=|$)/u.exec(arg)?.[1];
			if (name !== undefined && step.executable === "export") shell.exported.add(name);
		}
	}
	return moveShell(shell, read, steps, scanShellLikeDeep(read.expanded));
}

/**
 * The end words of the here-documents a line opens. A `<<` inside `(( ))`,
 * `for (( ))` or `$[ ]` is a shift, not a here-document (#419): reading it as
 * one turned every later line into data that met only the block rules. Quoted
 * text and `$(( ))` reach here as single words already.
 */
function hereDocumentEnds(tokens: ReadonlyArray<ShellToken>): string[] {
	const ends: string[] = [];
	// Open parentheses of an arithmetic command, counting its own `((`.
	let arithmetic = 0;
	let bracket = false;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] as ShellToken;
		const next = tokens[index + 1];
		if (!token.operator) {
			if (bracket) bracket = !token.value.includes("]");
			else if (!token.quoted && /\$\[[^\]]*$/u.test(token.value)) bracket = true;
			continue;
		}
		if (arithmetic > 0) {
			if (token.value === "(") arithmetic += 1;
			else if (token.value === ")") arithmetic -= 1;
			continue;
		}
		if (bracket) continue;
		// `((` with nothing between is arithmetic; `( (` is two subshells.
		if (token.value === "(" && next?.operator === true && next.value === "(" && next.start === token.end) {
			arithmetic = 2;
			index += 1;
			continue;
		}
		if (token.value === "<<" && next !== undefined && !next.operator) ends.push(next.value.replace(/^-/u, ""));
	}
	return ends;
}

/**
 * The directories a command's own cds can leave its shell in, starting from
 * `cwd`; null when a move cannot be placed. Like the script walk, a cd adds
 * where it lands and keeps where the shell was.
 */
export function commandMoveBases(command: string, cwd: string): string[] | null {
	const shell = newScriptShell([cwd]);
	const context = lineContext(newScriptReader("plain"), scanShellLike(command));
	const read: ScriptLine = { data: false, context, expanded: command, bases: [cwd] };
	const problem = moveShell(shell, read, shellCommandSteps(command, homedir()), scanShellLikeDeep(command));
	return problem === null ? shell.cwds : null;
}

function moveShell(
	shell: ScriptShell,
	read: ScriptLine,
	steps: ReturnType<typeof shellCommandSteps>,
	tokens: ReadonlyArray<ShellToken>,
): string | null {
	const moves = steps.filter((step) => SHELL_MOVES.has(step.executable));
	// A move word the parser did not read as a command (`eval cd ..`) cannot be placed.
	const words = tokens.filter((token) => !token.operator && SHELL_MOVES.has(token.value)).length;
	if (words > moves.length) {
		shell.cwds = null;
		return null;
	}
	for (const step of moves) {
		// A loop repeats its moves and a function body moves the shell wherever it is called.
		if (read.context === "loop") return "it changes directory inside a loop";
		if (read.context === "function") {
			shell.cwds = null;
			continue;
		}
		const target = moveTarget(step.executable, step.args, shell);
		if (target === undefined) continue;
		if (target === null || shell.cwds === null) {
			shell.cwds = null;
			continue;
		}
		const relative = !target.startsWith("/");
		if (relative && (process.env.CDPATH ?? "") !== "") {
			shell.cwds = null;
			continue;
		}
		const landed = new Set(shell.cwds);
		for (const base of relative ? shell.cwds : ["/"]) {
			const landing = canonicalizeRawPath(target, base);
			if (landing === null) {
				shell.cwds = null;
				break;
			}
			landed.add(landing);
		}
		if (shell.cwds === null) continue;
		shell.cwds = landed.size > MAX_SCRIPT_CWDS ? null : [...landed];
	}
	return null;
}

/**
 * Where a `cd` or `pushd` goes: a literal path, null when it cannot be named,
 * undefined when it returns to a directory already listed (`popd`, a bare
 * `pushd`, a stack rotation).
 */
function moveTarget(executable: string, args: ReadonlyArray<string>, shell: ScriptShell): string | null | undefined {
	if (executable === "popd") return undefined;
	let index = 0;
	while (index < args.length && /^-[LPe@]+$/u.test(args[index] ?? "")) index += 1;
	if (args[index] === "--") index += 1;
	const target = args[index];
	if (target === undefined) return executable === "cd" ? (shell.vars.get("HOME") ?? null) : undefined;
	// `cd -` goes to OLDPWD, which before the script's first cd is the caller's.
	if (target === "-") return null;
	if (executable === "pushd" && /^[+-]\d+$/u.test(target)) return undefined;
	if (/[$`*?[{]/u.test(target)) return null;
	return target;
}

/** `NAME=value` words of a line that only assigns, optionally exporting, split on `;`; null otherwise. */
function assignmentOnly(tokens: ReadonlyArray<ShellToken>): Map<string, string> | null {
	const assigned = new Map<string, string>();
	let segmentStart = true;
	for (const token of tokens) {
		if (token.operator) {
			if (token.value !== ";") return null;
			segmentStart = true;
			continue;
		}
		if (token.substitutions !== undefined) return null;
		if (segmentStart && !token.quoted && (token.value === "export" || token.value === "readonly")) {
			segmentStart = false;
			continue;
		}
		segmentStart = false;
		const found = /^([A-Za-z_]\w*)=(.*)$/su.exec(token.value);
		if (found === null) {
			// `export NAME` marks a variable without assigning it.
			if (/^[A-Za-z_]\w*$/u.test(token.value)) continue;
			return null;
		}
		assigned.set(found[1] as string, found[2] as string);
	}
	return assigned.size > 0 ? assigned : null;
}

/** A value with nothing left for the shell to expand, `~` read as HOME; null otherwise. */
function literalValue(value: string, shell: ScriptShell): string | null {
	const home = shell.vars.get("HOME");
	const expanded =
		value === "~" || value.startsWith("~/") ? (home === undefined ? null : `${home}${value.slice(1)}`) : value;
	if (expanded === null || expanded.startsWith("~")) return null;
	return /^[\w./+:@%,=-]*$/u.test(expanded) ? expanded : null;
}

/**
 * Every name a line can set: `NAME=` words anywhere (prefix assignments,
 * `export`, `let`), bare names passed to a command (`read`, `for`, `unset`,
 * `printf -v`, `local`), `${NAME:=x}` defaults and arithmetic assignments.
 */
function setNames(line: string, steps: ReturnType<typeof shellCommandSteps>): Set<string> {
	const names = new Set<string>();
	for (const token of scanShellLikeDeep(line)) {
		if (token.operator) continue;
		const assigned = /^([A-Za-z_]\w*)(?:\[[^\]]*\])?\+?=/u.exec(token.value)?.[1];
		if (assigned !== undefined) names.add(assigned);
	}
	for (const step of steps) {
		if (step.executable === "export" || step.executable === "readonly") continue;
		for (const arg of step.args) if (/^[A-Za-z_]\w*$/u.test(arg)) names.add(arg);
	}
	for (const found of line.matchAll(/\$\{([A-Za-z_]\w*):?=/gu)) names.add(found[1] as string);
	if (line.includes("((")) {
		for (const found of line.matchAll(/([A-Za-z_]\w*)\s*(?:\+\+|--|[-+*/%&|^]?=(?!=))/gu)) names.add(found[1] as string);
	}
	return names;
}

/** Special builtins keep a prefix assignment in the shell after they run. */
const SPECIAL_BUILTINS: ReadonlySet<string> = new Set([
	":",
	".",
	"source",
	"eval",
	"exec",
	"export",
	"readonly",
	"set",
	"shift",
	"trap",
	"unset",
	"return",
	"break",
	"continue",
	"exit",
	"times",
]);

/**
 * Names whose every assignment on the line is a prefix of an ordinary command,
 * which sets them for that command alone.
 */
function commandPrefixAssignments(tokens: ReadonlyArray<ShellToken>): Set<string> {
	const prefixed = new Set<string>();
	const elsewhere = new Set<string>();
	let pending: string[] = [];
	const settle = (command: string | null) => {
		const target = command !== null && !SPECIAL_BUILTINS.has(command) ? prefixed : elsewhere;
		for (const name of pending) target.add(name);
		pending = [];
	};
	let commandPosition = true;
	for (const token of tokens) {
		if (token.operator) {
			if (SHELL_REDIRECTS.has(token.value)) continue;
			settle(null);
			commandPosition = true;
			continue;
		}
		const name = /^([A-Za-z_]\w*)\+?=/u.exec(token.value)?.[1];
		if (commandPosition && name !== undefined && !token.quoted) {
			pending.push(name);
			continue;
		}
		// `while IFS= read` keeps the command word after the keyword.
		if (commandPosition && !token.quoted && (MID_WORDS.has(token.value) || /^(?:if|while|until|\{)$/u.test(token.value)))
			continue;
		if (commandPosition) settle(token.value);
		else if (name !== undefined) elsewhere.add(name);
		commandPosition = false;
	}
	settle(null);
	return new Set([...prefixed].filter((name) => !elsewhere.has(name)));
}

/**
 * `$(dirname "$0")`, `$(dirname "${BASH_SOURCE[0]}")`, `${0%/*}` and the
 * `BASH_SOURCE` form of the last, quoted or not: the script's own directory
 * as the shell computes it from the name it was run by, so a relative name
 * still resolves from wherever the script is when the line runs.
 */
const SCRIPT_DIRECTORY_IDIOM =
	/^\$(?:\(\s*dirname\s+(?:--\s+)?("?)\$(?:\{(0|BASH_SOURCE(?:\[0\])?)\}|(0|BASH_SOURCE))\1\s*\)|\{(0|BASH_SOURCE(?:\[0\])?)%\/\*\})/u;

function scriptDirectory(idiom: RegExpExecArray, names: ScriptNames): string | null {
	const variable = idiom[2] ?? idiom[3] ?? idiom[4] ?? "";
	const name = variable === "0" ? names.zero : names.source;
	if (name === null || !/^[\w./+:@%,=-]+$/u.test(name)) return null;
	if (idiom[4] !== undefined) return name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : name;
	return path.posix.dirname(name);
}

/**
 * `$NAME` and `${NAME}` outside single quotes replaced by known values, and
 * the script-directory idioms by the directory. Other expansions stay as
 * written, so a path built from them is still unplaced.
 */
function expandKnownVariables(line: string, vars: ReadonlyMap<string, string>, names: ScriptNames): string {
	let out = "";
	let single = false;
	let double = false;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index] ?? "";
		if (single) {
			out += char;
			if (char === "'") single = false;
			continue;
		}
		if (char === "\\") {
			out += line.slice(index, index + 2);
			index += 1;
			continue;
		}
		if (char === "'" && !double) single = true;
		else if (char === '"') double = !double;
		else if (char === "$") {
			const idiom = SCRIPT_DIRECTORY_IDIOM.exec(line.slice(index));
			const directory = idiom === null ? null : scriptDirectory(idiom, names);
			if (idiom !== null && directory !== null) {
				out += directory;
				index += idiom[0].length - 1;
				continue;
			}
			const found = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/u.exec(line.slice(index));
			const value = found === null ? undefined : vars.get((found[1] ?? found[2]) as string);
			if (found !== null && value !== undefined) {
				out += value;
				index += found[0].length - 1;
				continue;
			}
		}
		out += char;
	}
	return out;
}

const LOOP_OPENERS: ReadonlySet<string> = new Set(["for", "while", "until", "select"]);
const MID_WORDS: ReadonlySet<string> = new Set(["then", "do", "else", "elif", "!", "time"]);

/** The deepest context a line runs in or opens, without moving the frames. */
function lineContext(reader: ScriptReader, tokens: ReadonlyArray<ShellToken>): ScriptContext {
	const probe: ScriptReader = { frames: [...reader.frames], heredocs: [], base: reader.base, names: reader.names };
	let context = framesContext(probe.frames);
	trackFrames(probe, tokens, (frames) => {
		context = deeperContext(context, framesContext(frames));
	});
	// A conditional or background operator makes the line's effects uncertain.
	if (tokens.some((token) => token.operator && ["&&", "||", "|", "&", "|&"].includes(token.value)))
		context = deeperContext(context, "branch");
	return context;
}

function framesContext(frames: ReadonlyArray<Frame>): ScriptContext {
	let context: ScriptContext = "plain";
	for (const frame of frames) {
		context = deeperContext(context, frame === "loop" || frame === "function" ? frame : "branch");
	}
	return context;
}

const SHELL_REDIRECTS: ReadonlySet<string> = new Set([
	">",
	">>",
	"<",
	"<<",
	"<<<",
	"<&",
	">&",
	"<>",
	">|",
	"&>",
	"&>>",
]);

/**
 * Moves the frames over one line's top-level words: `if`, loops, `case`,
 * `{ }`, `( )` and function bodies, read only where a keyword can stand.
 */
function trackFrames(
	reader: ScriptReader,
	tokens: ReadonlyArray<ShellToken>,
	onOpen?: (frames: ReadonlyArray<Frame>) => void,
): string | null {
	const frames = reader.frames;
	let commandPosition = true;
	let functionNext = false;
	let functionName = false;
	const open = (frame: Frame) => {
		frames.push(frame);
		onOpen?.(frames);
	};
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] as ShellToken;
		const top = frames.at(-1);
		if (top === "case-head") {
			if (!token.operator && token.value === "in") frames[frames.length - 1] = "case-pattern";
			continue;
		}
		if (top === "case-pattern") {
			if (!token.operator && token.value === "esac") {
				frames.pop();
				commandPosition = false;
			} else if (token.operator && token.value === ")") {
				frames[frames.length - 1] = "case-body";
				commandPosition = true;
			}
			continue;
		}
		if (token.operator) {
			if (SHELL_REDIRECTS.has(token.value)) {
				index += 1;
				continue;
			}
			if (token.value === ";" && tokens[index + 1]?.operator === true && tokens[index + 1]?.value === ";") {
				index += 1;
				if (frames.at(-1) === "case-body") frames[frames.length - 1] = "case-pattern";
				commandPosition = true;
				continue;
			}
			if (token.value === "(") {
				if (tokens[index + 1]?.operator === true && tokens[index + 1]?.value === ")") {
					// `name ()` defines a function; its body follows.
					index += 1;
					functionNext = true;
					commandPosition = true;
					continue;
				}
				open(functionNext ? "function" : "branch");
				functionNext = false;
				commandPosition = true;
				continue;
			}
			if (token.value === ")") {
				if (frames.length > 0) frames.pop();
				commandPosition = true;
				continue;
			}
			commandPosition = true;
			continue;
		}
		if (functionName) {
			functionName = false;
			functionNext = true;
			commandPosition = true;
			continue;
		}
		if (!commandPosition || token.quoted) {
			commandPosition = false;
			continue;
		}
		const word = token.value;
		if (word === "function") {
			functionName = true;
			continue;
		}
		if (word === "{") {
			open(functionNext ? "function" : "branch");
			functionNext = false;
			continue;
		}
		functionNext = false;
		if (word === "if") open("branch");
		else if (LOOP_OPENERS.has(word)) {
			open("loop");
			commandPosition = word === "while" || word === "until";
		} else if (word === "case") {
			open("case-head");
			commandPosition = false;
		} else if (word === "fi" || word === "done" || word === "}" || word === "esac") {
			if (frames.length > 0) frames.pop();
			commandPosition = false;
		} else if (MID_WORDS.has(word)) {
			// `then`, `do` and `else` open no frame; their branch already did.
		} else if (/^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/u.test(word)) {
			// A prefix assignment leaves the command word still to come.
		} else commandPosition = false;
	}
	if (frames.length > 64) return "it nests compound commands deeper than the scan follows";
	return null;
}
