/**
 * What a bash command would do to the workspace, in one sentence per step, for
 * the approval card.
 *
 * This is presentation only. Nothing on the admission path reads it, so a
 * command this module does not recognize shows no extra line and a recognized
 * one is neither blocked nor asked about because of it. It reads the same
 * literal argv the write and delete scanners read (`shellCommandSteps`), so it
 * inherits their limits: no variable expansion, no aliases, no script bodies.
 * An operand written as `$DIR` is shown as `$DIR`.
 *
 * It reads the full command from the call's arguments, in the process that
 * holds them. The bounded `target` text is flattened to one line and cut, so a
 * sentence built from it could name half an operand or miss a later step.
 *
 * Every value that reaches a sentence is secret-redacted, collapsed to one line
 * with control bytes neutralized, and bounded, because the command text is
 * model-authored and the sentence appears on the surface that approves it.
 */

import { ToolNames } from "../../core/tool-names.js";
import { sanitizeCallTargetText } from "./call-target.js";
import { type ShellCommandStep, sedInPlaceOperands, shellCommandSteps } from "./protected-artifacts.js";
import { redactSecretString } from "./redaction.js";

/** Sentences shown before the rest collapse into `and N more`, unless more of them are severe. */
export const COMMAND_CONSEQUENCE_MAX_LINES = 3;

/** Severe sentences (deletes, stops, history rewrites) are never folded into `and N more` up to this many. */
export const COMMAND_CONSEQUENCE_MAX_SEVERE = 8;

/** Characters of one sentence. The host and the worker use this one limit, so a cut happens once. */
export const COMMAND_CONSEQUENCE_LINE_CHARS = 240;

/** Operands named in one sentence before the rest collapse into `and N more`. */
const MAX_OPERANDS_PER_LINE = 3;

/** Characters of one operand shown; a longer one is cut with an ellipsis. */
const MAX_OPERAND_CHARS = 48;

/** Existence lookups one command may cause; later paths are not claimed about. */
const MAX_PATH_LOOKUPS = 32;

/** Substitutions (`$(`, backtick, `<(`, `>(`) one described command may hold. */
const MAX_SUBSTITUTIONS = 200;

/** Here-documents one described command may hold. */
const MAX_HEREDOCS = 32;

/** Distinct sentences kept before the rest are counted as `more`. */
const MAX_DISTINCT_LINES = 1000;

export type PathKind = "file" | "dir" | null;

export interface CommandConsequenceOptions {
	/**
	 * What exists at a path, resolved by the caller against the directory the
	 * command runs in. Absent when the caller cannot look (a worker describes
	 * its command before the host sees it), in which case no overwrite is
	 * claimed, because `>` and `cp` onto a new file overwrite nothing.
	 */
	pathKind?: (path: string) => PathKind;
	/**
	 * The home directory, or a function that reads it, so `~/x` and `$HOME/x`
	 * read as the path the shell will use. A throwing function means no home.
	 * Without one, when the command assigns HOME itself, or when it runs under
	 * sudo, doas or su (the target user's `~` is not this one), such an operand
	 * is shown as written and no existence claim is made for it.
	 */
	home?: string | (() => string);
}

/** What the steps of one command share. */
interface Context {
	/** False once the command changes directory, so the directory it started in no longer names what a path means. */
	cwdKnown: boolean;
	pathKind: ((path: string) => PathKind) | null;
}

/** Commands that change the directory later relative paths resolve against. */
const DIRECTORY_CHANGERS: ReadonlySet<string> = new Set(["cd", "pushd", "popd"]);

