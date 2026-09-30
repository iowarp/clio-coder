import { classify } from "./action-classifier.js";
import { gitCommandArgv } from "./git-command-normalization.js";
import { scanShellLike, scanShellLikeDeep } from "./protected-artifacts.js";

/**
 * The one Git classifier (Codex review, "Task-worktree Git contract"). Bash
 * parsing and the typed git tool both reduce a call to the argv Git reads
 * after its executable and classify that argv here, so the same argv reaches
 * the same verdict whichever surface carried it.
 *
 * Classes, least to most consequential:
 *   inspect               reads repository state and invokes no configured helper;
 *   task-mutation         the narrow set a worker may run in its owned, attested
 *                         task worktree: `add` of literal paths and an ordinary
 *                         `commit -m` on the current branch;
 *   other-local-mutation  every other local change, and every form this module
 *                         does not recognize (unknown fails conservative);
 *   outward               reaches or reconfigures a remote;
 *   destructive           the existing damage-control hard blocks, unchanged.
 *
 * Only the class is decided here. Who may run which class is the admission
 * evaluator's business.
 */

export type GitCommandClass = "inspect" | "task-mutation" | "other-local-mutation" | "outward" | "destructive";

export interface GitArgvVerdict {
	class: GitCommandClass;
	/** The Git subcommand, or null when the argv names none. */
	subcommand: string | null;
	reason: string;
}

const SEVERITY: Readonly<Record<GitCommandClass, number>> = {
	inspect: 0,
	"task-mutation": 1,
	"other-local-mutation": 2,
	outward: 3,
	destructive: 4,
};

/**
 * Global options that change nothing a verdict depends on. Every other global
 * option can name another repository, working tree, configuration, executable
 * directory, namespace or pager, so it lifts the verdict to at least
 * other-local-mutation: `-C`, `-c` (core.hooksPath among others), `--git-dir`,
 * `--work-tree`, `--exec-path`, `--namespace`, `--config-env`, `-p`.
 */
const NEUTRAL_GLOBAL_OPTIONS = new Set([
	"--no-pager",
	"-P",
	"--no-optional-locks",
	"--no-replace-objects",
	"--literal-pathspecs",
	"--no-advice",
]);
/** Global options Git reads with a separate value word. */
const GLOBAL_VALUE_OPTIONS = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--config-env",
	"--super-prefix",
	"--exec-path",
	"--attr-source",
]);

/** Subcommands that only read. Helper-invoking flags still lift them (see {@link HELPER_FLAG}). */
const INSPECT_SUBCOMMANDS = new Set([
	"status",
	"diff",
	"log",
	"show",
	"rev-parse",
	"rev-list",
	"ls-files",
	"ls-tree",
	"cat-file",
	"blame",
	"annotate",
	"shortlog",
	"describe",
	"grep",
	"show-ref",
	"merge-base",
	"name-rev",
	"whatchanged",
	"show-branch",
	"for-each-ref",
	"count-objects",
	"check-ignore",
	"check-attr",
	"check-ref-format",
	"diff-tree",
	"diff-files",
	"diff-index",
	"range-diff",
	"cherry",
	"var",
	"help",
	"version",
]);

/** Subcommands that reach a remote or change where one is. */
const OUTWARD_SUBCOMMANDS = new Set([
	"push",
	"fetch",
	"pull",
	"clone",
	"ls-remote",
	"send-email",
	"send-pack",
	"fetch-pack",
	"request-pull",
	"svn",
	"p4",
	"cvsimport",
	"cvsexportcommit",
	"lfs",
]);

/**
 * Flags that make an otherwise read-only command run a configured helper
 * (external diff, text conversion, a pager, a signature verifier), write a
 * file, or read outside the repository.
 */
const HELPER_FLAG =
	/^(?:--ext-diff|--textconv|--filters|--show-signature|--output(?:=|$)|--open-files-in-pager(?:=|$)|-O|--no-index$|--contents(?:=|$)|--upload-pack|--exec(?:=|$))/u;

