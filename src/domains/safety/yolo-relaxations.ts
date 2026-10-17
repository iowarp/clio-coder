import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { canonicalizeRawPath } from "../../core/path-canonical.js";
import { isSameOrDescendant } from "./path-policy.js";
import { type ShellCommandStep, shellCommandSteps } from "./protected-artifacts.js";

/**
 * Command readings the operator's yolo uses to relax a flag rule for one call
 * (#419). Each answers for the commands it parsed; the policy engine checks
 * that every textual match of the rule is one of them, so a command this
 * parser cannot see keeps the rule.
 */

/** Commands that move the shell, after which a relative operand cannot be placed from the call's cwd. */
export const SHELL_MOVES: ReadonlySet<string> = new Set(["cd", "pushd", "popd"]);

/** The parsed steps of `command` that run `executable`, or null when a step moves the shell. */
function stepsOf(command: string, executables: ReadonlySet<string>): ShellCommandStep[] | null {
	const steps = shellCommandSteps(command, homedir());
	if (steps.some((step) => SHELL_MOVES.has(step.executable))) return null;
	return steps.filter((step) => executables.has(step.executable));
}

/** True when every operand names a fixed path inside the workspace or a scratch root. */
function operandsInside(
	operands: ReadonlyArray<string>,
	callCwd: string,
	workspace: string,
	scratchRoots: ReadonlyArray<string>,
): boolean {
	return (
		operands.length > 0 &&
		operands.every((operand) => {
			if (/[$`*?[{]/u.test(operand)) return false;
			const resolved = canonicalizeRawPath(operand, callCwd);
			if (resolved === null) return false;
			return [workspace, ...scratchRoots].some((root) => isSameOrDescendant(resolved, root));
		})
	);
}

/** Files a `truncate` step names, its size and reference values skipped. */
function truncateOperands(args: ReadonlyArray<string>): string[] {
	const operands: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const word = args[index] ?? "";
		if (["-s", "--size", "-r", "--reference"].includes(word)) index += 1;
		else if (!word.startsWith("-")) operands.push(word);
	}
	return operands;
}

/**
 * `truncate -s 0 f` and `: > f` under the operator's yolo: how many such steps
 * were read, and whether each empties only files inside the workspace or a
 * scratch root. Null when the command cannot be read that way.
 */
export function truncationsInside(
	command: string,
	callCwd: string,
	workspace: string,
	scratchRoots: ReadonlyArray<string>,
): number | null {
	const steps = stepsOf(command, new Set(["truncate", ":"]));
	if (steps === null) return null;
	for (const step of steps) {
		const operands = step.executable === "truncate" ? truncateOperands(step.args) : step.truncatingRedirects;
		if (!operandsInside(operands, callCwd, workspace, scratchRoots)) return null;
	}
	return steps.length;
}

/**
 * Non-recursive `chmod 777` steps under the operator's yolo whose targets all
 * lie inside the workspace or a scratch root; null when any step is recursive,
 * names another mode, or reaches elsewhere.
 */
export function worldWritableModesInside(
	command: string,
	callCwd: string,
	workspace: string,
	scratchRoots: ReadonlyArray<string>,
): number | null {
	const steps = stepsOf(command, new Set(["chmod"]));
	if (steps === null) return null;
	let counted = 0;
	for (const step of steps) {
		if (step.args.some((word) => word === "--recursive" || /^-[^-]*R/u.test(word))) return null;
		const words = step.args.filter((word) => !word.startsWith("-"));
		if (words[0] !== "777") continue;
		if (!operandsInside(words.slice(1), callCwd, workspace, scratchRoots)) return null;
		counted += 1;
	}
	return counted;
}

/** Options that take a value in the next word, per command; pkill's `-n` and `-o` are flags. */
const KILL_VALUE_OPTIONS: Readonly<Record<"pkill" | "killall", ReadonlySet<string>>> = {
	pkill: new Set(["-g", "-G", "-P", "-s", "-t", "-u", "-U", "-F", "--signal", "--pidfile", "--ns", "--nslist"]),
	killall: new Set([
		"-s",
		"-u",
		"-o",
		"-y",
		"-n",
		"-Z",
		"--signal",
		"--user",
		"--older-than",
		"--younger-than",
		"--ns",
		"--context",
	]),
};

/** `-9`, `-KILL`, `-SIGKILL`: a signal word, never a flag cluster such as killall's `-I`. */
const SIGNAL_WORD = /^-(?:\d+|(?:SIG)?(?:KILL|TERM|HUP|INT|QUIT|ABRT|USR1|USR2|STOP|CONT|ALRM))$/u;

/** What pkill and killall would match a process by: its names, and its command line for `pkill -f`. */
interface KillMatchTargets {
	names: string[];
	commandLines: string[];
}

/** Far past any real process tree; a cycle or a runaway read stops here. */
const ANCESTOR_WALK_LIMIT = 64;

/**
 * This Clio process, every ancestor up to PID 1 (the shell, a multiplexer such
 * as herdr or tmux, the terminal) and PID 1 itself, read from /proc. Null where
 * /proc cannot be read, which keeps every forced kill blocked there (#419).
 */
function protectedKillTargets(): KillMatchTargets | null {
	const names = new Set([process.title, path.basename(process.execPath), path.basename(process.argv[1] ?? "")]);
	const commandLines = new Set([process.argv.join(" ")]);
	const read = (pid: string): number | null => {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const open = stat.indexOf("(");
		const close = stat.lastIndexOf(")");
		names.add(stat.slice(open + 1, close));
		const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8")
			.split("\0")
			.filter((word) => word.length > 0);
		if (argv.length > 0) {
			commandLines.add(argv.join(" "));
			names.add(path.basename(argv[0] ?? ""));
		}
		// The comm field may hold spaces and parentheses; the ppid follows the last `)` and the state.
		const ppid = Number(stat.slice(close + 2).split(" ")[1]);
		return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
	};
	try {
		let pid: number | null = read("self");
		let reachedInit = false;
		for (let step = 0; pid !== null && step < ANCESTOR_WALK_LIMIT; step += 1) {
			if (pid === 1) reachedInit = true;
			pid = read(String(pid));
			if (reachedInit) break;
		}
		if (!reachedInit) read("1");
	} catch {
		// No /proc (macOS, Windows) or an ancestor that cannot be read: refuse
		// to guess, so the caller keeps the block.
		return null;
	}
	return {
		names: [...names].filter((name) => name.length > 0),
		commandLines: [...commandLines].filter((line) => line.length > 0),
	};
}

/** Why one `pkill -9` or `killall -9` step may not run under yolo, or null when it targets a named process. */
function forcedKillProblem(step: ShellCommandStep, guarded: KillMatchTargets): string | null {
	const valueOptions = KILL_VALUE_OPTIONS[step.executable === "pkill" ? "pkill" : "killall"];
	const patterns: string[] = [];
	let fullCommandLine = false;
	let exact = false;
	let ignoreCase = false;
	let regex = step.executable === "pkill";
	for (let index = 0; index < step.args.length; index += 1) {
		const word = step.args[index] ?? "";
		if (valueOptions.has(word)) {
			index += 1;
			continue;
		}
		if (word.startsWith("--")) {
			if (word === "--full") fullCommandLine = true;
			else if (word === "--exact") exact = true;
			else if (word === "--ignore-case") ignoreCase = true;
			else if (word === "--regexp") regex = true;
			continue;
		}
		if (word.startsWith("-") && word.length > 1) {
			if (SIGNAL_WORD.test(word)) continue;
			const letters = word.slice(1);
			if (step.executable === "pkill") {
				if (letters.includes("f")) fullCommandLine = true;
				if (letters.includes("x")) exact = true;
				if (letters.includes("i")) ignoreCase = true;
			} else {
				if (letters.includes("r")) regex = true;
				if (letters.includes("I")) ignoreCase = true;
			}
			continue;
		}
		patterns.push(word);
	}
	// pkill takes one pattern; without one (`pkill -9 -u me`) it kills every
	// process the selectors leave, and killall with no name kills nothing.
	if (patterns.length === 0 || (step.executable === "pkill" && patterns.length !== 1)) {
		return "no named target";
	}
	const own = fullCommandLine ? guarded.commandLines : guarded.names;
	for (const pattern of patterns) {
		if (pattern.length === 0) return "an empty pattern";
		if (!regex) {
			if (own.some((name) => (ignoreCase ? name.toLowerCase() === pattern.toLowerCase() : name === pattern)))
				return `'${pattern}' names this Clio process, an ancestor or PID 1`;
			continue;
		}
		let matcher: RegExp;
		try {
			matcher = new RegExp(exact ? `^(?:${pattern})$` : pattern, ignoreCase ? "iu" : "u");
		} catch {
			return `'${pattern}' cannot be read as a pattern`;
		}
		if (matcher.test("")) return `'${pattern}' matches every process`;
		if (own.some((name) => matcher.test(name))) return `'${pattern}' matches this Clio process, an ancestor or PID 1`;
	}
	return null;
}

/**
 * `pkill -9` and `killall -9` steps under the operator's yolo: how many were
 * read, when each names a target other than this Clio process, its ancestors
 * and PID 1. Null when any step has no target, a wildcard pattern, or one that
 * matches a guarded process (by name, or by command line under `pkill -f`),
 * and wherever the process tree cannot be read.
 */
export function namedForcedKills(command: string): number | null {
	const steps = shellCommandSteps(command, homedir()).filter(
		(step) => (step.executable === "pkill" || step.executable === "killall") && step.args.includes("-9"),
	);
	if (steps.length === 0) return 0;
	const guarded = protectedKillTargets();
	return guarded !== null && steps.every((step) => forcedKillProblem(step, guarded) === null) ? steps.length : null;
}

/** find's link-following options: `-L` and `-H`, alone or clustered, and the `-follow` expression. */
function followsLinks(word: string): boolean {
	return word === "-follow" || /^-[HLP]*[HL][HLP]*$/u.test(word);
}

/**
 * `find -delete` steps under the operator's yolo: how many were read, or null
 * when any find in the command follows links (#419). The words are the ones
 * the shell passes, so `"-L"`, `-fol''low` and `\-follow` count as well.
 */
export function findDeletesNotFollowing(command: string): number | null {
	const finds = shellCommandSteps(command, homedir()).filter((step) => step.executable === "find");
	if (finds.some((step) => step.args.some(followsLinks))) return null;
	return finds.filter((step) => step.args.includes("-delete")).length;
}

/**
 * Every `rm` step's absolute operands, home references expanded, and how many
 * steps were read (#419). Null when such an operand is named at run time.
 */
export function removedAbsolutePaths(command: string): { steps: number; paths: string[] } | null {
	const steps = shellCommandSteps(command, homedir()).filter((step) => step.executable === "rm");
	const paths: string[] = [];
	for (const step of steps) {
		let options = true;
		for (const word of step.args) {
			if (options && word === "--") options = false;
			else if (options && word.startsWith("-")) continue;
			else if (word.startsWith("/")) {
				if (/[$`]/u.test(word)) return null;
				paths.push(word);
			}
		}
	}
	return { steps: steps.length, paths };
}

