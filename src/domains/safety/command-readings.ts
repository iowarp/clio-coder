import { homedir } from "node:os";
import path from "node:path";
import { shellCommandSteps } from "./protected-artifacts.js";

/**
 * Command readings the policy engine judges a shell command by beyond its
 * text (#419). The delete readings let the operator's default run a delete
 * the workspace snapshot undoes; each answers for the commands it parsed, and
 * the engine checks that every textual match of the rule is one of them, so a
 * command this parser cannot see keeps the rule. The write readings tell the
 * floor's script scan which files a command produces before a later script
 * runs.
 */

/** Commands that move the shell, after which a relative operand cannot be placed from the call's cwd. */
export const SHELL_MOVES: ReadonlySet<string> = new Set(["cd", "pushd", "popd"]);

/** find's link-following options: `-L` and `-H`, alone or clustered, and the `-follow` expression. */
function followsLinks(word: string): boolean {
	return word === "-follow" || /^-[HLP]*[HL][HLP]*$/u.test(word);
}

/**
 * `find -delete` steps: how many were read, or null when any find in the
 * command follows links (#419). The words are the ones
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