/** Options `add` accepts in the task set; paths follow `--`. */
const TASK_ADD_OPTIONS = new Set(["-A", "--all", "-u", "--update"]);
/** Flags `commit` accepts in the task set besides its message. */
const TASK_COMMIT_FLAGS = new Set(["-a", "--all", "-q", "--quiet", "-s", "--signoff"]);

/**
 * Why a pathspec is not a literal path inside the working tree, or null when
 * it is one. Magic (`:(...)`, `:/`), globs, brace and variable expansion,
 * absolute paths and `..` segments are refused: each can name more, or other,
 * files than the words say.
 */
export function literalGitPathError(path: string): string | null {
	if (path.length === 0) return "an empty path";
	if (/[\0\r\n]/u.test(path)) return `path ${JSON.stringify(path)} contains a control character`;
	if (path.startsWith(":")) return `path ${JSON.stringify(path)} is a magic pathspec`;
	if (/[*?[\]{}$`\\]/u.test(path)) return `path ${JSON.stringify(path)} contains a glob or expansion character`;
	if (path.startsWith("~")) return `path ${JSON.stringify(path)} starts with ~`;
	if (path.startsWith("/") || /^[A-Za-z]:/u.test(path)) return `path ${JSON.stringify(path)} is absolute`;
	if (path.split("/").includes("..")) return `path ${JSON.stringify(path)} leaves the working tree`;
	return null;
}

function literalPathsError(paths: ReadonlyArray<string>): string | null {
	for (const path of paths) {
		const error = literalGitPathError(path);
		if (error !== null) return error;
	}
	return null;
}

/** Null when `add <args>` is in the task set, else why not. */
function taskAddError(args: ReadonlyArray<string>): string | null {
	const separator = args.indexOf("--");
	const options = separator === -1 ? args : args.slice(0, separator);
	const paths = separator === -1 ? [] : args.slice(separator + 1);
	for (const option of options) {
		if (!option.startsWith("-")) return `git add names path ${JSON.stringify(option)} before --; literal paths follow --`;
		if (!TASK_ADD_OPTIONS.has(option)) return `git add option ${option} is outside the task set`;
	}
	if (paths.length === 0 && options.length === 0) return "git add names no path";
	return literalPathsError(paths);
}

/** Null when `commit <args>` is an ordinary message commit on the current branch, else why not. */
function taskCommitError(args: ReadonlyArray<string>): string | null {
	let messages = 0;
	for (let index = 0; index < args.length; index += 1) {
		const word = args[index] ?? "";
		if (word === "-m" || word === "--message") {
			if (index + 1 >= args.length) return `git commit ${word} has no message`;
			messages += 1;
			index += 1;
			continue;
		}
		if (word.startsWith("--message=")) {
			messages += 1;
			continue;
		}
		if (TASK_COMMIT_FLAGS.has(word)) continue;
		// A short bundle of task flags, optionally ending in m with its message
		// attached (`-am"msg"`) or in the next word (`-am msg`).
		const bundle = /^-([aqs]*)(m?)(.*)$/u.exec(word);
		if (bundle !== null && word.length > 1 && !word.startsWith("--") && (bundle[1] !== "" || bundle[2] !== "")) {
			if (bundle[2] === "m") {
				messages += 1;
				if (bundle[3] === "") {
					if (index + 1 >= args.length) return `git commit ${word} has no message`;
					index += 1;
				}
				continue;
			}
			if (bundle[3] === "") continue;
		}
		if (word === "--") return "git commit of named paths is outside the task set";
		if (!word.startsWith("-")) return `git commit names path ${JSON.stringify(word)}; the task set commits the index`;
		// --amend, --no-verify, -F/--file, -C/-c, --fixup, --squash, -S, --author,
		// --date, -e and every other option change what is committed, where the
		// message comes from, or whether hooks and helpers run.
		return `git commit option ${word} is outside the task set`;
	}
	if (messages === 0) return "git commit without -m would open an editor";
	return null;
}

function everyArgIn(args: ReadonlyArray<string>, allowed: ReadonlyArray<string>): boolean {
	return args.every((arg) => allowed.includes(arg));
}

function subcommandClass(subcommand: string, args: ReadonlyArray<string>): { class: GitCommandClass; reason: string } {
	const other = (reason: string) => ({ class: "other-local-mutation" as const, reason });
	if (OUTWARD_SUBCOMMANDS.has(subcommand)) return { class: "outward", reason: `git ${subcommand} reaches a remote` };
	if (subcommand === "add") {
		const error = taskAddError(args);
		return error === null
			? { class: "task-mutation", reason: "git add of literal paths" }
			: other(`${error}; only git add [-A|-u] -- <literal paths> is in the task set`);
	}
	if (subcommand === "commit") {
		const error = taskCommitError(args);
		return error === null
			? { class: "task-mutation", reason: "git commit -m on the current branch" }
			: other(`${error}; only git commit -m <message> is in the task set`);
	}
	const helper = args.find((arg) => HELPER_FLAG.test(arg));
	const inspect = (reason: string) =>
		helper === undefined
			? { class: "inspect" as const, reason }
			: other(`git ${subcommand} ${helper} runs a configured helper, writes a file, or reads outside the repository`);
	if (INSPECT_SUBCOMMANDS.has(subcommand)) return inspect(`git ${subcommand} reads repository state`);
	switch (subcommand) {
		case "branch":
			if (everyArgIn(args, ["-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--list", "-l", "--show-current"]))
				return inspect("git branch lists branches");
			break;
		case "tag":
			if (
				args.length === 0 ||
				((args[0] === "-l" || args[0] === "--list") && !args.slice(1).some((a) => a.startsWith("-")))
			)
				return inspect("git tag lists tags");
			break;
		case "stash":
			if (args[0] === "list" || args[0] === "show") return inspect(`git stash ${args[0]} reads the stash`);
			break;
		case "worktree":
			if (args[0] === "list") return inspect("git worktree list reads worktrees");
			break;
		case "reflog":
			if (args.length === 0 || args[0] === "show") return inspect("git reflog reads the reflog");
			break;
		case "notes":
			if (args[0] === "list" || args[0] === "show") return inspect(`git notes ${args[0]} reads notes`);
			break;
		case "config":
			if (["--get", "--get-all", "--get-regexp", "--list", "-l", "--get-urlmatch", "get", "list"].includes(args[0] ?? ""))
				return inspect("git config reads configuration");
			break;
		case "remote":
			if (everyArgIn(args, ["-v", "--verbose"]) || args[0] === "get-url") return inspect("git remote lists remotes");
			return { class: "outward", reason: "git remote changes where the repository publishes or fetches" };
		case "submodule":
			if (args.length === 0 || args[0] === "status") return inspect("git submodule status reads submodules");
			return { class: "outward", reason: `git submodule ${args[0] ?? ""} can fetch or reconfigure submodules`.trim() };
		case "symbolic-ref":
			if (everyArgIn(args, ["HEAD", "-q", "--quiet", "--short"])) return inspect("git symbolic-ref reads HEAD");
			break;
	}
	return other(`git ${subcommand} changes local repository state outside the task set`);
}

/** POSIX spelling of `git <argv>` for the shell-string safety net. Quoting only; never executed. */
export function gitArgvCommand(argv: ReadonlyArray<string>): string {
	return [
		"git",
		...argv.map((word) => (/^[A-Za-z0-9_./:=@%+,-]+$/u.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`)),
	].join(" ");
}