/** A URL's last path segment, which `curl -O` and a bare `wget` save to. */
function urlFileName(url: string): string | null {
	const name = path.posix.basename(url.replace(/[?#].*$/u, "").replace(/^[a-z][\w+.-]*:\/\/[^/]*/iu, ""));
	return name === "" || name === "/" ? null : name;
}

/**
 * Files the `curl` and `wget` steps of a command save to: `-o`, `--output`,
 * `-O` and `--output-document` values, and a URL's last segment where the
 * tool names the file itself (#419). A misread option value only adds a name.
 */
export function downloadedFiles(command: string): string[] {
	const files: string[] = [];
	for (const step of shellCommandSteps(command, homedir())) {
		if (step.executable !== "curl" && step.executable !== "wget") continue;
		const curl = step.executable === "curl";
		let remoteNames = !curl;
		for (let index = 0; index < step.args.length; index += 1) {
			const arg = step.args[index] ?? "";
			const long = /^--(output|output-document|remote-name|remote-name-all)(?:=(.*))?$/su.exec(arg);
			if (long !== null) {
				if (long[1]?.startsWith("remote") === true) remoteNames = true;
				else {
					const value = long[2] ?? step.args[++index];
					if (value !== undefined) files.push(value);
					if (!curl) remoteNames = false;
				}
				continue;
			}
			if (!/^-[A-Za-z0-9]+/u.test(arg)) continue;
			for (let at = 1; at < arg.length; at += 1) {
				if (arg[at] === (curl ? "o" : "O")) {
					const value = arg.slice(at + 1) || step.args[++index];
					if (value !== undefined) files.push(value);
					if (!curl) remoteNames = false;
					break;
				}
				if (curl && arg[at] === "O") remoteNames = true;
			}
		}
		if (!remoteNames) continue;
		for (const arg of step.args) {
			const name = /^[a-z][\w+.-]*:\/\//iu.test(arg) ? urlFileName(arg) : null;
			if (name !== null) files.push(name);
		}
	}
	return files;
}

/**
 * Where a step lays down files it does not name one by one: a directory tree,
 * or the git work tree that holds a directory.
 */
export interface UnpackedTarget {
	path: string;
	scope: "tree" | "repository";
}

/** scp options that take the next word. */
const SCP_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-P", "-i", "-o", "-F", "-l", "-c", "-J", "-S"]);

/** git clone options that take the next word. */
const GIT_CLONE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"-b",
	"--branch",
	"-o",
	"--origin",
	"-c",
	"--config",
	"--depth",
	"-j",
	"--jobs",
	"--reference",
	"--separate-git-dir",
	"--filter",
	"--template",
	"-u",
	"--upload-pack",
]);

/** A short-option cluster's value for `letter`: the rest of the cluster or the next word. */
function clusterValue(args: ReadonlyArray<string>, index: number, letter: string): { value?: string; next: number } {
	const arg = args[index] ?? "";
	if (!/^-[A-Za-z]+/u.test(arg) || arg.startsWith("--")) return { next: index };
	const at = arg.indexOf(letter, 1);
	if (at < 0) return { next: index };
	const rest = arg.slice(at + 1);
	if (rest !== "") return { value: rest, next: index };
	const value = args[index + 1];
	return value === undefined ? { next: index } : { value, next: index + 1 };
}

function tarTargets(args: ReadonlyArray<string>): UnpackedTarget[] {
	const extracts =
		args.some((arg) => arg === "--extract" || arg === "--get" || /^-[A-Za-z]*x/u.test(arg)) ||
		/^[A-Za-z]*x[A-Za-z]*$/u.test(args[0] ?? "");
	if (!extracts) return [];
	const dirs: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		const long = /^--directory(?:=(.*))?$/su.exec(arg);
		if (long !== null) {
			const value = long[1] ?? args[++index];
			if (value !== undefined) dirs.push(value);
			continue;
		}
		if (arg.includes("C")) {
			const found = clusterValue(args, index, "C");
			if (found.value !== undefined) dirs.push(found.value);
			index = found.next;
		}
	}
	return (dirs.length > 0 ? dirs : ["."]).map((dir) => ({ path: dir, scope: "tree" }));
}