/** A bare `HOME` word: an assignment, `export HOME`, `unset HOME`. `$HOME` is a read and does not match. */
const HOME_WORD = /(?<![$\w{])HOME\b/u;

/** A command that runs another as a different user, where `~` is that user's home. */
const PRIVILEGE_WORD = /(?<![\w$./-])(?:sudo|doas|su|pkexec|runuser)(?![\w-])/u;

/**
 * Whether `path` is the file the shell will open. A leading `~`, a variable, a
 * substitution, a glob or a brace list names something this module cannot
 * resolve, and a literal lookup of it would find an unrelated entry or none.
 */
function resolvablePath(path: string): boolean {
	return !path.startsWith("~") && !/[$`*?[{]/u.test(path);
}

/** Sentences that name a destructive effect; they rank first and are never folded away. */
function isSevere(line: string): boolean {
	return /^(?:Deletes|Stops|Signals|Discards|Rewrites|Replaces|Drops|Mirrors|Empties)\b|overwrites its history|\bdeletes\b/u.test(
		line,
	);
}

/** One sentence cut to the shared limit from the middle, so the clause that names the severity at its end survives. */
export function fitConsequenceLine(line: string): string {
	if (line.length <= COMMAND_CONSEQUENCE_LINE_CHARS) return line;
	const head = Math.floor(COMMAND_CONSEQUENCE_LINE_CHARS * 0.4);
	return `${line.slice(0, head)}…${line.slice(line.length - (COMMAND_CONSEQUENCE_LINE_CHARS - head - 1))}`;
}

/**
 * The sentences for a command: severe ones first in effect, folded into `and N
 * more` only when there are more than the cap. Linear in the command: a
 * distinct-line set, a bounded number of file lookups, and no re-reading.
 */
function describeCommandConsequences(command: string, options: CommandConsequenceOptions = {}): string[] {
	// Each substitution is scanned to its close, so a command made of thousands of
	// them is quadratic. It is said to be too complex rather than described from
	// part of it.
	// Each here-document costs a pass over the whole command, so many are too.
	if (
		(command.match(/\$\(|`|<\(|>\(/gu)?.length ?? 0) > MAX_SUBSTITUTIONS ||
		(command.match(/<<(?!<)/gu)?.length ?? 0) > MAX_HEREDOCS
	) {
		return ["This command is too complex to describe (many substitutions or here-documents)"];
	}
	const rawHome = typeof options.home === "function" ? options.home() : options.home;
	const home = rawHome !== undefined && !HOME_WORD.test(command) && !PRIVILEGE_WORD.test(command) ? rawHome : undefined;
	const steps: ShellCommandStep[] = [];
	for (const step of shellCommandSteps(command, home)) {
		const unwrapped = unwrapStep(step);
		if (unwrapped !== null) steps.push(unwrapped);
	}
	// After a `cd` a relative path means another file, and the order a loop or a
	// subshell runs it in is not modeled, so a command that changes directory
	// anywhere makes no claim about what exists or what `.` is.
	const cwdKnown = !steps.some((step) => DIRECTORY_CHANGERS.has(step.executable));
	const look = cwdKnown ? options.pathKind : undefined;
	let lookups = 0;
	const context: Context = {
		cwdKnown,
		pathKind:
			look === undefined
				? null
				: (path) => {
						if (!resolvablePath(path) || lookups >= MAX_PATH_LOOKUPS) return null;
						lookups += 1;
						return look(path);
					},
	};
	const seen = new Set<string>();
	const entries: Array<{ line: string; severe: boolean }> = [];
	let overflow = false;
	for (const step of steps) {
		for (const line of stepConsequences(step, context)) {
			if (seen.has(line)) continue;
			if (seen.size >= MAX_DISTINCT_LINES) {
				overflow = true;
				continue;
			}
			seen.add(line);
			entries.push({ line: fitConsequenceLine(line), severe: isSevere(line) });
		}
	}
	const severeCount = entries.filter((entry) => entry.severe).length;
	const limit = Math.max(COMMAND_CONSEQUENCE_MAX_LINES, Math.min(COMMAND_CONSEQUENCE_MAX_SEVERE, severeCount));
	if (entries.length <= limit && !overflow) return entries.map((entry) => entry.line);
	const shownAt = entries
		.map((_, index) => index)
		.sort((a, b) => Number(entries[b]?.severe) - Number(entries[a]?.severe) || a - b)
		.slice(0, limit)
		.sort((a, b) => a - b);
	const lines = shownAt.map((index) => entries[index]?.line ?? "");
	const rest = entries.length - shownAt.length;
	const hiddenSevere = severeCount > shownAt.length ? ", some of which delete or stop things" : "";
	lines.push(overflow ? `and more${hiddenSevere}` : `and ${rest} more${hiddenSevere}`);
	return lines;
}

/**
 * The sentences for one tool call's arguments: none unless it is a bash call
 * with a string command. Called where the full arguments exist (the main
 * agent's registry admission and the worker's escalation), never on the
 * bounded `target` text, which is flattened and cut. Card text only, so a
 * failure is no sentence and never a different admission.
 */
export function describeBashCallConsequences(
	tool: string,
	args: Record<string, unknown> | undefined,
	options: CommandConsequenceOptions = {},
): string[] {
	if (tool !== ToolNames.Bash) return [];
	const command = args?.command;
	if (typeof command !== "string") return [];
	try {
		return describeCommandConsequences(command, options);
	} catch {
		// The card renders without the line; nothing waits on it.
		return [];
	}
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

interface WrapperShape {
	/** Options that take the next word as their value. */
	values: ReadonlyArray<string>;
	/** Positional words before the wrapped command (`timeout 60 cmd`). */
	positional: number;
	/** Options that mean there is no wrapped command to describe. */
	refuse?: ReadonlyArray<string>;
}

/** Commands that run the command after them, so their consequence is the wrapped command's. */
const WRAPPERS: Readonly<Record<string, WrapperShape>> = {
	exec: { values: ["-a"], positional: 0 },
	nohup: { values: [], positional: 0 },
	timeout: { values: ["-k", "-s", "--kill-after", "--signal"], positional: 1 },
	nice: { values: ["-n", "--adjustment"], positional: 0 },
	ionice: {
		values: ["-c", "-n", "--class", "--classdata"],
		positional: 0,
		refuse: ["-p", "-P", "-u", "--pid", "--pgid", "--uid"],
	},
	stdbuf: { values: ["-i", "-o", "-e", "--input", "--output", "--error"], positional: 0 },
	setsid: { values: [], positional: 0 },
	busybox: { values: [], positional: 0 },
	env: { values: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"], positional: 0 },
	chrt: { values: [], positional: 1, refuse: ["-p", "--pid"] },
	flock: { values: ["-w", "--timeout", "-E", "--conflict-exit-code"], positional: 1, refuse: ["-c", "--command"] },
};

/** The step a wrapper runs, or null when it runs nothing this module can name. */
function unwrapStep(input: ShellCommandStep): ShellCommandStep | null {
	let step = input;
	for (let depth = 0; depth < 8; depth += 1) {
		const shape = WRAPPERS[step.executable];
		if (shape === undefined) return step;
		let index = 0;
		while (index < step.args.length) {
			const word = step.args[index] ?? "";
			if (word === "--") {
				index += 1;
				break;
			}
			if (word.startsWith("-") && word.length > 1) {
				if (shape.refuse?.includes(word)) return null;
				index += shape.values.includes(word) ? 2 : 1;
			} else if (step.executable === "env" && /^[A-Za-z_]\w*=/u.test(word)) {
				index += 1;
			} else {
				break;
			}
		}
		index += shape.positional;
		const command = step.args[index];
		if (command === undefined) return null;
		step = {
			...step,
			executable: command.slice(command.lastIndexOf("/") + 1).toLowerCase(),
			args: step.args.slice(index + 1),
		};
	}
	return null;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Standing for `.` once it is known to be the directory the command started in. */
const CURRENT_DIRECTORY = "\u0001cwd";

/** `.`, `./`, `././`: the directory itself, not `..`. */
function isCurrentDir(word: string): boolean {
	return /^\.(?:\/+\.?)*\/*$/u.test(word);
}

/** Executables whose words are only paths, so a path set at run time is still a path. */
const PATH_ONLY: ReadonlySet<string> = new Set(["rm", "mv", "cp", "truncate", "sed", "chmod", "chown", "chgrp"]);

/** Path commands where `.` means the directory the command runs in. */
const DOT_PATH: ReadonlySet<string> = new Set(["rm", "mv", "cp", "truncate", "sed", "chmod", "chown", "chgrp", "find"]);

/** A whole word the shell fills in (`$F`, `$(x)`, `$'..'`), which may be a flag, a refspec or several words. */
function isRuntimeWord(word: string): boolean {
	return word.startsWith("$") || word.startsWith("`");
}

function stepConsequences(step: ShellCommandStep, context: Context): string[] {
	const out: string[] = [];
	for (const target of step.truncatingRedirects) {
		if (context.pathKind?.(target) === "file") out.push(`Overwrites ${shown(target)}`);
	}
	let current = step;
	if (DOT_PATH.has(step.executable) && step.args.some(isCurrentDir)) {
		if (!context.cwdKnown) return out;
		current = { ...step, args: step.args.map((word) => (isCurrentDir(word) ? CURRENT_DIRECTORY : word)) };
	}
	// Anywhere but a path-only command, a word set at run time can be an option
	// or a refspec that changes what the step does, so the step says nothing.
	if (!PATH_ONLY.has(current.executable) && current.args.some(isRuntimeWord)) return out;
	const line = executableConsequence(current, context);
	if (line !== null) out.push(line);
	return out;
}

function executableConsequence(step: ShellCommandStep, context: Context): string | null {
	const { executable, args } = step;
	switch (executable) {
		case "git":
			return gitConsequence(args, context.cwdKnown);
		case "rm":
			return rmConsequence(args);
		case "mv":
		case "cp":
			return copyMoveConsequence(args, context);
		case "sed": {
			const files = sedInPlaceOperands(args);
			return files !== null && files.length > 0 ? `Edits ${list(files)} in place` : null;
		}
		case "truncate":
			return truncateConsequence(args);
		case "chmod":
			return recursiveOwnerConsequence(args, "permissions");
		case "chown":
		case "chgrp":
			return recursiveOwnerConsequence(args, "ownership");
		case "kill":
			return killConsequence(args);
		case "pkill":
		case "killall":
			return killByNameConsequence(executable, args);
		case "find":
			return findConsequence(args, context.cwdKnown);
		case "xargs":
			return xargsConsequence(args);
		case "npm":
		case "pnpm":
		case "yarn":
		case "bun":
			return nodeInstallConsequence(executable, args);
		case "pip":
		case "pip3":
			return pipConsequence(args);
		case "uv":
			return uvConsequence(args);
		case "cargo":
			return args[0] === "add" ? `Downloads packages${named(operands(args.slice(1)))} and changes Cargo.toml` : null;
		case "go":
			return args[0] === "get"
				? `Downloads packages${named(operands(args.slice(1)))} and changes go.mod and go.sum`
				: null;
		default:
			if (/^python3?(?:\.\d+)?$/u.test(executable) && args[0] === "-m" && args[1] === "pip") {
				return pipConsequence(args.slice(2));
			}
			return null;
	}
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * One operand, redacted, collapsed to one line and bounded. A word like `$'/'`,
 * which the shell fills in, is never rendered as the `$/` it lexes to. A path
 * with a `..` segment is never cut, because the cut can hide where it lands.
 */
function shown(value: string): string {
	if (value === CURRENT_DIRECTORY) return "the current directory";
	if (/^\$[^A-Za-z_{(]/u.test(value)) return "a word set at run time";
	const clean = sanitizeCallTargetText(redactSecretString(value));
	if (clean.length === 0) return "(empty)";
	if (clean.length <= MAX_OPERAND_CHARS) return clean;
	if (/(?:^|\/)\.\.(?:\/|$)/u.test(value)) return "a path using .. (too long to show)";
	return `${clean.slice(0, MAX_OPERAND_CHARS - 1)}…`;
}

function list(values: ReadonlyArray<string>): string {
	const head = values.slice(0, MAX_OPERANDS_PER_LINE).map(shown);
	const rest = values.length - head.length;
	return rest > 0 ? `${head.join(", ")} and ${rest} more` : head.join(", ");
}

/** ` (a, b)` for a package line, or nothing when no package is named. */
function named(values: ReadonlyArray<string>): string {
	return values.length === 0 ? "" : ` (${list(values)})`;
}

/**
 * Non-option words, honoring `--`. `valueOptions` take the next word as their
 * value, so it is not an operand. A lone `-` is an operand (stdin).
 */
function operands(args: ReadonlyArray<string>, valueOptions: ReadonlySet<string> = new Set()): string[] {
	const out: string[] = [];
	let endOfOptions = false;
	for (let index = 0; index < args.length; index += 1) {
		const word = args[index];
		if (word === undefined) continue;
		if (!endOfOptions && word === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && word.startsWith("-") && word.length > 1) {
			if (valueOptions.has(word)) index += 1;
			continue;
		}
		out.push(word);
	}
	return out;
}

/** Whether a short-option cluster (`-rf`) or one of the long names is present before `--`. */
function hasFlag(args: ReadonlyArray<string>, shorts: string, longs: ReadonlyArray<string> = []): boolean {
	for (const word of args) {
		if (word === "--") return false;
		if (word.startsWith("--")) {
			if (longs.includes(word.split("=")[0] ?? word)) return true;
			continue;
		}
		if (word.startsWith("-") && word.length > 1) {
			for (const ch of word.slice(1)) if (shorts.includes(ch)) return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// rm, mv, cp
// ---------------------------------------------------------------------------

function rmConsequence(args: ReadonlyArray<string>): string | null {
	const paths = operands(args);
	if (paths.length === 0) return null;
	if (hasFlag(args, "rR", ["--recursive"])) return `Deletes ${list(paths)} recursively`;
	// A variable word may hold -r, so a missing flag is not a claim that nothing is recursive.
	if (paths.some(isRuntimeWord)) return `Deletes ${list(paths)}, recursively if the variable adds -r`;
	return `Deletes ${list(paths)}`;
}

/** The destination of a `cp` or `mv`, honoring `-t DIR`, a cluster like `-vt DIR`, and `--target-directory`. */
function copyMoveConsequence(args: ReadonlyArray<string>, context: Context): string | null {
	if (hasFlag(args, "n", ["--no-clobber"])) return null;
	let targetDir: string | null = null;
	const rest: string[] = [];
	let endOfOptions = false;
	for (let index = 0; index < args.length; index += 1) {
		const word = args[index];
		if (word === undefined) continue;
		if (!endOfOptions && word === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && word.startsWith("-") && word.length > 1) {
			if (word.startsWith("--")) {
				const name = word.split("=")[0] ?? word;
				if (name.length >= 4 && "--target-directory".startsWith(name)) {
					targetDir = word.includes("=") ? word.slice(word.indexOf("=") + 1) : (args[index + 1] ?? null);
					if (!word.includes("=")) index += 1;
				} else if (name === "--suffix" && !word.includes("=")) {
					index += 1;
				}
			} else {
				for (let at = 1; at < word.length; at += 1) {
					const flag = word[at];
					if (flag !== "t" && flag !== "S") continue;
					const attached = word.slice(at + 1);
					if (flag === "t") targetDir = attached.length > 0 ? attached : (args[index + 1] ?? null);
					if (attached.length === 0) index += 1;
					break;
				}
			}
			continue;
		}
		rest.push(word);
	}
	const sources = targetDir === null ? rest.slice(0, -1) : rest;
	const destination = targetDir ?? rest.at(-1);
	if (destination === undefined || sources.length === 0) return null;
	const kind = context.pathKind?.(destination) ?? null;
	if (kind === null) return null;
	if (kind === "file") return targetDir === null ? `Overwrites ${shown(destination)}` : null;
	// Into a directory, only a same-named entry already there is replaced.
	const replaced: string[] = [];
	for (const source of sources) {
		const candidate = joinPath(destination, baseName(source));
		if (context.pathKind?.(candidate) === "file") replaced.push(candidate);
	}
	return replaced.length > 0 ? `Overwrites ${list(replaced)}` : null;
}

/** `truncate -s 0 f` empties f; any other size resizes it. Neither is an in-place edit. */
function truncateConsequence(args: ReadonlyArray<string>): string | null {
	let size: string | null = null;
	const files: string[] = [];
	let endOfOptions = false;
	for (let index = 0; index < args.length; index += 1) {
		const word = args[index];
		if (word === undefined) continue;
		if (!endOfOptions && word === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && word.startsWith("-") && word.length > 1) {
			if (word === "-s" || word === "--size") size = args[++index] ?? null;
			else if (word.startsWith("--size=")) size = word.slice("--size=".length);
			else if (word === "-r" || word === "--reference") index += 1;
			else if (word.startsWith("-s") && !word.startsWith("--")) size = word.slice(2);
			continue;
		}
		files.push(word);
	}
	if (files.length === 0) return null;
	return size !== null && /^0+$/u.test(size) ? `Empties ${list(files)}` : `Resizes ${list(files)}`;
}

function baseName(path: string): string {
	const trimmed = path.replace(/\/+$/u, "");
	return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

function joinPath(dir: string, name: string): string {
	return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

/** Global options that take their value as the next word. */
const GIT_GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--exec-path",
	"--super-prefix",
	"--config-env",
]);

/**
 * The long options of the subcommands classified here. git's option parser
 * accepts any unique prefix (`--del`, `--force-w`), so a flag is matched
 * against these rather than by exact name.
 */
const GIT_LONG_OPTIONS: Readonly<Record<string, ReadonlyArray<string>>> = {
	push:
		"all branches prune mirror dry-run porcelain delete tags follow-tags signed atomic push-option receive-pack exec force-with-lease force force-if-includes repo set-upstream thin quiet verbose progress recurse-submodules verify ipv4 ipv6 no-verify no-thin no-force-with-lease no-force-if-includes no-signed no-recurse-submodules"
			.split(" ")
			.map((name) => `--${name}`),
	clean: "dry-run force interactive quiet exclude".split(" ").map((name) => `--${name}`),
	reset:
		"soft mixed hard merge keep quiet patch pathspec-from-file pathspec-file-nul recurse-submodules refresh intent-to-add no-quiet no-refresh no-recurse-submodules"
			.split(" ")
			.map((name) => `--${name}`),
	restore:
		"source patch worktree staged quiet progress no-progress ours theirs merge conflict ignore-unmerged ignore-skip-worktree-bits recurse-submodules no-recurse-submodules overlay no-overlay pathspec-from-file pathspec-file-nul"
			.split(" ")
			.map((name) => `--${name}`),
	commit:
		"all allow-empty allow-empty-message amend author branch cleanup date dry-run edit file fixup gpg-sign include interactive message no-edit no-verify only patch porcelain quiet reedit-message reuse-message reset-author short signoff squash status template untracked-files verbose verify long null pathspec-from-file pathspec-file-nul trailer no-gpg-sign no-post-rewrite no-signoff no-status mailmap"
			.split(" ")
			.map((name) => `--${name}`),
	tag: "delete list sign annotate message file force verify contains no-contains points-at merged no-merged sort format column no-column create-reflog cleanup local-user edit no-sign color ignore-case omit-empty"
		.split(" ")
		.map((name) => `--${name}`),
	branch:
		"delete list move copy force all remotes verbose quiet set-upstream-to unset-upstream track no-track contains no-contains merged no-merged points-at sort format show-current create-reflog edit-description color no-color column no-column abbrev no-abbrev ignore-case omit-empty recurse-submodules"
			.split(" ")
			.map((name) => `--${name}`),
	rebase:
		"abort continue skip quit edit-todo show-current-patch onto exec strategy strategy-option interactive root autosquash no-autosquash autostash no-autostash keep-base rebase-merges merge apply force-rebase no-ff fork-point no-fork-point whitespace committer-date-is-author-date ignore-date reset-author-date gpg-sign signoff verify no-verify quiet verbose stat no-stat update-refs no-update-refs empty reapply-cherry-picks no-reapply-cherry-picks keep-empty no-keep-empty rerere-autoupdate no-rerere-autoupdate context ignore-whitespace"
			.split(" ")
			.map((name) => `--${name}`),
};

/** The option a long word names: exact, else the one option it is a prefix of. */
function resolveLongOption(name: string, known: ReadonlyArray<string>): string | null {
	if (known.includes(name)) return name;
	if (name.length < 3) return null;
	const matches = known.filter((option) => option.startsWith(name));
	return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** Whether a short cluster or one of the long options (or a unique abbreviation of it) is present before `--`. */
function gitHas(sub: string, args: ReadonlyArray<string>, shorts: string, longs: ReadonlyArray<string> = []): boolean {
	const known = GIT_LONG_OPTIONS[sub] ?? [];
	for (const word of args) {
		if (word === "--") return false;
		if (word.startsWith("--")) {
			const option = resolveLongOption(word.split("=")[0] ?? word, known);
			if (option !== null && longs.includes(option)) return true;
			continue;
		}
		if (word.startsWith("-") && word.length > 1) {
			for (const ch of word.slice(1)) if (shorts.includes(ch)) return true;
		}
	}
	return false;
}

/** Where `.` and an omitted path mean, once `-C` and an earlier cd are considered. */
interface GitScope {
	/** The directory git acts in, ready for `shown`, or null when it is not known. */
	dir: string | null;
	/** ` (relative to X)` after a path that `-C` moved, else empty. */
	relativeTo: string;
	/** The whole working tree, for commands that reset all of it. */
	tree: string | null;
}

function gitConsequence(args: ReadonlyArray<string>, cwdKnown: boolean): string | null {
	let repoDir: string | null = null;
	let redirected = false;
	let index = 0;
	for (; index < args.length; index += 1) {
		const word = args[index];
		if (word === undefined) continue;
		if (!word.startsWith("-")) break;
		if (/^--(?:git-dir|work-tree)(?:=|$)/u.test(word)) redirected = true;
		// Each -C is relative to the one before it.
		if (word === "-C") {
			const next = args[index + 1] ?? "";
			repoDir = repoDir === null || next.startsWith("/") ? next : `${repoDir}/${next}`;
		}
		if (GIT_GLOBAL_VALUE_OPTIONS.has(word)) index += 1;
	}
	const sub = args[index];
	if (sub === undefined) return null;
	const rest = args.slice(index + 1);
	// checkout, restore and clean act on the directory git runs in and below it,
	// which `-C` moves, and `--git-dir` or `--work-tree` move somewhere unknown.
	// `reset --hard` acts on the whole working tree whichever directory it runs in.
	const known = repoDir !== null ? repoDir.startsWith("/") || cwdKnown : cwdKnown;
	const scope: GitScope = {
		dir: redirected || !known ? null : repoDir !== null ? shown(repoDir) : "the current directory",
		relativeTo: repoDir !== null ? ` (relative to ${shown(repoDir)})` : "",
		tree: redirected
			? null
			: repoDir !== null
				? `the whole working tree containing ${shown(repoDir)}`
				: "the whole working tree",
	};
	switch (sub) {
		case "checkout":
			return gitCheckout(rest, scope);
		case "restore":
			return gitRestore(rest, scope);
		case "reset":
			return gitReset(rest, scope);
		case "clean":
			return gitClean(rest, scope);
		case "branch":
			return gitBranch(rest);
		case "stash":
			return gitStash(rest);
		case "rebase":
			return gitRebase(rest);
		case "commit":
			return gitHas("commit", rest, "", ["--amend"]) ? "Replaces the last commit" : null;
		case "tag":
			return gitHas("tag", rest, "d", ["--delete"]) ? gitDeleteNames("tag", operands(rest)) : null;
		case "push":
			return gitPush(rest);
		default:
			return null;
	}
}

/** The paths a discard names: `.` is where git runs, and a `-C` directory qualifies the others. */
function gitPaths(paths: ReadonlyArray<string>, scope: GitScope): string | null {
	if (paths.length === 0) return null;
	if (paths.some(isCurrentDir) && scope.dir === null) return null;
	const named = paths.map((path) => (isCurrentDir(path) ? (scope.dir ?? path) : path));
	const qualified = paths.some((path) => !isCurrentDir(path)) ? scope.relativeTo : "";
	return `${list(named)}${qualified}`;
}

function gitCheckout(args: ReadonlyArray<string>, scope: GitScope): string | null {
	const dashDash = args.indexOf("--");
	const paths = dashDash >= 0 ? args.slice(dashDash + 1) : operands(args);
	// Without a separator only `git checkout .` is the same discard.
	if (dashDash < 0 && !(paths.length === 1 && isCurrentDir(paths[0] ?? ""))) return null;
	const where = gitPaths(paths, scope);
	return where === null ? null : `Discards uncommitted changes in ${where}`;
}

function gitRestore(args: ReadonlyArray<string>, scope: GitScope): string | null {
	const staged = gitHas("restore", args, "S", ["--staged"]);
	const worktree = gitHas("restore", args, "W", ["--worktree"]);
	if (staged && !worktree) return null;
	const dashDash = args.indexOf("--");
	const paths =
		dashDash >= 0 ? args.slice(dashDash + 1) : operands(args, new Set(["-s", "--source", "--pathspec-from-file"]));
	const where = gitPaths(paths, scope);
	return where === null ? null : `Discards uncommitted changes in ${where}`;
}

/** `reset --hard <commit>` also moves the branch, so later commits leave it. */
function gitReset(args: ReadonlyArray<string>, scope: GitScope): string | null {
	if (!gitHas("reset", args, "", ["--hard"]) || scope.tree === null) return null;
	const commit = operands(args)[0];
	const discard = `Discards uncommitted changes in ${scope.tree}`;
	if (commit === undefined || commit === "HEAD" || commit === "@") return discard;
	return `${discard} and moves the branch to ${shown(commit)}, so commits after it leave the branch`;
}

function gitClean(args: ReadonlyArray<string>, scope: GitScope): string | null {
	if (!gitHas("clean", args, "f", ["--force"])) return null;
	if (gitHas("clean", args, "n", ["--dry-run"])) return null;
	const paths = operands(args, new Set(["-e", "--exclude"]));
	const where = paths.length > 0 ? gitPaths(paths, scope) : scope.dir;
	if (where === null) return null;
	if (hasFlag(args, "x")) return `Deletes untracked and ignored files in ${where}`;
	if (hasFlag(args, "X")) return `Deletes ignored files in ${where}`;
	return `Deletes untracked files in ${where}`;
}

function gitDeleteNames(kind: "branch" | "tag", names: ReadonlyArray<string>): string | null {
	if (names.length === 0) return null;
	return `Deletes ${kind}${names.length > 1 ? (kind === "branch" ? "es" : "s") : ""} ${list(names)}`;
}

function gitBranch(args: ReadonlyArray<string>): string | null {
	if (!gitHas("branch", args, "dD", ["--delete"])) return null;
	return gitDeleteNames("branch", operands(args));
}

function gitStash(args: ReadonlyArray<string>): string | null {
	const words = operands(args);
	if (words[0] === "clear") return "Drops all stashes";
	if (words[0] === "drop") return `Drops stash ${words[1] === undefined ? "stash@{0}" : shown(words[1])}`;
	return null;
}

function gitRebase(args: ReadonlyArray<string>): string | null {
	// A rebase already in progress is being finished or undone, not started.
	const control = ["--abort", "--continue", "--skip", "--quit", "--edit-todo", "--show-current-patch"];
	if (control.some((name) => gitHas("rebase", args, "", [name]))) return null;
	const words = operands(args, new Set(["--onto", "-x", "--exec", "-s", "--strategy", "-X", "--strategy-option"]));
	// `git rebase <upstream> <branch>` rewrites <branch>; with one word it rewrites the one checked out.
	const branch = words[1];
	return `Rewrites history of ${branch === undefined ? "the current branch" : shown(branch)}`;
}

/** Push options that take their value as the next word. */
const GIT_PUSH_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"--repo",
	"-o",
	"--push-option",
	"--receive-pack",
	"--exec",
]);

/**
 * A push publishes unless the refspecs delete (`:branch`, or `--delete`), and
 * it rewrites remote history for `--force*`, a `+` refspec or `--mirror`.
 */
function gitPush(args: ReadonlyArray<string>): string | null {
	if (gitHas("push", args, "n", ["--dry-run"])) return null;
	const words = operands(args, GIT_PUSH_VALUE_OPTIONS);
	const remote = words[0];
	const refspecs = words.slice(1);
	const target = remote === undefined ? "the upstream remote" : shown(remote);
	if (gitHas("push", args, "", ["--mirror"])) {
		return `Mirrors every ref to ${target}, overwriting and deleting remote refs to match`;
	}
	let deletes: string[];
	let publishes: string[];
	let forced = gitHas("push", args, "f", ["--force", "--force-with-lease", "--force-if-includes"]);
	if (gitHas("push", args, "d", ["--delete"])) {
		// `git push --delete origin` names no ref, and git refuses it.
		if (refspecs.length === 0) return null;
		deletes = refspecs;
		publishes = [];
	} else {
		deletes = [];
		publishes = [];
		for (const refspec of refspecs) {
			const plain = refspec.startsWith("+") ? refspec.slice(1) : refspec;
			if (plain.startsWith(":")) deletes.push(plain.slice(1));
			else {
				publishes.push(plain);
				if (refspec.startsWith("+")) forced = true;
			}
		}
	}
	const prunes = gitHas("push", args, "", ["--prune"]);
	const tail = prunes ? " and deletes remote refs it lacks" : "";
	if (deletes.length > 0 && publishes.length === 0 && !prunes) return `Deletes ${list(deletes)} on ${target}`;
	const base =
		deletes.length > 0 ? `Publishes to ${target} and deletes ${list(deletes)} there` : `Publishes to ${target}`;
	return `${base}${forced ? " and overwrites its history" : ""}${tail}`;
}

// ---------------------------------------------------------------------------
// chmod, chown, kill
// ---------------------------------------------------------------------------

function recursiveOwnerConsequence(args: ReadonlyArray<string>, what: "permissions" | "ownership"): string | null {
	if (!hasFlag(args, "R", ["--recursive"])) return null;
	// A word like `-x` is a mode, not an option, so only chmod's own flags are skipped.
	const words: string[] = [];
	let endOfOptions = false;
	for (const word of args) {
		if (!endOfOptions && word === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && (word.startsWith("--") || /^-[RfvcHLPh]+$/u.test(word))) continue;
		words.push(word);
	}
	// The first operand is the mode or owner, unless --reference names a file instead.
	const paths = args.some((word) => word.startsWith("--reference")) ? words : words.slice(1);
	if (paths.length === 0) return null;
	return `Changes ${what} under ${list(paths)} recursively`;
}

/** Signals that end a process; the verb for any other signal names only that one was sent. */
const TERMINATING_SIGNALS: ReadonlySet<string> = new Set(["9", "15", "KILL", "TERM"]);

function signalVerb(signal: string | null): "Stops" | "Signals" {
	if (signal === null) return "Stops";
	return TERMINATING_SIGNALS.has(signal.toUpperCase().replace(/^SIG/u, "")) ? "Stops" : "Signals";
}

/**
 * `kill`'s words in order: the first `-9` or `-KILL` is the signal, and once a
 * signal is chosen or `--` has been seen a word like `-1` is a negative pid,
 * which names a process group (`-1` names every process the user may signal).
 */
function killConsequence(args: ReadonlyArray<string>): string | null {
	let signal: string | null = null;
	const targets: string[] = [];
	let endOfOptions = false;
	for (let index = 0; index < args.length; index += 1) {
		const word = args[index];
		if (word === undefined) continue;
		if (endOfOptions || !word.startsWith("-") || word === "-") {
			targets.push(word);
			continue;
		}
		if (word === "--") {
			endOfOptions = true;
			continue;
		}
		if (word === "-l" || word === "-L" || word === "--list" || word === "--table") return null;
		if (word === "-s" || word === "-n" || word === "--signal") {
			signal = args[index + 1] ?? null;
			index += 1;
			continue;
		}
		if (word.startsWith("--signal=")) {
			signal = word.slice("--signal=".length);
			continue;
		}
		if (signal !== null && /^-(?:\d+|\$.*)$/u.test(word)) {
			targets.push(word);
			continue;
		}
		if (signal === null && /^-(?:\d+|[A-Za-z][A-Za-z0-9+-]*)$/u.test(word)) signal = word.slice(1);
	}
	// Signal 0 only tests whether the process exists. Pids compare as numbers: `-01` is -1 and `00` is 0.
	if (signal !== null && /^0+$/u.test(signal)) return null;
	if (targets.length === 0) return null;
	const verb = signalVerb(signal);
	if (targets.some((target) => /^-\d+$/u.test(target) && Number(target) === -1)) {
		return `${verb} every process you can signal`;
	}
	const processes: string[] = [];
	const groups: string[] = [];
	let ownGroup = false;
	for (const target of targets) {
		if (/^\d+$/u.test(target) && Number(target) === 0) ownGroup = true;
		else if (/^-\d+$/u.test(target)) groups.push(String(-Number(target)));
		else if (target.startsWith("-")) groups.push(target.slice(1));
		else processes.push(target);
	}
	const parts: string[] = [];
	if (processes.length > 0) parts.push(`processes ${list(processes)}`);
	if (groups.length > 0) parts.push(`process ${groups.length === 1 ? "group" : "groups"} ${list(groups)}`);
	if (ownGroup) parts.push("the current process group");
	return `${verb} ${parts.join(" and ")}`;
}

/** What each process selector of pkill or killall narrows the match to: [filter it replaces, wording]. */
const PKILL_SELECTORS: Readonly<Record<string, readonly [string, string]>> = {
	"-u": ["euid", "owned by"],
	"--euid": ["euid", "owned by"],
	"-U": ["uid", "owned by"],
	"--uid": ["uid", "owned by"],
	"-g": ["pgroup", "in process group"],
	"--pgroup": ["pgroup", "in process group"],
	"-G": ["group", "of group"],
	"--group": ["group", "of group"],
	"-P": ["parent", "whose parent is"],
	"--parent": ["parent", "whose parent is"],
	"-s": ["session", "in session"],
	"--session": ["session", "in session"],
	"-t": ["terminal", "on terminal"],
	"--terminal": ["terminal", "on terminal"],
	"-F": ["pidfile", "listed in"],
	"--pidfile": ["pidfile", "listed in"],
};

const KILLALL_SELECTORS: Readonly<Record<string, readonly [string, string]>> = {
	"-u": ["user", "owned by"],
	"--user": ["user", "owned by"],
};

/** A pkill pattern is a regex, so `.` or `a*` matches every process name. */
function matchesEveryProcess(pattern: string): boolean {
	if (pattern.length > 16) return false;
	try {
		const re = new RegExp(pattern, "u");
		return ["a", "bash", "/usr/bin/node --x", "1"].every((name) => re.test(name));
	} catch {
		// Not a valid regex, so it matches nothing in particular.
		return false;
	}
}

/**
 * pkill and killall match by pattern and by selector (`pkill -u me` has no
 * pattern and signals everything that user owns). A signal is `-9`, `-HUP` or
 * `--signal`; killall also takes `-s`, which is a session selector for pkill.
 * procps keeps the last of each selector, so only that one is named, which also
 * bounds the sentence however many are repeated.
 */
function killByNameConsequence(command: string, args: ReadonlyArray<string>): string | null {
	const selectors = command === "pkill" ? PKILL_SELECTORS : KILLALL_SELECTORS;
	const signalOptions = command === "pkill" ? ["--signal"] : ["-s", "--signal"];
	const valueOptions = new Set(
		command === "pkill"
			? ["-r", "--runstates", "--ns", "--nslist"]
			: ["-y", "--younger-than", "-o", "--older-than", "-Z", "--context"],
	);
	let signal: string | null = null;
	let names: string[] = [];
	const narrowing = new Map<string, string>();
	let endOfOptions = false;
	for (let index = 0; index < args.length; index += 1) {
		const word = args[index];
		if (word === undefined) continue;
		if (endOfOptions || !word.startsWith("-") || word === "-") {
			if (names.length < 64) names.push(word);
			continue;
		}
		if (word === "--") {
			endOfOptions = true;
			continue;
		}
		const [option, inline] = word.startsWith("--") && word.includes("=") ? word.split(/=(.*)/su) : [word, undefined];
		const value = inline ?? args[index + 1];
		const consumesNext = inline === undefined;
		const selector = option === undefined ? undefined : selectors[option];
		if (option !== undefined && signalOptions.includes(option)) {
			signal = value ?? null;
			if (consumesNext) index += 1;
		} else if (selector !== undefined) {
			narrowing.set(selector[0], `${selector[1]} ${shown(value ?? "")}`);
			if (consumesNext) index += 1;
		} else if (option !== undefined && valueOptions.has(option)) {
			if (consumesNext) index += 1;
		} else if (signal === null && /^-(?:\d+|[A-Z][A-Z0-9]+)$/u.test(word)) {
			signal = word.slice(1);
		}
	}
	// Signal 0 only tests whether a process exists.
	if (signal !== null && /^0+$/u.test(signal)) return null;
	if (names.length === 0 && narrowing.size === 0) return null;
	const everything = command === "pkill" ? names.find(matchesEveryProcess) : undefined;
	const verb = signalVerb(signal);
	const narrowed = [...narrowing.values()].join(" ");
	if (everything !== undefined) {
		return `${verb} every process you can signal${narrowed.length > 0 ? ` ${narrowed}` : ""} (the pattern ${shown(everything)} matches all)`;
	}
	names = names.slice(0, 64);
	const parts = [...(names.length > 0 ? [`matching ${list(names)}`] : []), ...(narrowed.length > 0 ? [narrowed] : [])];
	return `${verb} processes ${parts.join(" ")}`;
}

// ---------------------------------------------------------------------------
// find, xargs
// ---------------------------------------------------------------------------

/** `find` primaries that take the next word as their value, so it is not a primary itself. */
const FIND_VALUE_PRIMARIES: ReadonlySet<string> = new Set([
	"-name",
	"-iname",
	"-path",
	"-ipath",
	"-wholename",
	"-iwholename",
	"-regex",
	"-iregex",
	"-lname",
	"-ilname",
	"-type",
	"-xtype",
	"-user",
	"-group",
	"-uid",
	"-gid",
	"-perm",
	"-size",
	"-mtime",
	"-atime",
	"-ctime",
	"-mmin",
	"-amin",
	"-cmin",
	"-newer",
	"-fstype",
	"-links",
	"-inum",
	"-samefile",
	"-used",
	"-maxdepth",
	"-mindepth",
	"-printf",
	"-fprint",
	"-fprint0",
	"-context",
]);

const FIND_EXEC_PRIMARIES: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** `find ... -delete` and `find ... -exec rm ...` remove whatever the expression matches under the start points. */
function findConsequence(args: ReadonlyArray<string>, cwdKnown: boolean): string | null {
	let index = 0;
	while (index < args.length) {
		const word = args[index];
		if (word === "-H" || word === "-L" || word === "-P" || /^-O\d?$/u.test(word ?? "")) index += 1;
		else if (word === "-D") index += 2;
		else break;
	}
	const roots: string[] = [];
	for (; index < args.length; index += 1) {
		const word = args[index];
		if (word === undefined || word.startsWith("-") || word === "(" || word === "!" || word === ",") break;
		roots.push(word);
	}
	let removes = false;
	for (; index < args.length; index += 1) {
		const word = args[index] ?? "";
		if (FIND_VALUE_PRIMARIES.has(word) || /^-newer[A-Za-z]{2}$/u.test(word)) {
			index += 1;
		} else if (FIND_EXEC_PRIMARIES.has(word)) {
			if (basenameOf(args[index + 1]) === "rm") removes = true;
			while (index < args.length && args[index] !== ";" && args[index] !== "+") index += 1;
		} else if (word === "-delete") {
			removes = true;
		}
	}
	if (!removes) return null;
	// With no start point find searches `.`, which a cd may have moved.
	if (roots.length === 0 && !cwdKnown) return null;
	return `Deletes what find matches under ${list(roots.length > 0 ? roots : [CURRENT_DIRECTORY])}`;
}

/** Options of GNU `xargs` that take the next word as their value. */
const XARGS_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"-a",
	"-d",
	"-E",
	"-I",
	"-L",
	"-n",
	"-P",
	"-s",
	"--arg-file",
	"--delimiter",
	"--max-args",
	"--max-procs",
	"--max-chars",
	"--max-lines",
]);

/** `xargs rm`: the paths come from standard input, so only the ones written on the command line are named. */
function xargsConsequence(args: ReadonlyArray<string>): string | null {
	let replacement: string | null = null;
	let index = 0;
	for (; index < args.length; index += 1) {
		const word = args[index];
		if (word === undefined || !word.startsWith("-")) break;
		if (word === "-I") replacement = args[index + 1] ?? null;
		if (word.startsWith("-i") || word.startsWith("--replace")) replacement = replacement ?? "{}";
		if (word.startsWith("-I") && word.length > 2) replacement = word.slice(2);
		if (XARGS_VALUE_OPTIONS.has(word)) index += 1;
	}
	if (basenameOf(args[index]) !== "rm") return null;
	const rmArgs = args.slice(index + 1);
	const fixed = operands(rmArgs).filter((path) => path !== replacement && path !== "{}");
	const what = fixed.length > 0 ? `${list(fixed)} and the paths xargs reads` : "the paths xargs reads";
	return `Deletes ${what}${hasFlag(rmArgs, "rR", ["--recursive"]) ? " recursively" : ""}`;
}

function basenameOf(word: string | undefined): string {
	return word === undefined ? "" : word.slice(word.lastIndexOf("/") + 1);
}

// ---------------------------------------------------------------------------
// Package installs
// ---------------------------------------------------------------------------

const NODE_INSTALL_VERBS: ReadonlySet<string> = new Set(["install", "i", "add", "ci"]);

const NODE_FILES: Readonly<Record<string, string>> = {
	npm: "package-lock.json",
	pnpm: "pnpm-lock.yaml",
	yarn: "yarn.lock",
	bun: "bun.lock",
};

const NODE_VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
	npm: new Set(["--prefix", "-C", "--workspace", "-w", "--registry", "--tag", "--cache"]),
	pnpm: new Set(["--dir", "-C", "--filter", "-F", "--registry", "--store-dir", "--reporter"]),
	yarn: new Set(["--cwd", "--registry", "--cache-folder", "--modules-folder", "--mutex"]),
	bun: new Set(["--cwd", "--registry", "--config", "-c", "--cache-dir"]),
};

function nodeInstallConsequence(manager: string, args: ReadonlyArray<string>): string | null {
	// Leading options (`npm --prefix x install`, `pnpm -C x add`) are skipped with
	// their values. `-w` takes a workspace name for npm but is pnpm's boolean
	// `--workspace-root`, so the sets differ by manager.
	const valueOptions = NODE_VALUE_OPTIONS[manager] ?? new Set<string>();
	const words = operands(args, valueOptions);
	// A bare `yarn` is `yarn install`.
	const verb = words[0] ?? (manager === "yarn" && args.length === 0 ? "install" : undefined);
	if (verb === undefined || !NODE_INSTALL_VERBS.has(verb)) return null;
	if (verb === "ci" && manager !== "npm") return null;
	const packages = words.slice(1);
	if (hasFlag(args, "g", ["--global"])) {
		return `Downloads packages${named(packages)} and changes the global ${manager} packages`;
	}
	if (verb === "ci") return "Downloads packages and changes node_modules";
	const lock = NODE_FILES[manager] ?? "the lockfile";
	const manifest = packages.length > 0 ? "package.json, " : "";
	return `Downloads packages${named(packages)} and changes ${manifest}${lock}, node_modules`;
}

/** Options of `pip install` and `uv pip install` that take their value as the next word. */
const PIP_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"-r",
	"--requirement",
	"-c",
	"--constraint",
	"-t",
	"--target",
	"-i",
	"--index-url",
	"--extra-index-url",
	"-f",
	"--find-links",
	"--proxy",
	"--cert",
	"--client-cert",
	"--timeout",
	"--retries",
	"--trusted-host",
	"--prefix",
	"--root",
	"--src",
	"--platform",
	"--python-version",
	"--implementation",
	"--abi",
	"--only-binary",
	"--no-binary",
	"--cache-dir",
	"--upgrade-strategy",
	"--python",
	"-p",
	"--override",
	"--index",
]);

/** The value of the first of `names` in `args`, as `--name value` or `--name=value`. */
function optionValue(args: ReadonlyArray<string>, names: ReadonlyArray<string>): string | null {
	for (let index = 0; index < args.length; index += 1) {
		const word = args[index] ?? "";
		if (names.includes(word)) return args[index + 1] ?? null;
		const equals = word.indexOf("=");
		if (word.startsWith("--") && equals > 0 && names.includes(word.slice(0, equals))) return word.slice(equals + 1);
	}
	return null;
}

/** Where a pip install lands: the directory `--target`, `--prefix` or `--root` names, else site-packages. */
function pipPlace(args: ReadonlyArray<string>): string {
	const dest = optionValue(args, ["-t", "--target"]) ?? optionValue(args, ["--prefix"]) ?? optionValue(args, ["--root"]);
	if (dest !== null) return shown(dest);
	return hasFlag(args, "", ["--user"]) ? "the user Python site-packages" : "the Python environment's site-packages";
}

function pipConsequence(args: ReadonlyArray<string>): string | null {
	if (args[0] !== "install") return null;
	const packages = operands(args.slice(1), PIP_VALUE_OPTIONS);
	const requirement = args.findIndex((word) => word === "-r" || word === "--requirement");
	const fromFile = requirement >= 0 && args[requirement + 1] !== undefined ? [`-r ${args[requirement + 1]}`] : [];
	return `Downloads packages${named([...fromFile, ...packages])} and changes ${pipPlace(args)}`;
}

function uvConsequence(args: ReadonlyArray<string>): string | null {
	const verb = args[0];
	if (verb === "add") {
		return `Downloads packages${named(operands(args.slice(1), new Set([...PIP_VALUE_OPTIONS, "--group", "--requirements", "--extra"])))} and changes pyproject.toml, uv.lock, .venv`;
	}
	if (verb === "sync") return "Downloads packages and changes uv.lock, .venv";
	if (verb === "pip" && args[1] === "install") {
		const packages = operands(args.slice(2), PIP_VALUE_OPTIONS);
		return `Downloads packages${named(packages)} and changes ${pipPlace(args)}`;
	}
	return null;
}
