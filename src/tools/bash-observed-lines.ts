/**
 * Line numbers a bash `grep -n` / `rg -n` printed, keyed by absolute path, in
 * the shape the grep tool reports as `observedLines`. Citation grounding reads
 * them so a line the model's own shell search printed is not flagged as
 * recalled (bt-29: `grep -nE … logs/build.log | head -50` printed line 41238,
 * and the answer citing it still drew a citation check).
 *
 * Fail-closed: anything this does not model credits nothing. The command must
 * be one grep/rg with `-n`, optionally piped into `head`/`tail`, with literal
 * file operands. One regular-file operand credits bare `N:`/`N-` lines to that
 * file; otherwise only `path:N:` lines whose path lies under an operand count.
 * `sed -n` and `nl` output carries no parseable path-line pairing (and `nl`
 * skips blank lines), so neither is credited.
 */

import { statSync } from "node:fs";
import path from "node:path";
import { type ShellToken, scanShellLike } from "../domains/safety/protected-artifacts.js";

const GREP_COMMANDS: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep", "rg"]);
const LINE_FILTERS: ReadonlySet<string> = new Set(["head", "tail"]);
/** Short options whose value follows, per tool. rg's `-E` is `--encoding` and its `-r` is `--replace`. */
const SHORT_WITH_VALUE: Readonly<Record<"grep" | "rg", string>> = { grep: "efmABCdD", rg: "efgtTmABCMjErd" };
const LONG_WITH_VALUE: ReadonlySet<string> = new Set([
	"regexp",
	"file",
	"max-count",
	"after-context",
	"before-context",
	"context",
	"directories",
	"devices",
	"include",
	"exclude",
	"exclude-from",
	"exclude-dir",
	"label",
	"binary-files",
	"group-separator",
	"glob",
	"iglob",
	"type",
	"type-not",
	"type-add",
	"type-clear",
	"max-columns",
	"threads",
	"encoding",
	"replace",
	"max-depth",
	"max-filesize",
	"sort",
	"sortr",
	"color",
	"colors",
	"context-separator",
	"field-match-separator",
	"field-context-separator",
	"path-separator",
	"pre",
	"pre-glob",
	"engine",
	"ignore-file",
]);
/** Output modes whose lines are not `N:` match lines, or whose path cannot be paired with them. */
const NO_LINE_OUTPUT =
	/^(?:--(?:count|files-with-matches|files-without-match|quiet|silent|no-filename|null|heading|json)|-[^-]*[clLqhIZ0])$/u;