function unzipTargets(args: ReadonlyArray<string>): UnpackedTarget[] {
	const dirs: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		if (!(args[index] ?? "").includes("d")) continue;
		const found = clusterValue(args, index, "d");
		if (found.value !== undefined) dirs.push(found.value);
		index = found.next;
	}
	return (dirs.length > 0 ? dirs : ["."]).map((dir) => ({ path: dir, scope: "tree" }));
}

function gitTargets(args: ReadonlyArray<string>): UnpackedTarget[] {
	let base = ".";
	let workTree: string | null = null;
	let index = 0;
	for (; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "-C") {
			const dir = args[++index] ?? ".";
			base = dir.startsWith("/") ? dir : path.posix.join(base, dir);
		} else if (arg === "-c" || arg === "--git-dir" || arg === "--namespace") index += 1;
		else if (arg.startsWith("--work-tree=")) workTree = arg.slice("--work-tree=".length);
		else if (arg === "--work-tree") workTree = args[++index] ?? null;
		else if (!arg.startsWith("-")) break;
	}
	const subcommand = args[index];
	const at = (target: string) => (target.startsWith("/") ? target : path.posix.join(base, target));
	if (subcommand === "clone") {
		const operands: string[] = [];
		for (let next = index + 1; next < args.length; next += 1) {
			const arg = args[next] ?? "";
			if (GIT_CLONE_VALUE_OPTIONS.has(arg)) next += 1;
			else if (arg === "--") continue;
			else if (!arg.startsWith("-")) operands.push(arg);
		}
		const named = operands[1];
		const fromRepository = path.posix.basename((operands[0] ?? "").replace(/\/+$/u, "")).replace(/\.git$/u, "");
		return [named, fromRepository]
			.filter((target): target is string => target !== undefined && target !== "")
			.map((target) => ({ path: at(target), scope: "tree" }));
	}
	if (subcommand === undefined || gitLeavesWorktree(subcommand, args.slice(index + 1))) return [];
	return [workTree !== null ? { path: at(workTree), scope: "tree" } : { path: base, scope: "repository" }];
}

