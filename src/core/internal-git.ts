import path from "node:path";

/**
 * Git that Clio runs on its own, as opposed to git the agent asks for:
 * task worktrees, landing worker results, footer and status probes, and the
 * diffs behind receipts, the working set and views. These run in Clio's own
 * process, outside any sandbox, so whatever the repository's configuration
 * names as a program runs with the operator's privileges. Every internal git
 * argv goes through {@link internalGitArgv}, so a new call site inherits the
 * same protections.
 *
 * Every call carries global options that keep a read from
 * running a program: no core.fsmonitor command (status, diff and ls-files
 * would run it to refresh the index), no signature check through
 * log.showSignature, and no optional index write, which would fire the
 * post-index-change hook. `diff`, `log` and `show` also get `--no-ext-diff` and
 * `--no-textconv`, so diff.external, diff.<driver>.command and textconv
 * drivers never run. A read also asks the installed {@link InternalGitPolicy}
 * through its cheap config check: after executable config in the repository
 * changed (a filter driver a racily dirty file would pass through, a textconv
 * driver), the read carries the same per-key overrides a mutation gets, or is
 * refused with {@link InternalGitRefusedError} when a changed key cannot be
 * overridden from the command line.
 *
 * An operation that runs hooks or other configured commands (worktree add,
 * checkout, merge, commit, ref updates, fetch, push) also asks the installed
 * {@link InternalGitPolicy}, which the orchestrator wires to the git hook
 * drift guard: after unapproved drift it returns overrides that turn hooks
 * off and neutralize the changed configuration.
 */

/** Global options every internal git call carries. */
export const INTERNAL_GIT_BASE_OPTIONS: ReadonlyArray<string> = Object.freeze([
	"--no-optional-locks",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"log.showSignature=false",
]);

/** Subcommands that print patches through diff.external and textconv drivers. */
const PATCH_SUBCOMMANDS: ReadonlySet<string> = new Set(["diff", "log", "show"]);
const PATCH_FLAGS: ReadonlyArray<string> = ["--no-ext-diff", "--no-textconv"];

/** Global options before the subcommand that take the next word as their value. */
const GLOBAL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--config-env",
	"--attr-source",
]);

/**
 * Subcommands that run no hook and no configured program once
 * {@link INTERNAL_GIT_BASE_OPTIONS} and the patch flags apply. Anything else
 * counts as hook-running, so an unlisted subcommand errs toward the policy.
 */
const READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
	"blame",
	"cat-file",
	"check-attr",
	"check-ignore",
	"config",
	"count-objects",
	"describe",
	"diff",
	"diff-files",
	"diff-index",
	"diff-tree",
	"for-each-ref",
	"grep",
	"hash-object",
	"log",
	"ls-files",
	"ls-tree",
	"merge-base",
	"name-rev",
	"rev-list",
	"rev-parse",
	"shortlog",
	"show",
	"show-ref",
	"status",
	"var",
	"version",
]);

/**
 * Reads that can run a program the repository configures beyond what the
 * base options turn off: clean filters for a racily dirty file (status, diff,
 * ls-files, hash-object, describe --dirty) and textconv drivers (blame, grep).
 * Only these, and operations that already turn hooks off, ask the policy's
 * read check; rev-parse, config, for-each-ref and the like never do.
 */
const CONFIG_RUNNING_READS: ReadonlySet<string> = new Set([
	"blame",
	"describe",
	"diff",
	"diff-files",
	"diff-index",
	"grep",
	"hash-object",
	"log",
	"ls-files",
	"show",
	"status",
]);

/** Forms of hook-running subcommands that run none: listings, and worktree removal and pruning. */
function readForm(subcommand: string, rest: ReadonlyArray<string>): boolean {
	const words = rest.filter((word) => !word.startsWith("-"));
	const flags = new Set(rest.filter((word) => word.startsWith("-")));
	switch (subcommand) {
		case "branch":
			return rest.length === 0 || flags.has("--show-current") || flags.has("--list") || flags.has("-l");
		case "worktree":
			return words[0] === "list" || words[0] === "prune" || words[0] === "remove";
		case "stash":
			return words[0] === "list" || words[0] === "show";
		case "symbolic-ref":
			return words.length <= 1 && !flags.has("-d") && !flags.has("--delete");
		case "tag":
			return flags.has("-l") || flags.has("--list");
		case "remote":
			return words.length === 0 || words[0] === "get-url" || words[0] === "show";
		default:
			return false;
	}
}

/** Index of the subcommand in `args`, past git's global options, or -1. */
function subcommandIndex(args: ReadonlyArray<string>): number {
	for (let at = 0; at < args.length; at += 1) {
		const word = args[at] as string;
		if (GLOBAL_OPTIONS_WITH_VALUE.has(word)) {
			at += 1;
			continue;
		}
		if (word.startsWith("-")) continue;
		return at;
	}
	return -1;
}

/** The directory git runs in: `cwd`, then every `-C` applied in order, as git applies them. */
function runDirectory(globals: ReadonlyArray<string>, cwd: string | undefined): string {
	let dir = path.resolve(cwd ?? process.cwd());
	for (let at = 0; at < globals.length; at += 1) {
		if (globals[at] === "-C" && globals[at + 1] !== undefined) dir = path.resolve(dir, globals[at + 1] as string);
		if (GLOBAL_OPTIONS_WITH_VALUE.has(globals[at] as string)) at += 1;
	}
	return dir;
}