/** Classify the argv Git reads after its executable. */
export function classifyGitArgv(argv: ReadonlyArray<string>): GitArgvVerdict {
	let index = 0;
	let redirect: string | null = null;
	while (index < argv.length) {
		const word = argv[index] ?? "";
		if (!word.startsWith("-") || word === "-" || word === "--") break;
		if (word === "--version" || word === "--help" || word === "-h") {
			return { class: "inspect", subcommand: null, reason: `git ${word} prints information` };
		}
		if (!NEUTRAL_GLOBAL_OPTIONS.has(word)) redirect ??= word;
		index += GLOBAL_VALUE_OPTIONS.has(word) ? 2 : 1;
	}
	const subcommand = argv[index] ?? null;
	let verdict: GitArgvVerdict;
	if (subcommand === null || subcommand === "--" || subcommand === "-") {
		verdict = { class: "inspect", subcommand: null, reason: "git with no subcommand prints usage" };
	} else {
		verdict = { subcommand, ...subcommandClass(subcommand, argv.slice(index + 1)) };
	}
	if (redirect !== null && SEVERITY[verdict.class] < SEVERITY["other-local-mutation"]) {
		verdict = {
			...verdict,
			class: "other-local-mutation",
			reason: `global option ${redirect} can change the repository, configuration, executable path, hooks or destination`,
		};
	}
	// The damage-control hard blocks stay the classifier's, read on the same spelling.
	const damage = classify({ tool: "bash", args: { command: gitArgvCommand(argv) } });
	if (damage.actionClass === "git_destructive") {
		return { ...verdict, class: "destructive", reason: `damage control: ${damage.reasons.join(", ")}` };
	}
	return verdict;
}

