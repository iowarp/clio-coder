import { isGitExecutable } from "./git-command-normalization.js";
import type { ShellToken } from "./protected-artifacts.js";
import {
	extractCommandWriteTargets,
	scanShellLike,
	shellCommandWords,
	splitSegments,
	withoutHeredocBodies,
} from "./protected-artifacts.js";

const EXECUTORS = new Set(
	"sh bash zsh dash ksh mksh fish busybox env command builtin sudo doas su ssh xargs find timeout nohup nice exec watch script trap source . python python3 node perl ruby php psql mysql sqlite3 eval".split(
		" ",
	),
);

/**
 * Only proven inert spans can be exempted; executable quoted content still
 * needs conservative scans. A pipe is refused unless every command on the line
 * is a text command (Astra r2-8), so `rg "sudo rm" docs | head` reads as the
 * search it is and `echo "sudo rm x" | sh` keeps its rule.
 */
export function inertQuotedMatch(command: string, pattern: RegExp, ruleId = ""): boolean {
	if (ruleId.startsWith("sql-") || /\beval\b|<<|\$'|\$\(|`/iu.test(command)) return false;
	if (command.includes("|") && !onlyTextCommands(command, 0)) return false;
	const tokens = scanShellLike(command);
	if (tokens.some((token) => EXECUTORS.has(token.value))) return false;
	const ranges: Array<[number, number]> = [];
	let words: typeof tokens = [];
	const flush = (): void => {
		const program = words[0]?.value;
		for (let i = 1; i < words.length; i++) {
			const token = words[i];
			if (!token?.quoted) continue;
			const raw = command.slice(token.start, token.end);
			if (!((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) continue;
			const previous = words[i - 1]?.value;
			const allowed =
				program === "echo" ||
				program === "printf" ||
				// A path-spelled Git runs the same program, and F2 made the Git scans see it.
				(isGitExecutable(program ?? "") &&
					["commit", "tag"].includes(words[1]?.value ?? "") &&
					["-m", "--message"].includes(previous ?? "")) ||
				(["grep", "rg"].includes(program ?? "") && (i === 1 || previous === "-e" || previous === "--regexp"));
			if (allowed) ranges.push([token.start + 1, token.end - 1]);
		}
		words = [];
	};
	for (const token of tokens) {
		if (token.operator) flush();
		else words.push(token);
	}
	flush();
	const matcher = new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/gu, "")}g`);
	const matches = [...command.matchAll(matcher)];
	return (
		matches.length > 0 &&
		matches.every(
			(match) =>
				!/[|>;]/u.test(match[0]) &&
				ranges.some(([start, end]) => match.index >= start && match.index + match[0].length <= end),
		)
	);
}

/**
 * Programs that only read, print or store the words they are given: none has
 * an option that runs a command, so `sudo` among their arguments is text
 * (Astra r2-8). Nothing a classifier pattern names as an executable may be
 * listed here or in {@link GUARDED_TEXT_PROGRAMS}: rm, chmod, chown, apt, brew,
 * npm, pip, systemctl, sudo, doas.
 */
const TEXT_PROGRAMS: ReadonlySet<string> = new Set(
	"echo printf cat head tail wc grep egrep fgrep ls tee cut tr cd pwd type which true false test".split(" "),
);

/** Git subcommands that take text and never a command; none is one a git-destructive pattern names. */
const GIT_TEXT_SUBCOMMANDS: ReadonlySet<string> = new Set("add blame commit diff grep log show status tag".split(" "));

/**
 * The text subcommand the words after `git` name, or null when they name
 * another or carry an option that runs a program or writes a file.
 */
function gitTextSubcommand(args: ReadonlyArray<string>): string | null {
	let index = 0;
	while (args[index] === "--no-pager" || args[index] === "-C") index += args[index] === "-C" ? 2 : 1;
	const subcommand = args[index] ?? "";
	if (!GIT_TEXT_SUBCOMMANDS.has(subcommand)) return null;
	// Git takes any unique prefix of a long option: `--output` writes a file a
	// later hook could be, and grep's `-O` and `--open-files-in-pager` run one.
	const refused = subcommand === "grep" ? /^(?:--o|-[A-Za-z]*O)/u : /^--ou/u;
	return args.slice(index + 1).some((word) => refused.test(word)) ? null : subcommand;
}

/**
 * Programs with an option that runs a command or writes a file, admitted only
 * without it. Every word of theirs must also be written out literally, because
 * an expansion could supply the option: `rg $X sudo f` with `X=--pre`.
 */
const GUARDED_TEXT_PROGRAMS: ReadonlyMap<string, (args: ReadonlyArray<string>) => boolean> = new Map([
	["rg", (args: ReadonlyArray<string>) => !args.some((word) => /^--(?:pre|hostname-bin)/u.test(word))],
	["sort", (args: ReadonlyArray<string>) => !args.some((word) => /^(?:--[co]|-[A-Za-z]*o)/u.test(word))],
	// A second operand of uniq is a file it writes.
	["uniq", (args: ReadonlyArray<string>) => args.every((word) => word.startsWith("-"))],
	// `command -v` and `-V` describe a name; without them `command` runs it.
	["command", (args: ReadonlyArray<string>) => args[0] === "-v" || args[0] === "-V"],
	["git", (args: ReadonlyArray<string>) => gitTextSubcommand(args) !== null],
]);

/**
 * Every bash builtin and reserved word, with the zsh ones that define names.
 * One of these outside {@link TEXT_PROGRAMS} can change what a later name
 * runs (`alias`, `hash -p`, `export PATH`, `source`, a function body) or hides
 * the command it leads (`then`, `time`, `!`), so a line holding one is judged
 * by its whole text.
 */
const SHELL_WORDS: ReadonlySet<string> = new Set(
	(
		". : [ alias bg bind break builtin caller cd command compgen complete compopt continue declare dirs disown echo " +
		"enable eval exec exit export false fc fg getopts hash help history jobs kill let local logout mapfile popd " +
		"printf pushd pwd read readarray readonly return set shift shopt source suspend test times trap true type " +
		"typeset ulimit umask unalias unset wait ! case coproc do done elif else esac fi for function if in select " +
		"then until while { } time [[ ]] autoload emulate float functions integer nocorrect noglob private rehash " +
		"setopt unfunction unhash unsetopt zmodload"
	).split(" "),
);

/** More `"$(...)"` levels than this are not followed. */
const TEXT_SCRIPT_MAX_DEPTH = 3;

/**
 * How much of a word the shell rewrites before a program sees it: nothing, a
 * variable or glob whose result is still that program's data, or something
 * that runs a command or that the scanner does not model (`${x:-...}`, `$[`,
 * `$'`), where it and bash may disagree on what follows.
 */
function wordExpansion(raw: string): "literal" | "expanded" | "unsafe" {
	let quote: string | null = null;
	let expanded = false;
	let bare = "";
	for (let index = 0; index < raw.length; index += 1) {
		const char = raw[index] ?? "";
		if (quote === "'") {
			if (char === "'") quote = null;
			continue;
		}
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (char === "`") return "unsafe";
		if (char === "$") {
			const next = raw[index + 1] ?? "";
			const braced = /^\$\{[A-Za-z_]\w*\}/u.test(raw.slice(index));
			if (/[([`]/u.test(next) || (next === "{" && !braced)) return "unsafe";
			if (quote === null && (next === "'" || next === '"')) return "unsafe";
			if (braced || /[\w@*#?!$-]/u.test(next)) expanded = true;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = null;
			continue;
		}
		if (char === "'" || char === '"') quote = char;
		else bare += char;
	}
	if (quote !== null) return "unsafe";
	const globbed = /[*?[]/u.test(bare) || /\{[^{}]*(?:,|\.\.)[^{}]*\}/u.test(bare) || raw.startsWith("~");
	return expanded || globbed ? "expanded" : "literal";
}

/**
 * Whether a simple command is one of the text programs, run by its bare name
 * with words the shell leaves as that program's data; `git` marks the one
 * that also reads hooks and configuration from files. A word may be exactly
 * `"$(script)"` when the script is itself only such commands: one word either
 * way, so the other guarded programs refuse it and git takes it only as the
 * message of a commit or tag.
 */
function textCommand(segment: ReadonlyArray<ShellToken>, source: string, depth: number): "plain" | "git" | null {
	const words = shellCommandWords(segment);
	const head = words[0];
	if (head === undefined) return null;
	const guard = GUARDED_TEXT_PROGRAMS.get(head.value);
	if (guard === undefined && !TEXT_PROGRAMS.has(head.value)) return null;
	const args = words.slice(1).map((token) => token.value);
	const messages = head.value === "git" && ["commit", "tag"].includes(gitTextSubcommand(args) ?? "");
	for (const token of segment) {
		if (token.operator) continue;
		const raw = source.slice(token.start, token.end);
		if (token.hiddenContent || token.unterminated) return null;
		if (token.substitutions !== undefined) {
			const script = token.substitutions[0] ?? "";
			const previous = words[words.indexOf(token) - 1]?.value ?? "";
			if (token.substitutions.length !== 1 || raw !== `"$(${script})"` || token === head) return null;
			if (guard !== undefined && !(messages && /^(?:-[A-Za-z]*m|--message)$/u.test(previous))) return null;
			if (depth >= TEXT_SCRIPT_MAX_DEPTH || !onlyTextCommands(script, depth + 1)) return null;
			continue;
		}
		const expansion = wordExpansion(raw);
		if (expansion === "unsafe" || (expansion === "expanded" && (guard !== undefined || token === head))) return null;
	}
	if (guard !== undefined) return guard(args) ? (head.value === "git" ? "git" : "plain") : null;
	// `printf -v` assigns a shell variable.
	return head.value === "printf" && args[0]?.startsWith("-v") === true ? null : "plain";
}

interface TextLine {
	/** The command with its here-document bodies removed; equal to the command when it has none. */
	source: string;
	tokens: ShellToken[];
	segments: ShellToken[][];
	kinds: Array<"plain" | "git" | null>;
	/** Per command: a text command that sends its words to a file, where a later command could run them. */
	writes: boolean[];
}

/** The simple commands of a line the scanner reads the way bash does, or null when it may not. */
function readTextLine(command: string, depth: number): TextLine | null {
	const source = withoutHeredocBodies(command, true);
	const tokens = scanShellLike(source);
	for (const [index, token] of tokens.entries()) {
		if (token.unterminated || token.hiddenContent) return null;
		// A here-document left in place has a body no reader can bound.
		if (token.operator && token.value === "<<") return null;
		// `name()` defines a function, which can stand for any text program.
		const next = tokens[index + 1];
		if (token.operator && token.value === "(" && next?.operator === true && next.value === ")") return null;
	}
	const segments = splitSegments(tokens);
	const kinds = segments.map((segment) => textCommand(segment, source, depth));
	const writes = segments.map((segment, index) => {
		const text = source.slice(segment[0]?.start ?? 0, segment.at(-1)?.end ?? 0);
		return kinds[index] !== null && extractCommandWriteTargets(text).length > 0;
	});
	return { source, tokens, segments, kinds, writes };
}

/**
 * Whether a script runs nothing but text programs. Git reads hooks and
 * configuration from files, so it does not count beside a text command that
 * writes one.
 */
function onlyTextCommands(command: string, depth: number, line = readTextLine(command, depth)): boolean {
	if (line === null || line.kinds.includes(null)) return false;
	return !(line.writes.includes(true) && line.kinds.includes("git"));
}

/**
 * A command that is not a text program and can change what a later name runs,
 * runs what a substitution printed, or is only the redirection of a group,
 * which sends the text of the commands inside it to a file.
 */
function rebindsNames(segment: ReadonlyArray<ShellToken>, source: string): boolean {
	const head = segment[0];
	if (head === undefined || head !== shellCommandWords(segment)[0]) return true;
	if (segment.some((token) => token.substitutions !== undefined)) return true;
	if (wordExpansion(source.slice(head.start, head.end)) !== "literal") return true;
	// An assignment (`PATH=x`, `a[0]=x`) is not a plain program name.
	return !/^[\w./+:@%,-]+$/u.test(head.value) || SHELL_WORDS.has(head.value);
}

/**
 * Whether every match of a classifier pattern in a bash command is text given
 * to a program that only reads or prints it, so the word it names is never
 * run (Astra r2-8): `rg sudo README.md`, `git log --grep doas`,
 * `echo "pip install x" >> notes.md`. The pattern still reads the whole
 * command, and a match counts unless it lies inside a {@link textCommand}. A
 * wrapper, an interpreter, `sh -c`, `xargs`, `find -exec` and any program not
 * listed keep their text, so `env sudo x` and `python -c "...sudo..."` match
 * as before.
 *
 * Text can still reach something that runs it. A line of nothing but text
 * commands is exempt. Beside any other command, a line that pipes or carries a
 * here-document is not, nor is a match in a text command that writes a file,
 * nor any line with a command that {@link rebindsNames}. A line the scanner
 * cannot read keeps the whole-text match.
 */
export function matchesOnlyCommandText(command: string, pattern: RegExp): boolean {
	const matches = [...command.matchAll(new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/gu, "")}g`))];
	const line = matches.length === 0 ? null : readTextLine(command, 0);
	if (line === null) return false;
	if (onlyTextCommands(command, 0, line)) return true;
	if (line.source !== command || line.tokens.some((token) => token.operator && token.value === "|")) return false;
	if (line.segments.some((segment, index) => line.kinds[index] === null && rebindsNames(segment, line.source)))
		return false;
	return matches.every((match) =>
		line.segments.some(
			(segment, index) =>
				line.kinds[index] !== null &&
				line.writes[index] !== true &&
				match.index >= (segment[0]?.start ?? 0) &&
				match.index + match[0].length <= (segment.at(-1)?.end ?? 0),
		),
	);
}