/** `git worktree add`, `git merge`: the subcommand and, for a command with actions, its action. */
function operationLabel(subcommand: string, rest: ReadonlyArray<string>): string {
	const action = rest.find((word) => !word.startsWith("-"));
	return ["worktree", "stash", "submodule", "notes", "remote"].includes(subcommand) && action !== undefined
		? `git ${subcommand} ${action}`
		: `git ${subcommand}`;
}

/**
 * Whether the call itself already turns hooks off the way Clio's plumbing
 * does (`-c core.hooksPath=/dev/null`): snapshots, checkpoints and fleet
 * change return. Such an operation is not the policy's to harden or report.
 */
function pinsHooksOff(globals: ReadonlyArray<string>): boolean {
	for (let at = 0; at + 1 < globals.length; at += 1) {
		if (globals[at] === "-c" && /^core\.hookspath=\/dev\/null$/iu.test(globals[at + 1] as string)) return true;
	}
	return false;
}

export interface InternalGitOperation {
	/** The directory the operation runs in, `-C` applied. */
	repository: string;
	/** `git worktree add`, `git merge`, `git commit`. */
	operation: string;
}

/**
 * Decides how a hook-running internal git operation runs. Returns `-c`
 * words placed before the subcommand; empty runs the operation as the
 * repository configures it. Implementations do not throw.
 */
export interface InternalGitPolicy {
	harden(operation: InternalGitOperation): ReadonlyArray<string>;
	/**
	 * `-c` words for a read, or for an operation that already turns hooks
	 * off, against config drift in its repository; null refuses it. Called on
	 * every footer probe, so it must stay a stat check while nothing changed.
	 */
	read?(operation: InternalGitOperation): ReadonlyArray<string> | null;
}

/** Thrown by {@link internalGitArgv} when the policy refuses a read; a call site handles it as a failed git. */
export class InternalGitRefusedError extends Error {
	constructor(operation: InternalGitOperation) {
		super(`${operation.operation} refused: executable git config changed in ${operation.repository}`);
		this.name = "InternalGitRefusedError";
	}
}

let installedPolicy: InternalGitPolicy | null = null;

/**
 * Install the session's policy for hook-running internal git, or remove it
 * with null. One process runs one session's policy; a process with none
 * (a worker, a CLI subcommand) runs such operations as configured.
 */
export function installInternalGitPolicy(policy: InternalGitPolicy | null): void {
	installedPolicy = policy;
}

/**
 * Hooks disabled without a policy's directory: git looks for each hook under
 * a path that cannot hold one. Used only when the installed policy fails.
 */
const UNREACHABLE_HOOKS_PATH = "core.hooksPath=/dev/null";

function readOverrides(operation: InternalGitOperation): ReadonlyArray<string> {
	if (installedPolicy?.read === undefined) return [];
	let words: ReadonlyArray<string> | null;
	try {
		words = installedPolicy.read(operation);
	} catch {
		// A read keeps the base options and patch flags when the policy cannot decide.
		return [];
	}
	if (words === null) throw new InternalGitRefusedError(operation);
	return words;
}

function policyOverrides(operation: InternalGitOperation): ReadonlyArray<string> {
	if (installedPolicy === null) return [];
	try {
		return installedPolicy.harden(operation);
	} catch {
		// A policy that cannot decide fails closed: the operation runs, without hooks.
		return ["-c", UNREACHABLE_HOOKS_PATH];
	}
}

/**
 * The argv for an internal git call: `args` as the call site wrote it (global
 * options such as `-C`, then the subcommand and its words), with
 * {@link INTERNAL_GIT_BASE_OPTIONS} in front, the patch flags after a `diff`,
 * `log` or `show`, and the installed policy's overrides before a
 * hook-running subcommand, or its read overrides before any other. `cwd` is
 * where the process starts (the call's own `cwd` option), for resolving which
 * repository git runs in. Throws {@link InternalGitRefusedError} when the
 * policy refuses a read.
 */
export function internalGitArgv(args: ReadonlyArray<string>, cwd?: string): string[] {
	const at = subcommandIndex(args);
	if (at < 0) return [...INTERNAL_GIT_BASE_OPTIONS, ...args];
	const globals = args.slice(0, at);
	const subcommand = args[at] as string;
	const rest = args.slice(at + 1);
	const operation = { repository: runDirectory(globals, cwd), operation: operationLabel(subcommand, rest) };
	const read = READ_SUBCOMMANDS.has(subcommand) || readForm(subcommand, rest);
	const overrides =
		!read && !pinsHooksOff(globals)
			? policyOverrides(operation)
			: CONFIG_RUNNING_READS.has(subcommand) || !read
				? readOverrides(operation)
				: [];
	return [
		...INTERNAL_GIT_BASE_OPTIONS,
		...globals,
		...overrides,
		subcommand,
		...(PATCH_SUBCOMMANDS.has(subcommand) ? PATCH_FLAGS : []),
		...rest,
	];
}