/** Git subcommands that only read: they never write the worktree. */
const GIT_READ_ONLY: ReadonlySet<string> = new Set([
	"status",
	"log",
	"diff",
	"show",
	"rev-parse",
	"rev-list",
	"ls-files",
	"ls-tree",
	"cat-file",
	"blame",
	"grep",
	"describe",
	"shortlog",
	"show-ref",
	"for-each-ref",
	"merge-base",
	"version",
]);

/** The words after `branch`, `tag`, `remote`, `stash` or `config` that only list or read. */
const GIT_LISTING_ARGS: Readonly<Record<string, RegExp>> = {
	branch: /^(?:-[arv]+|-vv|--all|--remotes|--verbose|--list|-l|--show-current|--no-color)$/u,
	tag: /^(?:-l|--list|-n\d*)$/u,
	remote: /^(?:-v|--verbose|show|get-url)$/u,
	stash: /^(?:list|show)$/u,
	config: /^(?:--get(?:-all|-regexp)?|--list|-l)$/u,
};

/**
 * True when a git subcommand cannot change the worktree (#419). Anything
 * else (switch, merge, rebase, am, apply, stash pop, cherry-pick, reset, an
 * alias) may rewrite a script the same command runs next. `--output` writes
 * a file from the reading ones too.
 */
