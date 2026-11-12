import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";
import { canonicalizePath, canonicalizeRawPath } from "../../core/path-canonical.js";
import { normalizedGitCommands } from "./git-command-normalization.js";
import { isSameOrDescendant } from "./path-policy.js";
import { isRelativeCommandPath, type ShellCommandStep, shellCommandSteps } from "./protected-artifacts.js";

/**
 * Containment at autonomy default: containment first, judgment second, asking
 * last. The operator's own bash and run_script calls run inside the
 * main-session sandbox (`src/core/sandbox/main-session.ts`) whenever a backend
 * exists, and a contained call needs no approval ask for what Clio cannot see
 * or bound in its command text, because the OS bounds where it writes and
 * hides the operator's credentials. A call leaves containment when it asks to
 * (`unsandboxed: true`), which always asks so the safety judge reviews it
 * first, or when it reaches outward: publishing, a code host's API, a cloud
 * CLI or a network write all need the credentials the sandbox hides, so they
 * run unsandboxed after the ordinary default rails and the safety judge.
 */

/** Code-host and cloud CLIs: every subcommand acts with credentials the sandbox hides. */
/** Card words only: a list or view of a forge's records reads, which `outward consequence` overstates. It stays outward. */
const FORGE_CLIS: ReadonlySet<string> = new Set(["gh", "glab"]);
const FORGE_READ_VERBS: ReadonlySet<string> = new Set(["list", "view", "status", "diff", "checks"]);

const CREDENTIALED_CLIS: ReadonlySet<string> = new Set([
	"gh",
	"hub",
	"glab",
	"tea",
	"aws",
	"gcloud",
	"gsutil",
	"az",
	"kubectl",
	"helm",
	"terraform",
	"tofu",
	"pulumi",
	"firebase",
	"vercel",
	"netlify",
	"wrangler",
	"fly",
	"flyctl",
	"heroku",
	"doctl",
	"ssh",
	"scp",
	"sftp",
]);

/**
 * Batch scheduler clients authenticate through a host daemon's Unix socket
 * (MUNGE or sackd for Slurm), which the sandbox blocks, so they run outside it
 * under the same rules as ssh. The read-only ones read, for the card words.
 */
export const SCHEDULER_CLIS: ReadonlySet<string> = new Set([
	"sbatch",
	"srun",
	"salloc",
	"scancel",
	"squeue",
	"sacct",
	"sinfo",
	"scontrol",
	"sstat",
	"sprio",
	"sacctmgr",
	"sreport",
	"sattach",
	"sbcast",
	"qsub",
	"qstat",
	"qdel",
	"qalter",
	"qhold",
	"qrls",
	"bsub",
	"bjobs",
	"bkill",
	"flux",
]);
const SCHEDULER_READERS: ReadonlySet<string> = new Set([
	"squeue",
	"sacct",
	"sinfo",
	"sstat",
	"sprio",
	"sreport",
	"qstat",
	"bjobs",
]);

/** Package and image publishers, by executable and the subcommand words that publish. */
const PUBLISHERS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
	["npm", ["publish", "unpublish", "deprecate", "dist-tag", "owner", "access"]],
	["pnpm", ["publish"]],
	["yarn", ["publish", "npm"]],
	["bun", ["publish"]],
	["cargo", ["publish", "yank", "owner"]],
	["twine", ["upload"]],
	["poetry", ["publish"]],
	["uv", ["publish"]],
	["flit", ["publish"]],
	["hatch", ["publish"]],
	["gem", ["push", "yank", "owner"]],
	["dotnet", ["nuget"]],
	["nuget", ["push", "delete"]],
	["mvn", ["deploy"]],
	["docker", ["push", "login"]],
	["podman", ["push", "login"]],
]);

/**
 * Words that run the command after them: the outward check reads through them.
 * `npx`, `pnpx` and `bunx` are not among them: they run the workspace's
 * `node_modules/.bin` entry or a registry package of that name first, never the
 * CLI on PATH (R2-safety-secrets-09).
 */
const WRAPPERS: ReadonlySet<string> = new Set(["timeout", "nohup", "nice", "time", "stdbuf", "ionice", "xargs"]);

