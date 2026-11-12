import { existsSync } from "node:fs";
import { hostname } from "node:os";
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

/** The words of a space-separated list. */
const listed = (text: string): ReadonlyArray<string> => text.split(" ");

/** Where an outward line would run and what a contained command can write, for the checks that read paths. */
export interface OutwardPlaces {
	/** The workspace, with links resolved. */
	readonly workspace: string;
	/** The trees a contained command can write: the workspace, the scratch roots, the sandbox cache, the git dirs. */
	readonly fileRoots: ReadonlyArray<string>;
	/** The directory the line runs in. */
	readonly cwd: string;
	/** The PATH the line runs with; null when it is not known yet, which keeps every line inside. */
	readonly searchPath: string | null;
}

/** True when `target` lies in a tree a contained command can write, as written or once links resolve. */
function inWritableRoot(target: string, places: OutwardPlaces): boolean {
	const real = canonicalizePath(target);
	return places.fileRoots.some(
		(root) => isSameOrDescendant(target, root) || (real !== null && isSameOrDescendant(real, root)),
	);
}

/** True when the local path `value`, read from `places.cwd`, lies in a writable tree both as written and once links resolve. */
function insideWritableRoots(value: string, places: OutwardPlaces): boolean {
	if (value === "" || value.startsWith("~")) return false;
	const written = path.resolve(places.cwd, value);
	const real = canonicalizeRawPath(value, places.cwd);
	const inside = (target: string) => places.fileRoots.some((root) => isSameOrDescendant(target, root));
	return real !== null && inside(written) && inside(real);
}

/**
 * True when PATH may run a program a contained command planted: any directory on it that is relative, empty
 * or in a writable tree. The CLI is not the only program PATH finds: gh runs git, git and rsync run ssh, and
 * a script CLI runs its interpreter.
 */
function plantedOnPath(places: OutwardPlaces): boolean {
	if (places.searchPath === null) return true;
	return places.searchPath.split(":").some((dir) => dir === "" || !path.isAbsolute(dir) || inWritableRoot(dir, places));
}

/** The nearest directory at or above `dir` holding `.git`. */
function repositoryTop(dir: string): string | null {
	for (let current = dir; ; current = path.dirname(current)) {
		if (existsSync(path.join(current, ".git"))) return current;
		if (path.dirname(current) === current) return null;
	}
}

/**
 * True when a line run from `dir` runs in the workspace's own repository: inside the workspace, outside any
 * `.git` directory, and with no other repository between it and the workspace, so git and the CLIs that run
 * git read the workspace repository's config and hooks, which the sandbox keeps read-only.
 */
function inWorkspaceRepository(dir: string, places: OutwardPlaces): boolean {
	const real = canonicalizePath(dir);
	if (real === null || !isSameOrDescendant(real, places.workspace)) return false;
	if (path.relative(places.workspace, real).split(path.sep).includes(".git")) return false;
	return repositoryTop(real) === repositoryTop(places.workspace);
}

/** A host that is this machine, where a command sent over ssh would run outside the sandbox. */
function localHost(host: string): boolean {
	const name = host
		.replace(/^[^@]*@/u, "")
		.replace(/^\[|\]$/gu, "")
		.replace(/\.$/u, "")
		.toLowerCase();
	return (
		name === "" ||
		name === "::" ||
		name.startsWith("::ffff:") ||
		name === "localhost" ||
		name.endsWith(".localhost") ||
		name === "::1" ||
		name === "0.0.0.0" ||
		/^127\./u.test(name) ||
		name === hostname().toLowerCase()
	);
}

/**
 * The options an outward CLI may carry and still leave the sandbox. None names a file, directory, program or
 * config the CLI would read or run, except an `inputs` option, whose file must lie in a writable tree. An
 * option is matched whole: an abbreviation, a short-option cluster or a short option with its value attached
 * is not on the list.
 */
interface OptionList {
	/** Options without a value. */
	readonly flags: ReadonlyArray<string>;
	/** Options with a value, the next word or after `=` on a long option. */
	readonly values?: ReadonlyArray<string>;
	/** Long options whose value, when given, follows `=`. */
	readonly optionalValues?: ReadonlyArray<string>;
	/** Options whose value names a file the CLI only reads. */
	readonly inputs?: ReadonlyArray<string>;
	/** A further test of an option's value. */
	readonly value?: (option: string, value: string) => boolean;
	/** After this many operands, the next operand starts a command whose words are all operands (ssh's remote command). */
	readonly commandAfter?: number;
}