function gitLeavesWorktree(subcommand: string, rest: ReadonlyArray<string>): boolean {
	if (rest.some((arg) => arg.startsWith("--output"))) return false;
	if (GIT_READ_ONLY.has(subcommand)) return true;
	const listing = GIT_LISTING_ARGS[subcommand];
	if (listing === undefined) return false;
	// `stash`, `remote` and `config` read only when their first word says so.
	if (subcommand === "stash" || subcommand === "config") return listing.test(rest[0] ?? "");
	if (subcommand === "remote") return rest.length === 0 || listing.test(rest[0] ?? "");
	return rest.every((arg) => listing.test(arg));
}

/** `patch` writes the files its diff names, from `-d DIR` or the current directory, anywhere in that repository. */
function patchTargets(args: ReadonlyArray<string>): UnpackedTarget[] {
	let dir = ".";
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		const long = /^--directory(?:=(.*))?$/su.exec(arg);
		if (long !== null) dir = long[1] ?? args[++index] ?? dir;
		else if (arg === "-d") dir = args[++index] ?? dir;
		else if (/^-d./u.test(arg)) dir = arg.slice(2);
	}
	return [{ path: dir, scope: "repository" }];
}

/** Every local operand of an scp or rsync step; a misread option value only adds a tree. */
function copyTargets(executable: string, args: ReadonlyArray<string>): UnpackedTarget[] {
	const targets: UnpackedTarget[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (executable === "scp" && SCP_VALUE_OPTIONS.has(arg)) index += 1;
		else if (executable === "rsync" && (arg === "-e" || arg === "--rsh")) index += 1;
		else if (!arg.startsWith("-") && !/^[^/]*:/u.test(arg)) targets.push({ path: arg, scope: "tree" });
	}
	return targets;
}

/**
 * Trees that `tar` extraction, `unzip`, `git clone` or any git subcommand
 * that can change the worktree, `patch`, `scp` and `rsync` steps of a command
 * may write (#419). A script under one may be replaced before it runs.
 */
export function unpackedTargets(command: string): UnpackedTarget[] {
	const targets: UnpackedTarget[] = [];
	for (const step of shellCommandSteps(command, homedir())) {
		if (step.executable === "tar" || step.executable === "bsdtar" || step.executable === "gtar")
			targets.push(...tarTargets(step.args));
		else if (step.executable === "unzip") targets.push(...unzipTargets(step.args));
		else if (step.executable === "git") targets.push(...gitTargets(step.args));
		else if (step.executable === "patch") targets.push(...patchTargets(step.args));
		else if (step.executable === "scp" || step.executable === "rsync")
			targets.push(...copyTargets(step.executable, step.args));
	}
	return targets;
}