/** Assigns PATH: bare, through `env`, or with `export`, `declare` and the like. */
const PATH_ASSIGNMENT = /(?:^|[\s;&|(){}`"'])PATH\+?=/u;

/**
 * Assigns a variable that makes the program it reaches load or run other code:
 * the dynamic loader's preload, audit and search paths (LD_*, DYLD_*), Node's
 * startup options, git's ssh and helper hooks and global config, the startup
 * file a non-interactive shell sources (BASH_ENV, ENV), and Python, Perl and
 * Ruby module paths and startup options. Like a PATH assignment it can point an
 * outward CLI at workspace code, so the line stays contained.
 */
const LOADER_ASSIGNMENT =
	/(?:^|[\s;&|(){}`"'])(?:LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|NODE_OPTIONS|GIT_SSH_COMMAND|GIT_SSH|GIT_EXEC_PATH|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|BASH_ENV|ENV|PYTHONPATH|PYTHONSTARTUP|PERL5OPT|PERL5LIB|RUBYOPT)\+?=/u;

/** A git `-c` or `--config-env` override that names a program git runs (core.sshCommand and the like). */
const GIT_COMMAND_CONFIG =
	/(?:^|\s)(?:-c\s*|--config-env[=\s])["']?(?:core\.(?:sshcommand|fsmonitor|hookspath|pager|editor|askpass)|credential\.helper|gpg\.program)=/iu;

/** curl options that send a body or upload a file. */
const CURL_BODY = /^(?:-[A-Za-z]*[dFT]|--(?:data(?:-\w+)?|form(?:-string)?|upload-file|json)(?:=.*)?)$/u;
const READ_METHODS = /^(?:GET|HEAD)$/iu;
const WGET_SENDS = /^--(?:post-data|post-file|body-data|body-file|method)(?:=|$)/u;
const HTTP_METHODS = /^(?:POST|PUT|PATCH|DELETE)$/u;

/** The command a wrapper runs: the words after the wrapper and its own options and operands. */
function unwrapped(words: ReadonlyArray<string>): ReadonlyArray<string> {
	let rest = words;
	for (let guard = 0; guard < 8; guard += 1) {
		const head = rest[0];
		if (head === undefined || !WRAPPERS.has(head)) return rest;
		let index = 1;
		while (index < rest.length && (rest[index] ?? "").startsWith("-")) index += 1;
		// timeout and nice take a duration or an adjustment before the command.
		if ((head === "timeout" || head === "nice") && /^[\d.]+[smhd]?$/u.test(rest[index] ?? "")) index += 1;
		rest = rest.slice(index);
	}
	return rest;
}

/** True when curl's arguments send a body, upload a file or name a method other than GET or HEAD. */
function curlSends(args: ReadonlyArray<string>): boolean {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "-X" || arg === "--request") {
			if (!READ_METHODS.test(args[index + 1] ?? "")) return true;
			index += 1;
			continue;
		}
		const method = /^(?:--request=|-X)(.+)$/u.exec(arg)?.[1];
		if (method !== undefined) {
			if (!READ_METHODS.test(method)) return true;
			continue;
		}
		if (CURL_BODY.test(arg)) return true;
	}
	return false;
}

function stepOutwardReason(
	words: ReadonlyArray<string>,
	relativeHead: boolean,
	rebound: (name: string) => boolean,
): string | null {
	const command = unwrapped(words);
	const [head, ...args] = command;
	if (head === undefined) return null;
	const name = head.split("/").pop() ?? head;
	// R1-safety-secrets-04: `./sbatch` or `bin/ssh` runs a workspace file, which stays sandboxed under `required`.
	const workspaceFile = command === words ? relativeHead : isRelativeCommandPath(head);
	if (workspaceFile && (CREDENTIALED_CLIS.has(name) || SCHEDULER_CLIS.has(name))) return null;
	const reason = nameOutwardReason(name, args);
	return reason !== null && rebound(name) ? null : reason;
}

/** Why the CLI `name` on PATH, given `args`, reaches outward. `name` is one of the fixed lists above. */
function nameOutwardReason(name: string, args: ReadonlyArray<string>): string | null {
	if (CREDENTIALED_CLIS.has(name)) {
		const [noun, verb] = args.filter((arg) => !arg.startsWith("-"));
		const reads = FORGE_CLIS.has(name) && noun !== "api" && verb !== undefined && FORGE_READ_VERBS.has(verb);
		return `${name} ${reads ? "reads" : "acts"} with your credentials`;
	}
	if (SCHEDULER_CLIS.has(name)) {
		const reads =
			SCHEDULER_READERS.has(name) || (name === "scontrol" && args.find((arg) => !arg.startsWith("-")) === "show");
		return `${name} ${reads ? "reads from" : "acts on"} the cluster scheduler as you`;
	}
	const publishes = PUBLISHERS.get(name);
	const subcommand = args.find((arg) => !arg.startsWith("-"));
	if (publishes !== undefined && subcommand !== undefined && publishes.includes(subcommand)) {
		return `${name} ${subcommand} publishes outside the workspace`;
	}
	if (name === "curl" && curlSends(args)) return "curl sends data or uses a write method";
	if (name === "wget" && args.some((arg) => WGET_SENDS.test(arg))) return "wget sends data or uses a write method";
	if ((name === "http" || name === "https" || name === "xh") && args.some((arg) => HTTP_METHODS.test(arg))) {
		return `${name} uses a write method`;
	}
	if (name === "rsync" && args.some((arg) => !arg.startsWith("-") && /^(?:[\w.-]+@)?[\w.-]+:|^rsync:\/\//u.test(arg))) {
		return "rsync copies to or from a remote host";
	}
	return null;
}

/**
 * R2-safety-secrets-09: a predicate for names this line may have pointed at
 * something other than the CLI on PATH. A PATH assignment, a sourced file or a
 * `command_not_found_handle` can rebind every name; a function, an alias or a
 * hash entry rebinds the name it defines. Such a name is not read as that CLI,
 * so under `safety.sandbox: required` the line stays sandboxed.
 */
function reboundNames(command: string, steps: ReadonlyArray<ShellCommandStep>): (name: string) => boolean {
	if (
		PATH_ASSIGNMENT.test(command) ||
		LOADER_ASSIGNMENT.test(command) ||
		GIT_COMMAND_CONFIG.test(command) ||
		/\bcommand_not_found_handle\b/u.test(command) ||
		steps.some((step) => step.executable === "source" || step.executable === ".")
	) {
		return () => true;
	}
	return (name) =>
		new RegExp(`(?:^|[\\s;&|(){}\`"'])(?:function\\s+${name}(?![\\w.:-])|${name}\\s*\\(\\s*\\))`, "u").test(command) ||
		steps.some(
			(step) =>
				(step.executable === "alias" && step.args.some((arg) => arg.startsWith(`${name}=`))) ||
				(step.executable === "hash" && step.args.includes(name)),
		);
}

/**
 * Why a shell command reaches outward and so leaves the main-session sandbox,
 * or null when it stays inside. `git push` is read the way the classifier
 * marks it outward; the rest by the executable each step runs. A false match
 * only sends the call through the safety judge.
 */
export function outwardShellReason(command: string): string | null {
	const steps = shellCommandSteps(command);
	const rebound = reboundNames(command, steps);
	if (
		!rebound("git") &&
		normalizedGitCommands(command).some(
			(candidate) => /^git push(?:\s|$)/u.test(candidate) && !/(?:^|\s)--dry-run(?:\s|$)/u.test(candidate),
		)
	) {
		return "git push publishes commits";
	}
	for (const step of steps) {
		const reason = stepOutwardReason([step.executable, ...step.args], step.relativePath === true, rebound);
		if (reason !== null) return reason;
	}
	return null;
}

/** Characters an unquoted word may hold and stay literal: no expansion, glob, escape, operator or comment. */
const LITERAL_BARE = /^[A-Za-z0-9_@%+=:,./-]$/u;

/** A CLI name as the first word: a bare name, no path, quote or assignment. */
const CLI_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/u;

/**
 * The words of a line that is one simple command with literal words only, or null. A word is made of bare
 * characters ({@link LITERAL_BARE}), single-quoted text, and double-quoted text with no `$`, backtick or
 * backslash; no part of the line may hold a newline. Anything else (an operator, a redirect, a substitution,
 * a here-document or here-string, an expansion, a glob, a comment, an escape) makes it more than that. This
 * reader is its own: it shares nothing with the scanners that judge other lines.
 */
function literalSimpleCommand(command: string): string[] | null {
	const words: string[] = [];
	let word: string | null = null;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index] ?? "";
		if (char === " " || char === "\t") {
			if (word !== null) words.push(word);
			word = null;
			continue;
		}
		if (char === "'" || char === '"') {
			const close = command.indexOf(char, index + 1);
			if (close === -1) return null;
			const text = command.slice(index + 1, close);
			if (/[\n\r]/u.test(text) || (char === '"' && /[$`\\]/u.test(text))) return null;
			word = (word ?? "") + text;
			index = close;
			continue;
		}
		if (!LITERAL_BARE.test(char)) return null;
		word = (word ?? "") + char;
	}
	if (word !== null) words.push(word);
	const name = /^[ \t]*([^ \t]*)/u.exec(command)?.[1] ?? "";
	return words.length > 0 && CLI_NAME.test(name) ? words : null;
}

/** Where an outward line would run and what a contained command can write, for the checks that read paths. */
export interface OutwardPlaces {
	/** The trees a contained command can write: the workspace, the scratch roots, the sandbox cache, the git dirs. */
	readonly fileRoots: ReadonlyArray<string>;
	/** The directory the line runs in. */
	readonly cwd: string;
	/** The PATH the line's CLI is found on; the process's when not given. */
	readonly searchPath?: string;
}

/** True when `target` lies in a tree a contained command can write, as written or once links resolve. */
function inWritableRoot(target: string, places: OutwardPlaces): boolean {
	const real = canonicalizePath(target);
	return places.fileRoots.some(
		(root) => isSameOrDescendant(target, root) || (real !== null && isSameOrDescendant(real, root)),
	);
}

/** True when the path `value`, read from `dir`, may name a file a contained command planted, or cannot be placed. */
function plantedPath(value: string, dir: string, places: OutwardPlaces): boolean {
	if (value === "" || value.startsWith("~")) return true;
	const resolved = path.isAbsolute(value) ? path.normalize(value) : canonicalizeRawPath(value, dir);
	return resolved === null || inWritableRoot(resolved, places);
}

/**
 * True when PATH may run a program a contained command planted for `name`: a directory before the first one
 * holding an executable `name`, or any when none does, that is relative, empty or in a writable tree.
 */
function plantedOnPath(name: string, places: OutwardPlaces): boolean {
	for (const dir of (places.searchPath ?? process.env.PATH ?? "").split(":")) {
		if (dir === "" || !path.isAbsolute(dir) || inWritableRoot(dir, places)) return true;
		try {
			accessSync(path.join(dir, name), constants.X_OK);
			return false;
		} catch {}
	}
	return false;
}

/** The nearest directory at or above `dir` holding `.git`. */
function repositoryTop(dir: string): string | null {
	for (let current = dir; ; current = path.dirname(current)) {
		if (existsSync(path.join(current, ".git"))) return current;
		if (path.dirname(current) === current) return null;
	}
}

/** git's global options that take the next word as a value. */
const GIT_VALUE_OPTIONS = /^(?:-c|--namespace|--config-env|--super-prefix|--attr-source)$/u;

/** git's global options that name a repository, a work tree or an exec path. */
const GIT_LOCATION_OPTION = /^--(?:git-dir|work-tree|exec-path)(?:=(.*))?$/u;

/** push options that name a program git runs or the repository it pushes to. */
const GIT_PUSH_PROGRAM_OPTION = /^--(?:receive-pack|exec)(?:=|$)/u;

/**
 * Why a `git` argv publishes, or null; `planted` is set when it may run hooks or programs a contained command
 * planted: `-C` or a location option into another repository in a writable tree, a push into a local
 * repository there, whose receive hooks run on this host, a `--receive-pack` or `--exec` program, a `-c`
 * override or a `transport::address` remote.
 */
function gitPushReason(
	args: ReadonlyArray<string>,
	places: OutwardPlaces,
): { reason: string | null; planted: boolean } {
	let here = places.cwd;
	let planted = false;
	let index = 0;
	for (; index < args.length; index += 1) {
		const word = args[index] ?? "";
		if (word === "-C") {
			index += 1;
			const resolved = canonicalizeRawPath(args[index] ?? "", here);
			if (resolved === null) planted = true;
			else here = resolved;
			continue;
		}
		const location = GIT_LOCATION_OPTION.exec(word);
		if (location !== null) {
			if (location[1] === undefined) index += 1;
			if (plantedPath(location[1] ?? args[index] ?? "", here, places)) planted = true;
			continue;
		}
		// A config override can name a program git runs (core.sshCommand, a url rewrite to `ext::`).
		if (/^(?:-c|--config-env)(?:=|$)/u.test(word) || /^-c./u.test(word)) planted = true;
		if (GIT_VALUE_OPTIONS.test(word)) index += 1;
		else if (!word.startsWith("-")) break;
	}
	if (args[index] !== "push") return { reason: null, planted: false };
	const rest = args.slice(index + 1);
	if (rest.includes("--dry-run")) return { reason: null, planted: false };
	const start = repositoryTop(places.cwd) ?? places.cwd;
	if (
		here !== places.cwd &&
		(repositoryTop(here) ?? here) !== start &&
		inWritableRoot(repositoryTop(here) ?? here, places)
	)
		planted = true;
	if (rest.some((word) => GIT_PUSH_PROGRAM_OPTION.test(word))) planted = true;
	const remotes: string[] = [];
	const repo = rest.findIndex((word) => /^--repo(?:=|$)/u.test(word));
	if (repo !== -1)
		remotes.push(rest[repo] === "--repo" ? (rest[repo + 1] ?? "") : (rest[repo] ?? "").slice("--repo=".length));
	const operand = rest.find(
		(word, at) => !word.startsWith("-") && !(repo !== -1 && rest[repo] === "--repo" && at === repo + 1),
	);
	if (operand !== undefined) remotes.push(operand);
	for (const remote of remotes) {
		// `transport::address` runs the remote helper git-remote-<transport>; `ext::` runs any command.
		if (remote.includes("::")) planted = true;
		const local = remote.startsWith("file://") ? remote.slice("file://".length) : remote;
		// `host:path` is a remote host; a bare word is a remote's name unless a directory of that name exists.
		if (/^[^/]*:/u.test(local)) continue;
		const pathLike = local !== remote || /^(?:\/|\.{1,2}\/|~)/u.test(local);
		const target = canonicalizeRawPath(local, here);
		if (pathLike || (target !== null && existsSync(target))) {
			if (plantedPath(local, here, places)) planted = true;
		}
	}
	return { reason: "git push publishes commits", planted };
}

/** ssh options whose value runs a command or reads a config that can (ProxyCommand, LocalCommand and the like). */
const SSH_PROGRAM_KEYS = /^(?:proxycommand|localcommand|permitlocalcommand|knownhostscommand|include|match)\b/iu;

/**
 * True when an argv's options name a program the CLI runs on this host, a config file that can name one, or
 * a file it writes: ssh's, scp's and sftp's `-F`, `-S`, `-D`, `-E` and command `-o` keys, rsync's `-e`, and a
 * `--kubeconfig` or other `--*config*` path option into a writable tree.
 */
function argvRunsPlanted(name: string, args: ReadonlyArray<string>, places: OutwardPlaces): boolean {
	const optionValue = (index: number, flag: string): string => {
		const word = args[index] ?? "";
		const attached = word.startsWith(`${flag}=`) ? word.slice(flag.length + 1) : word.slice(flag.length);
		return attached !== "" ? attached : (args[index + 1] ?? "");
	};
	for (let index = 0; index < args.length; index += 1) {
		const word = args[index] ?? "";
		if (word === "--") break;
		if (name === "ssh" || name === "scp" || name === "sftp") {
			if (/^-[FE]/u.test(word)) return true;
			if ((name === "scp" || name === "sftp") && /^-S/u.test(word)) return true;
			if (name === "sftp" && /^-D/u.test(word)) return true;
			if (/^-o/u.test(word) && SSH_PROGRAM_KEYS.test(optionValue(index, "-o").replace(/^["']/u, ""))) return true;
		}
		if (name === "rsync" && (/^-[A-Za-z]*e/u.test(word) || /^--rsh(?:=|$)/u.test(word))) return true;
		const config = /^--[\w-]*config[\w-]*(?:=(.*))?$/iu.exec(word);
		if (config !== null) {
			const value = config[1] ?? args[index + 1] ?? "";
			if (/[/~]|^\.{1,2}$/u.test(value) && plantedPath(value, places.cwd, places)) return true;
		}
	}
	return false;
}

/**
 * Under `safety.sandbox: required`, true when an outward line may leave the sandbox: the whole line is one
 * simple command with literal arguments ({@link literalSimpleCommand}) whose CLI is the one PATH finds outside
 * every writable tree, its argv reaches outward on its own, and no option names a program, config or
 * repository a contained command may have planted. Any other line runs inside the sandbox.
 */
export function outwardLineLeaves(command: string, places: OutwardPlaces): boolean {
	if (outwardShellReason(command) === null) return false;
	const words = literalSimpleCommand(command);
	if (words === null) return false;
	const [name = "", ...args] = words;
	if (plantedOnPath(name, places)) return false;
	if (name === "git") {
		const push = gitPushReason(args, places);
		return push.reason !== null && !push.planted;
	}
	if (nameOutwardReason(name, args) === null) return false;
	return !argvRunsPlanted(name, args, places);
}

/**
 * Damage-control rules (`damage-control-rules.yaml`) whose command discards
 * work a workspace snapshot taken right before it brings back: the worktree
 * discards and the stash drop. At autonomy default they run without an ask
 * while snapshots are available, because the registry snapshots before each
 * of them (`workspaceSnapshotTrigger`); `git clean` qualifies only without
 * `-x` or `-X`, since the snapshot leaves ignored files out.
 */
export const SNAPSHOT_RECOVERABLE_GIT_RULE_IDS: ReadonlySet<string> = new Set([
	"git-checkout-force",
	"git-checkout-dot",
	"git-checkout-discard-all",
	"git-restore-discard-all",
	"git-reset-hard",
	"git-reset-hard-head",
	"git-stash-drop",
	"git-clean-force-directory",
]);

/**
 * Reason code of a lone worktree discard or lone delete the operator's
 * default runs because the snapshot taken right before it undoes it.
 */
export const SNAPSHOT_RECOVERABLE_REASON_CODE = "snapshot-recoverable";

/**
 * Rule of a typed file mutation that lands on a git hook, config or git dir
 * pointer of the repository, which the sandbox keeps read-only. The
 * operator's default asks for it in the policy engine; a worker at default
 * asks the main agent for it at admission.
 */
export const GIT_CONTROL_FILE_RULE_ID = "git-control-file";

/** Why a write to `controlPath` needs approval. */
export function gitControlFileReason(controlPath: string): string {
	return `'${controlPath}' is a git hook, config or git dir pointer of the workspace repository; writing it would run code outside the sandbox on the next git command, so it requires approval`;
}

/** Classifier patterns (`action-classifier.ts`) for the same recoverable discards. */
export const SNAPSHOT_RECOVERABLE_GIT_PATTERNS: ReadonlySet<string> = new Set([
	"pattern:git-reset-hard",
	"pattern:git-checkout-dot",
]);

/** True when a `git clean` in the command also removes ignored files, which no snapshot keeps. */
export function cleansIgnoredFiles(command: string): boolean {
	return normalizedGitCommands(command).some(
		(candidate) => /^git clean\b/u.test(candidate) && /\s-(?!-)[A-Za-z]*[xX]/u.test(candidate),
	);
}