/** The operands of `args` read against `list`, or null when a word is an option it does not name or a value it refuses. */
function listedOperands(args: ReadonlyArray<string>, list: OptionList, places: OutwardPlaces): string[] | null {
	const operands: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const word = args[index] ?? "";
		if (word === "--") return [...operands, ...args.slice(index + 1)];
		if (word === "-" || !word.startsWith("-")) {
			if (list.commandAfter !== undefined && operands.length === list.commandAfter)
				return [...operands, ...args.slice(index)];
			operands.push(word);
			continue;
		}
		const equals = word.startsWith("--") ? word.indexOf("=") : -1;
		const option = equals === -1 ? word : word.slice(0, equals);
		if (list.flags.includes(option) || list.optionalValues?.includes(option)) {
			if (equals !== -1 && list.optionalValues?.includes(option) !== true) return null;
			continue;
		}
		const input = list.inputs?.includes(option) === true;
		if (!input && list.values?.includes(option) !== true) return null;
		let value: string | undefined = word.slice(equals + 1);
		if (equals === -1) {
			index += 1;
			value = args[index];
		}
		// A value read as an option would hide the word after it from this reading.
		if (value === undefined || value.startsWith("-")) return null;
		if (input && !insideWritableRoots(value, places)) return null;
		if (list.value !== undefined && !list.value(option, value)) return null;
	}
	return operands;
}

/** git push: the guardian's list, and the remote and refspecs as operands. */
const GIT_PUSH_OPTIONS: OptionList = {
	flags: listed(
		"-u --set-upstream -f --force --force-if-includes --tags --follow-tags -d --delete -n --dry-run --no-verify --atomic --all -q --quiet -v --verbose --porcelain",
	),
	optionalValues: ["--force-with-lease"],
};

/** A push remote that is a configured remote's name or a network URL, not a local repository or a remote helper. */
function networkRemote(remote: string, here: string): boolean {
	if (remote.includes("::")) return false;
	if (/^[A-Za-z0-9_][\w.-]*$/u.test(remote)) return !existsSync(path.resolve(here, remote));
	const url = /^([A-Za-z][\w+.-]*):\/\/(?:[^@/]*@)?(\[[^\]]*\]|[^:/]*)/u.exec(remote);
	if (url !== null) return /^(?:https?|ssh|git)$/iu.test(url[1] ?? "") && !localHost(url[2] ?? "");
	const scp = /^(?:[\w.-]+@)?([\w.-]+):/u.exec(remote);
	return scp !== null && !localHost(scp[1] ?? "");
}

/**
 * True when a `git` argv pushes and may leave: global options `-C` and `--no-pager` only, `-C` into the
 * workspace repository, push options from {@link GIT_PUSH_OPTIONS}, and a remote that is a name or a
 * network URL.
 */
function gitPushLeaves(args: ReadonlyArray<string>, places: OutwardPlaces): boolean {
	let here = places.cwd;
	let index = 0;
	for (; index < args.length; index += 1) {
		const word = args[index] ?? "";
		if (word === "--no-pager") continue;
		if (word !== "-C") break;
		index += 1;
		const resolved = canonicalizeRawPath(args[index] ?? "", here);
		if (resolved === null) return false;
		here = resolved;
	}
	if (args[index] !== "push" || !inWorkspaceRepository(here, places)) return false;
	const operands = listedOperands(args.slice(index + 1), GIT_PUSH_OPTIONS, places);
	if (operands === null) return false;
	const remote = operands[0];
	return remote === undefined || networkRemote(remote, here);
}

/** ssh `-o` keys that name no file, program or config, with a plain value. */
const SSH_OPTION_KEY =
	/^(?:StrictHostKeyChecking|ConnectTimeout|ConnectionAttempts|BatchMode|ServerAliveInterval|ServerAliveCountMax|LogLevel)[= ][\w.-]+$/iu;

const sshOptionValue = (option: string, value: string): boolean => option !== "-o" || SSH_OPTION_KEY.test(value);

const SSH_OPTIONS: OptionList = {
	flags: listed("-t -T -q -v -4 -6 -n -N -C"),
	values: listed("-p -l -o"),
	value: sshOptionValue,
	commandAfter: 1,
};

const SCP_OPTIONS: OptionList = {
	flags: listed("-q -r -p -C -4 -6 -B -v"),
	values: listed("-P -l -o"),
	value: sshOptionValue,
};

const RSYNC_OPTIONS: OptionList = {
	flags: listed(
		"-a --archive -r --recursive -v --verbose -z --compress -n --dry-run -c --checksum -t --times -u --update -h --human-readable -P --progress --partial --delete",
	),
	values: listed("--exclude --include"),
};

/** The host of a remote scp or rsync operand, or null for a local path. */
function remoteOperandHost(operand: string): string | null {
	if (operand.startsWith("rsync://")) return /^rsync:\/\/(?:[^@/]*@)?([^:/]*)/u.exec(operand)?.[1] ?? "";
	return /^([^/:]*):/u.exec(operand)?.[1] ?? null;
}

