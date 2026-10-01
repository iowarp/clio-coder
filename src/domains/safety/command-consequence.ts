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

/** Sentences shown before the rest collapse into `and N more`. */
export const COMMAND_CONSEQUENCE_MAX_LINES = 3;

/** Operands named in one sentence before the rest collapse into `and N more`. */
const MAX_OPERANDS_PER_LINE = 3;

/** Characters of one operand shown; a longer one is cut with an ellipsis. */
const MAX_OPERAND_CHARS = 48;

export type PathKind = "file" | "dir" | null;

export interface CommandConsequenceOptions {
	/**
	 * What exists at a path, resolved by the caller against the directory the
	 * command runs in. Absent when the caller cannot look (a worker describes
	 * its command before the host sees it), in which case no overwrite is
	 * claimed, because `>` and `cp` onto a new file overwrite nothing.
	 */
	pathKind?: (path: string) => PathKind;
}

/** The sentences for a command, capped at three and followed by `and N more` when there are more. */
function describeCommandConsequences(command: string, options: CommandConsequenceOptions = {}): string[] {
	const all: string[] = [];
	for (const step of shellCommandSteps(command)) {
		for (const line of stepConsequences(step, options)) {
			if (!all.includes(line)) all.push(line);
		}
	}
	if (all.length <= COMMAND_CONSEQUENCE_MAX_LINES) return all;
	const rest = all.length - COMMAND_CONSEQUENCE_MAX_LINES;
	return [...all.slice(0, COMMAND_CONSEQUENCE_MAX_LINES), `and ${rest} more`];
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

function stepConsequences(step: ShellCommandStep, options: CommandConsequenceOptions): string[] {
	const out: string[] = [];
	for (const target of step.truncatingRedirects) {
		if (options.pathKind?.(target) === "file") out.push(`Overwrites ${shown(target)}`);
	}
	const line = executableConsequence(step, options);
	if (line !== null) out.push(line);
	return out;
}

function executableConsequence(step: ShellCommandStep, options: CommandConsequenceOptions): string | null {
	const { executable, args } = step;
	switch (executable) {
		case "git":
			return gitConsequence(args);
		case "rm":
			return rmConsequence(args);
		case "mv":
		case "cp":
			return copyMoveConsequence(args, options);
		case "sed": {
			const files = sedInPlaceOperands(args);
			return files !== null && files.length > 0 ? `Edits ${list(files)} in place` : null;
		}
		case "truncate": {
			const files = operands(args, new Set(["-s", "--size", "-r", "--reference"]));
			return files.length > 0 ? `Edits ${list(files)} in place` : null;
		}
		case "chmod":
			return recursiveOwnerConsequence(args, "permissions");
		case "chown":
		case "chgrp":
			return recursiveOwnerConsequence(args, "ownership");
		case "kill":
			return killConsequence(args);
		case "pkill":
		case "killall":
			return killByNameConsequence(args);
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

/** One operand, redacted, collapsed to one line and bounded. `.` reads as the directory it is. */
function shown(value: string): string {
	if (value === "." || value === "./") return "the current directory";
	const clean = sanitizeCallTargetText(redactSecretString(value));
	if (clean.length === 0) return "(empty)";
	return clean.length <= MAX_OPERAND_CHARS ? clean : `${clean.slice(0, MAX_OPERAND_CHARS - 1)}…`;
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
	return `Deletes ${list(paths)}`;
}

/** The destination of a `cp` or `mv`, honoring `-t DIR` and `--target-directory`. */
function copyMoveConsequence(args: ReadonlyArray<string>, options: CommandConsequenceOptions): string | null {
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
			if (word === "-t" || word === "--target-directory") {
				targetDir = args[index + 1] ?? null;
				index += 1;
			} else if (word.startsWith("--target-directory=")) {
				targetDir = word.slice("--target-directory=".length);
			} else if (word === "-S" || word === "--suffix") {
				index += 1;
			}
			continue;
		}
		rest.push(word);
	}
	const sources = targetDir === null ? rest.slice(0, -1) : rest;
	const destination = targetDir ?? rest.at(-1);
	if (destination === undefined || sources.length === 0) return null;
	const kind = options.pathKind?.(destination) ?? null;
	if (kind === null) return null;
	if (kind === "file") return targetDir === null ? `Overwrites ${shown(destination)}` : null;
	// Into a directory, only a same-named entry already there is replaced.
	const replaced = sources
		.map((source) => joinPath(destination, baseName(source)))
		.filter((candidate) => options.pathKind?.(candidate) === "file");
	return replaced.length > 0 ? `Overwrites ${list(replaced)}` : null;
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

function gitConsequence(args: ReadonlyArray<string>): string | null {
	let repoDir: string | null = null;
	let index = 0;
	for (; index < args.length; index += 1) {
		const word = args[index];
		if (word === undefined) continue;
		if (!word.startsWith("-")) break;
		if (word === "-C") repoDir = args[index + 1] ?? null;
		if (GIT_GLOBAL_VALUE_OPTIONS.has(word)) index += 1;
	}
	const sub = args[index];
	if (sub === undefined) return null;
	const rest = args.slice(index + 1);
	const scope = repoDir !== null ? shown(repoDir) : "the workspace";
	switch (sub) {
		case "checkout":
			return gitCheckout(rest, scope);
		case "restore":
			return gitRestore(rest);
		case "reset":
			return hasFlag(rest, "", ["--hard"]) ? `Discards uncommitted changes in ${scope}` : null;
		case "clean":
			return gitClean(rest, scope);
		case "branch":
			return gitBranch(rest);
		case "stash":
			return gitStash(rest);
		case "rebase":
			return gitRebase(rest);
		case "commit":
			return hasFlag(rest, "", ["--amend"]) ? "Replaces the last commit" : null;
		case "tag":
			return hasFlag(rest, "d", ["--delete"]) ? gitDeleteNames("tag", operands(rest)) : null;
		case "push":
			return gitPush(rest);
		default:
			return null;
	}
}

function gitCheckout(args: ReadonlyArray<string>, scope: string): string | null {
	const dashDash = args.indexOf("--");
	if (dashDash >= 0) {
		const paths = args.slice(dashDash + 1);
		return paths.length > 0 ? `Discards uncommitted changes in ${list(paths)}` : null;
	}
	// `git checkout .` is the same discard without the separator.
	const words = operands(args);
	if (words.length === 1 && words[0] === ".") return `Discards uncommitted changes in ${scope}`;
	return null;
}

function gitRestore(args: ReadonlyArray<string>): string | null {
	const staged = hasFlag(args, "S", ["--staged"]);
	const worktree = hasFlag(args, "W", ["--worktree"]);
	if (staged && !worktree) return null;
	const dashDash = args.indexOf("--");
	const paths =
		dashDash >= 0
			? args.slice(dashDash + 1)
			: operands(args, new Set(["-s", "--source", "-p", "--patch", "--pathspec-from-file"]));
	return paths.length > 0 ? `Discards uncommitted changes in ${list(paths)}` : null;
}

function gitClean(args: ReadonlyArray<string>, scope: string): string | null {
	if (!hasFlag(args, "f", ["--force"])) return null;
	if (hasFlag(args, "n", ["--dry-run"])) return null;
	const paths = operands(args, new Set(["-e", "--exclude"]));
	const where = paths.length > 0 ? list(paths) : scope;
	if (hasFlag(args, "x")) return `Deletes untracked and ignored files in ${where}`;
	if (hasFlag(args, "X")) return `Deletes ignored files in ${where}`;
	return `Deletes untracked files in ${where}`;
}

function gitDeleteNames(kind: "branch" | "tag", names: ReadonlyArray<string>): string | null {
	if (names.length === 0) return null;
	return `Deletes ${kind}${names.length > 1 ? (kind === "branch" ? "es" : "s") : ""} ${list(names)}`;
}

function gitBranch(args: ReadonlyArray<string>): string | null {
	if (!hasFlag(args, "dD", ["--delete"])) return null;
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
	if (
		["--abort", "--continue", "--skip", "--quit", "--edit-todo", "--show-current-patch"].some((w) => args.includes(w))
	) {
		return null;
	}
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

function gitPush(args: ReadonlyArray<string>): string | null {
	if (hasFlag(args, "n", ["--dry-run"])) return null;
	const words = operands(args, GIT_PUSH_VALUE_OPTIONS);
	const remote = words[0];
	if (hasFlag(args, "d", ["--delete"]) && words.length > 1) {
		return `Deletes ${list(words.slice(1))} on ${shown(remote ?? "the remote")}`;
	}
	const target = remote === undefined ? "the upstream remote" : shown(remote);
	const force = hasFlag(args, "f", ["--force", "--force-with-lease", "--force-if-includes"]);
	return force ? `Publishes to ${target} and overwrites its history` : `Publishes to ${target}`;
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

function killConsequence(args: ReadonlyArray<string>): string | null {
	if (hasFlag(args, "l", ["--list", "--table"]) || args.includes("-L")) return null;
	// Signal 0 only tests whether the process exists.
	if (args.includes("-0") || args.some((word, i) => word === "-s" && args[i + 1] === "0")) return null;
	const pids = operands(args, new Set(["-s", "-n", "--signal"]));
	return pids.length > 0 ? `Stops processes ${list(pids)}` : null;
}

function killByNameConsequence(args: ReadonlyArray<string>): string | null {
	if (args.includes("-0")) return null;
	const valueOptions = new Set([
		"-u",
		"-U",
		"-g",
		"-G",
		"-P",
		"-s",
		"-t",
		"-F",
		"-c",
		"--signal",
		"--euid",
		"--uid",
		"--pgroup",
		"--group",
		"--parent",
		"--session",
		"--terminal",
		"--pidfile",
		"--ns",
		"--nslist",
	]);
	// `-9` and `-HUP` are signals, which operands() already skips as options.
	const names = operands(args, valueOptions);
	return names.length > 0 ? `Stops processes ${list(names)}` : null;
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

function nodeInstallConsequence(manager: string, args: ReadonlyArray<string>): string | null {
	// Leading options (`npm --prefix x install`, `pnpm -C x add`) are skipped with their values.
	const valueOptions = new Set([
		"--prefix",
		"-C",
		"--dir",
		"--cwd",
		"-w",
		"--workspace",
		"--filter",
		"-F",
		"--registry",
		"--tag",
		"--cache",
	]);
	const words = operands(args, valueOptions);
	const verb = words[0];
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

function pipConsequence(args: ReadonlyArray<string>): string | null {
	if (args[0] !== "install") return null;
	const packages = operands(args.slice(1), new Set(["-r", "--requirement", "-c", "--constraint", "-t", "--target"]));
	const requirement = args.findIndex((word) => word === "-r" || word === "--requirement");
	const fromFile = requirement >= 0 && args[requirement + 1] !== undefined ? [`-r ${args[requirement + 1]}`] : [];
	const place = hasFlag(args, "", ["--user"])
		? "the user Python site-packages"
		: "the Python environment's site-packages";
	return `Downloads packages${named([...fromFile, ...packages])} and changes ${place}`;
}

function uvConsequence(args: ReadonlyArray<string>): string | null {
	const verb = args[0];
	if (verb === "add") {
		return `Downloads packages${named(operands(args.slice(1), new Set(["--group", "--index", "-r", "--requirements"])))} and changes pyproject.toml, uv.lock, .venv`;
	}
	if (verb === "sync") return "Downloads packages and changes uv.lock, .venv";
	if (verb === "pip" && args[1] === "install") {
		const packages = operands(args.slice(2), new Set(["-r", "--requirement", "-c", "--constraint", "-p", "--python"]));
		return `Downloads packages${named(packages)} and changes the Python environment's site-packages`;
	}
	return null;
}