/** A literal operand: no expansion, glob, brace or home reference the shell would rewrite. */
function literalOperand(token: ShellToken): boolean {
	return (
		token.substitutions === undefined &&
		token.homeRelative !== true &&
		token.hiddenContent !== true &&
		token.ansiCQuoted !== true &&
		token.unterminated !== true &&
		!/[$`*?[{]/u.test(token.value)
	);
}

/** The pipeline's stages, dropping `2>/dev/null` and `2>&1`; null when any other operator appears. */
function pipelineStages(command: string): ShellToken[][] | null {
	if (/[\r\n]/u.test(command)) return null;
	const tokens = scanShellLike(command);
	const stages: ShellToken[][] = [[]];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as ShellToken;
		const next = tokens[index + 1];
		const target = tokens[index + 2];
		if (!token.operator && token.value === "2" && next?.operator === true && next.start === token.end) {
			const discard =
				(next.value === ">" && target?.value === "/dev/null") || (next.value === ">&" && target?.value === "1");
			if (!discard || target?.operator === true) return null;
			index += 2;
			continue;
		}
		if (token.operator) {
			if (token.value !== "|") return null;
			stages.push([]);
			continue;
		}
		stages[stages.length - 1]?.push(token);
	}
	return stages.every((stage) => stage.length > 0) ? stages : null;
}

interface GrepInvocation {
	operands: string[];
	withFilename: boolean;
}

function grepInvocation(stage: ReadonlyArray<ShellToken>): GrepInvocation | null {
	const name = path.basename(stage[0]?.value ?? "");
	if (!GREP_COMMANDS.has(name) || stage[0]?.quoted === true) return null;
	const tool = name === "rg" ? "rg" : "grep";
	let numbered = false;
	let withFilename = false;
	let patternGiven = false;
	const words: ShellToken[] = [];
	let optionsDone = false;
	for (let index = 1; index < stage.length; index++) {
		const token = stage[index] as ShellToken;
		const value = token.value;
		if (optionsDone || !value.startsWith("-") || value === "-") {
			words.push(token);
			continue;
		}
		if (value === "--") {
			optionsDone = true;
			continue;
		}
		if (/[$`]/u.test(value) || token.substitutions !== undefined) return null;
		if (NO_LINE_OUTPUT.test(value)) return null;
		if (value.startsWith("--")) {
			const [long = "", inline] = value.slice(2).split("=", 2);
			if (long === "line-number") numbered = true;
			else if (long === "no-line-number") numbered = false;
			else if (long === "with-filename") withFilename = true;
			else if (long === "regexp" || long === "file") patternGiven = true;
			if (inline === undefined && LONG_WITH_VALUE.has(long)) index++;
			continue;
		}
		const cluster = value.slice(1);
		for (let at = 0; at < cluster.length; at++) {
			const flag = cluster[at] as string;
			if (flag === "n") numbered = true;
			else if (flag === "N") numbered = false;
			else if (flag === "H") withFilename = true;
			if (SHORT_WITH_VALUE[tool].includes(flag)) {
				if (flag === "e" || flag === "f") patternGiven = true;
				if (at === cluster.length - 1) index++;
				break;
			}
		}
	}
	if (!numbered) return null;
	const operandTokens = patternGiven ? words : words.slice(1);
	if (!patternGiven && words.length === 0) return null;
	if (!operandTokens.every(literalOperand)) return null;
	const operands = operandTokens.map((token) => token.value);
	if (operands.includes("-")) return null;
	// rg searches the working directory when no path is named; grep reads stdin, which names no file.
	if (operands.length === 0) return tool === "rg" ? { operands: ["."], withFilename } : null;
	return { operands, withFilename };
}

function lineFilter(stage: ReadonlyArray<ShellToken>): boolean {
	const [command, ...args] = stage;
	if (command === undefined || command.quoted || !LINE_FILTERS.has(command.value)) return false;
	return args.every((token) => /^(?:-[nc]?\+?\d+|-[nc]|\+?\d+|-q)$/u.test(token.value));
}

function isRegularFile(file: string): boolean {
	try {
		return statSync(file).isFile();
	} catch {
		// An operand that cannot be stat'ed names no file this can credit.
		return false;
	}
}

function within(file: string, root: string): boolean {
	return file === root || file.startsWith(`${root}${path.sep}`);
}

/** Lines a bash grep/rg printed with their number, or undefined when the command or output is not that shape. */
export function bashObservedLines(command: string, output: string, cwd: string): Record<string, number[]> | undefined {
	const stages = pipelineStages(command);
	if (stages === null) return undefined;
	const [first, ...filters] = stages;
	if (first === undefined || !filters.every(lineFilter)) return undefined;
	const invocation = grepInvocation(first);
	if (invocation === null) return undefined;
	const roots = invocation.operands.map((operand) => path.resolve(cwd, operand));
	const only = roots.length === 1 ? (roots[0] as string) : null;
	const single = only !== null && !invocation.withFilename && isRegularFile(only) ? only : null;
	const observed = new Map<string, Set<number>>();
	const add = (file: string, raw: string): void => {
		const line = Number.parseInt(raw, 10);
		if (!Number.isSafeInteger(line) || line <= 0) return;
		const bucket = observed.get(file) ?? new Set<number>();
		bucket.add(line);
		observed.set(file, bucket);
	};
	for (const text of output.split(/\r?\n/u)) {
		if (single !== null) {
			const bare = /^(\d+)[:-]/u.exec(text);
			if (bare !== null) {
				add(single, bare[1] as string);
				continue;
			}
		}
		const prefixed = /^(.+?):(\d+):/u.exec(text);
		if (prefixed === null) continue;
		const file = path.resolve(cwd, prefixed[1] as string);
		if (single !== null ? file === single : roots.some((root) => within(file, root))) add(file, prefixed[2] as string);
	}
	if (observed.size === 0) return undefined;
	return Object.fromEntries([...observed].map(([file, lines]) => [file, [...lines].sort((a, b) => a - b)]));
}