/** scp and rsync: every remote operand on another host, every local one in a writable tree. */
function copyOperandsStay(operands: ReadonlyArray<string>, places: OutwardPlaces): boolean {
	return operands.every((operand) => {
		const host = remoteOperandHost(operand);
		return host !== null ? !localHost(host) : insideWritableRoots(operand, places);
	});
}

/** An http or https URL whose host is not this machine. */
function webUrlOffHost(text: string): boolean {
	if (!/^https?:\/\//iu.test(text)) return false;
	try {
		return !localHost(new URL(text).hostname);
	} catch {
		return false;
	}
}

/** gh subcommands that leave, by noun and verb; `api` has its own list. */
const GH_VERBS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
	["pr", listed("list view create edit comment close reopen merge ready review checks diff status")],
	["issue", listed("list view create edit comment close reopen status")],
	["run", listed("list view rerun cancel watch")],
	["workflow", listed("list view run")],
	["release", listed("list view")],
	["repo", ["view"]],
	["label", ["list"]],
]);

/** gh's options across those subcommands; a short letter that means two things there is left out. */
const GH_OPTIONS: OptionList = {
	flags: listed(
		"-d --draft --fill --merge --squash --rebase --auto --delete-branch --admin --approve --request-changes --comment --log --log-failed --exit-status --failed",
	),
	values: listed(
		"-t --title -b --body -B --base -H --head -l --label --add-label --remove-label --assignee --reviewer --milestone -L --limit -s --state --status -A --author -S --search --json -q --jq -R --repo --subject --workflow --event --branch --raw-field --job --attempt",
	),
	inputs: ["--body-file"],
	value: (option, value) =>
		!(option === "-R" || option === "--repo") || /^(?:github\.com\/)?[\w.-]+\/[\w.-]+$/u.test(value),
};

/** `gh api`: no `-F`, which reads `@file`, and no `--input`. */
const GH_API_OPTIONS: OptionList = {
	flags: listed("--paginate --slurp -i --include --silent --verbose"),
	values: listed("-X --method -f --raw-field -H --header -q --jq"),
};

function ghLeaves(args: ReadonlyArray<string>, places: OutwardPlaces): boolean {
	const [noun = "", ...rest] = args;
	const operands = listedOperands(rest, noun === "api" ? GH_API_OPTIONS : GH_OPTIONS, places);
	// A URL names the host gh sends its token to.
	if (operands === null || operands.some((word) => word.includes("://") && !word.startsWith("https://github.com/")))
		return false;
	return noun === "api" ? operands.length >= 1 : GH_VERBS.get(noun)?.includes(operands[0] ?? "") === true;
}

const KUBECTL_SUBCOMMANDS: ReadonlyArray<string> = listed(
	"get describe logs delete rollout scale top version explain api-resources cluster-info",
);

/** kubectl: no `--kubeconfig`, no `-f`, and no output format read from a file. */
const KUBECTL_OPTIONS: OptionList = {
	flags: listed("-A --all-namespaces --show-labels --previous --all"),
	values: listed(
		"-n --namespace -l --selector -o --output --context --cluster -c --container --tail --since --field-selector --replicas --sort-by",
	),
	value: (option, value) => !(option === "-o" || option === "--output") || !/file/iu.test(value),
};

/** curl: no output, upload, form, config or `@file` value, and an HTTP URL. */
const CURL_OPTIONS: OptionList = {
	flags: listed("-s --silent -S --show-error -f --fail --fail-with-body -L --location -i --include --compressed"),
	values: listed(
		"-X --request -H --header -d --data --data-raw --json -u --user -m --max-time --connect-timeout --retry -A --user-agent",
	),
	value: (_option, value) => !value.startsWith("@"),
};

const NPM_PUBLISH_OPTIONS: OptionList = {
	flags: listed("--dry-run --provenance --ignore-scripts"),
	values: listed("--access --tag --otp"),
};

const PNPM_PUBLISH_OPTIONS: OptionList = {
	flags: listed("--dry-run --provenance --ignore-scripts --no-git-checks"),
	values: listed("--access --tag --otp --publish-branch"),
};

const IMAGE_PUSH_OPTIONS: OptionList = { flags: listed("-a --all-tags -q --quiet --disable-content-trust") };