export interface BashGitInvocation {
	argv: string[];
	/** Exactly `git ...` with no wrapper, assignment, or path-spelled executable. */
	bare: boolean;
}

/** Leading shell reserved words a segment may start with before its command. */
const RESERVED_PREFIXES = new Set(["{", "!", "if", "then", "elif", "else", "do", "while", "until"]);

/**
 * Every Git invocation a bash command runs, substitutions included, and
 * whether the command is one simple command: no operator, redirection,
 * newline or substitution anywhere.
 */
function bashGitInvocations(command: string): { invocations: BashGitInvocation[]; simple: boolean } {
	const joined = command.replace(/\\\r?\n/gu, "");
	const surface = scanShellLike(joined);
	const simple = !surface.some((token) => token.operator || (token.substitutions?.length ?? 0) > 0);
	const invocations: BashGitInvocation[] = [];
	let words: string[] = [];
	const flush = (): void => {
		let start = 0;
		while (start < words.length && RESERVED_PREFIXES.has(words[start] ?? "")) start += 1;
		const git = gitCommandArgv(words.slice(start));
		if (git !== null) invocations.push({ argv: git.argv, bare: git.bare && start === 0 });
		words = [];
	};
	for (const token of scanShellLikeDeep(joined)) {
		if (token.operator) flush();
		else words.push(token.value);
	}
	flush();
	return { invocations, simple };
}

/**
 * The verdict for everything Git a bash command runs, or null when it runs no
 * Git. The strictest invocation decides. The task set is only ever one bare,
 * simple `git` command: a task mutation inside a compound command, behind a
 * wrapper, or through a path-spelled executable is other-local-mutation.
 */
export function classifyBashGit(command: string): (GitArgvVerdict & { argv: string[] }) | null {
	const { invocations, simple } = bashGitInvocations(command);
	let strictest: (GitArgvVerdict & { argv: string[] }) | null = null;
	for (const invocation of invocations) {
		let verdict: GitArgvVerdict & { argv: string[] } = { ...classifyGitArgv(invocation.argv), argv: invocation.argv };
		if (verdict.class === "task-mutation" && (!simple || !invocation.bare || invocations.length > 1)) {
			verdict = {
				...verdict,
				class: "other-local-mutation",
				reason: `${verdict.reason} is in the task set only as one plain git command, not inside a compound command or behind a wrapper`,
			};
		}
		if (strictest === null || SEVERITY[verdict.class] > SEVERITY[strictest.class]) strictest = verdict;
	}
	return strictest;
}