/** Slurm clients: no output, error, working-directory, node-file, export or wrapped-command option. */
const SLURM_OPTIONS: ReadonlyMap<string, OptionList> = new Map([
	[
		"sbatch",
		{
			flags: listed("--parsable --exclusive -H --hold --requeue --no-requeue"),
			values: listed(
				"-p --partition -N --nodes -n --ntasks --ntasks-per-node -c --cpus-per-task -t --time -J --job-name -A --account -q --qos --mem --mem-per-cpu --gres --gpus -C --constraint -a --array -d --dependency --begin --reservation --mail-type --mail-user",
			),
		},
	],
	[
		"squeue",
		{
			flags: listed("--me -h --noheader -l --long -r --array"),
			values: listed(
				"-u --user -j --jobs -p --partition -t --states -o --format -O --Format -A --account -n --name -S --sort",
			),
		},
	],
	[
		"scancel",
		{
			flags: ["--me"],
			values: listed("-u --user -n --name -p --partition -t --state -s --signal -A --account"),
		},
	],
	[
		"sacct",
		{
			flags: listed("-X --allocations -n --noheader -P --parsable2 -p --parsable -a --allusers -l --long"),
			values: listed("-j --jobs -u --user -S --starttime -E --endtime -o --format --name -s --state --units"),
		},
	],
	[
		"sinfo",
		{
			flags: listed("-N --Node -l --long -h --noheader -s --summarize -R --list-reasons -a --all"),
			values: listed("-p --partition -o --format -O --Format -t --states"),
		},
	],
]);

/**
 * Whether an outward CLI's argv may leave, by CLI. A CLI not named here runs inside on every line: its argv is
 * open-ended, it runs workspace code by design (terraform, pulumi, srun, salloc), or no line of it needs to leave.
 */
const OUTWARD_ARGV: ReadonlyMap<string, (args: ReadonlyArray<string>, places: OutwardPlaces) => boolean> = new Map<
	string,
	(args: ReadonlyArray<string>, places: OutwardPlaces) => boolean
>([
	["gh", ghLeaves],
	[
		"ssh",
		(args, places) => {
			const operands = listedOperands(args, SSH_OPTIONS, places);
			const host = operands?.[0];
			if (host === undefined) return false;
			const url = /^ssh:\/\/([^/]*?)(?::\d+)?\/?$/u.exec(host);
			return !localHost(url !== null ? (url[1] ?? "") : host);
		},
	],
	[
		"scp",
		(args, places) => {
			const operands = listedOperands(args, SCP_OPTIONS, places);
			return operands !== null && operands.length >= 2 && copyOperandsStay(operands, places);
		},
	],
	[
		"rsync",
		(args, places) => {
			const operands = listedOperands(args, RSYNC_OPTIONS, places);
			return operands !== null && operands.length >= 2 && copyOperandsStay(operands, places);
		},
	],
	[
		"kubectl",
		(args, places) => {
			const operands = listedOperands(args, KUBECTL_OPTIONS, places);
			return operands !== null && KUBECTL_SUBCOMMANDS.includes(operands[0] ?? "");
		},
	],
	[
		"curl",
		(args, places) => {
			const operands = listedOperands(args, CURL_OPTIONS, places);
			return operands !== null && operands.length > 0 && operands.every(webUrlOffHost);
		},
	],
	[
		"npm",
		(args, places) => args[0] === "publish" && listedOperands(args.slice(1), NPM_PUBLISH_OPTIONS, places)?.length === 0,
	],
	[
		"pnpm",
		(args, places) => args[0] === "publish" && listedOperands(args.slice(1), PNPM_PUBLISH_OPTIONS, places)?.length === 0,
	],
	...listed("docker podman").map(
		(name) =>
			[
				name,
				(args: ReadonlyArray<string>, places: OutwardPlaces) =>
					args[0] === "push" && listedOperands(args.slice(1), IMAGE_PUSH_OPTIONS, places)?.length === 1,
			] as const,
	),
	...[...SLURM_OPTIONS].map(
		([name, list]) =>
			[name, (args: ReadonlyArray<string>, places: OutwardPlaces) => listedOperands(args, list, places) !== null] as const,
	),
]);

/**
 * Under `safety.sandbox: required`, true when an outward line may leave the sandbox: the whole line is one
 * simple command with literal arguments ({@link literalSimpleCommand}), run from the workspace repository,
 * with a PATH on which no directory is writable; its CLI has an option list here, every option is on it, its
 * operands name no local repository, file outside the writable trees or this machine, and its argv reaches
 * outward on its own. Any other line runs inside the sandbox.
 */
export function outwardLineLeaves(command: string, places: OutwardPlaces): boolean {
	if (outwardShellReason(command) === null) return false;
	const words = literalSimpleCommand(command);
	if (words === null) return false;
	const [name = "", ...args] = words;
	if (!inWorkspaceRepository(places.cwd, places) || plantedOnPath(places)) return false;
	if (name === "git") return gitPushLeaves(args, places);
	const leaves = OUTWARD_ARGV.get(name);
	return leaves !== undefined && nameOutwardReason(name, args) !== null && leaves(args, places);
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
