import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import path from "node:path";
import { canonicalizePath, canonicalizeRawPath } from "../../core/path-canonical.js";
import { discoverSecretMasks, isSecretPath } from "../../core/sandbox/secret-files.js";
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
	/** When given, receives why a secret the sandbox masks kept the line inside. */
	readonly held?: string[];
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

/** `target` as the operator reads it: relative to the workspace when inside it. */
function shownPath(target: string, places: OutwardPlaces): string {
	const relative = path.relative(places.workspace, target);
	if (relative === "") return ".";
	return relative.startsWith("..") || path.isAbsolute(relative) ? target : relative;
}

/**
 * True when the local input `value`, already inside a writable tree, would hand the CLI a secret the sandbox masks:
 * a secret file by its name as written or once links resolve, or a directory under which the sandbox's own cached
 * secret scan finds a masked file or ran out of budget. Outside the sandbox nothing masks it, so such a line stays
 * inside, and `places.held` learns which path held it.
 */
function heldBySecret(value: string, places: OutwardPlaces): boolean {
	const written = path.resolve(places.cwd, value);
	const real = canonicalizeRawPath(value, places.cwd);
	if (real === null) return false;
	let directory: boolean;
	try {
		directory = statSync(real).isDirectory();
	} catch {
		// A missing input hands the CLI nothing to send.
		return false;
	}
	const hold = (reason: string): true => {
		places.held?.push(reason);
		return true;
	};
	for (const target of new Set([written, real])) {
		const root = places.fileRoots.find((entry) => isSameOrDescendant(target, entry));
		if (root === undefined) continue;
		const relative = path.relative(root, target).split(path.sep).join("/");
		if (relative !== "" && isSecretPath(relative, real, directory))
			return hold(`${shownPath(target, places)} is a secret file the sandbox masks`);
	}
	if (!directory) return false;
	const scan = discoverSecretMasks({ workspaceRoots: [real] });
	if (scan.capped) return hold(`the secret scan of ${shownPath(real, places)} was capped`);
	const masked = scan.masks[0];
	return masked !== undefined && hold(`${shownPath(masked.path, places)} is a secret file the sandbox masks`);
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

/** True when git, finding no `.git` in `dir`, would take `dir` itself as a repository: a HEAD beside objects, refs or a commondir. */
function gitDirectoryLayout(dir: string): boolean {
	return (
		existsSync(path.join(dir, "HEAD")) &&
		["objects", "refs", "commondir"].some((entry) => existsSync(path.join(dir, entry)))
	);
}

/**
 * True when a line run from `dir` runs where git's own discovery lands on the workspace repository: `dir` lies in
 * the workspace outside every `.git` directory, and no directory from it up to the workspace holds a `.git` or is
 * laid out as a git directory, the workspace's own `.git` aside. So git and the CLIs that run git read the workspace
 * repository's config and hooks, which the sandbox keeps read-only. With `ownRepository` (git, gh) the workspace
 * must have that `.git`; another CLI may run from a workspace that has none.
 */
function inWorkspaceRepository(dir: string, places: OutwardPlaces, ownRepository: boolean): boolean {
	const real = canonicalizePath(dir);
	if (real === null || !isSameOrDescendant(real, places.workspace)) return false;
	if (path.relative(places.workspace, real).split(path.sep).includes(".git")) return false;
	for (let current = real; current !== places.workspace; current = path.dirname(current)) {
		if (path.dirname(current) === current) return false;
		if (existsSync(path.join(current, ".git")) || gitDirectoryLayout(current)) return false;
	}
	if (existsSync(path.join(places.workspace, ".git"))) return true;
	return !ownRepository && !gitDirectoryLayout(places.workspace);
}

/** The addresses that reach this machine: loopback, unspecified and every interface's own. */
function localAddresses(): Set<string> {
	const addresses = new Set(["::1", "::", "0.0.0.0"]);
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) addresses.add(entry.address.toLowerCase());
	}
	return addresses;
}

/** The names the hosts file gives an address of this machine. */
function hostsFileLocalNames(): Set<string> {
	const names = new Set<string>();
	let text = "";
	try {
		text = readFileSync("/etc/hosts", "utf8");
	} catch {
		return names;
	}
	const local = localAddresses();
	for (const line of text.split("\n")) {
		const [address = "", ...aliases] = line.replace(/#.*/u, "").trim().split(/\s+/u);
		if (!/^127\./u.test(address) && !local.has(address.toLowerCase())) continue;
		for (const alias of aliases) names.add(alias.replace(/\.$/u, "").toLowerCase());
	}
	return names;
}

/**
 * A host an outward line may not name, deny by default: an address in any spelling (a numeric, octal or hex last
 * label, as inet_aton and URL parsers read `0`, `2130706433`, `0x7f000001` or `127.1`; anything with a `:`, as
 * IPv6), a name that is not plain letters, digits, dots, `-` and `_`, one that starts with `-` and would read as an
 * option, `localhost` in any form, this machine's host name with any suffix, and a name the hosts file gives an
 * address of this machine.
 */
function hostRefused(host: string): boolean {
	const name = host
		.replace(/^[^@]*@/u, "")
		.replace(/^\[|\]$/gu, "")
		.replace(/\.$/u, "")
		.toLowerCase();
	if (!/^[a-z0-9_][a-z0-9._-]*$/u.test(name)) return true;
	const labels = name.split(".");
	if (/^(?:0x[0-9a-f]*|\d+)$/u.test(labels.at(-1) ?? "")) return true;
	if (labels[0] === "localhost" || labels.at(-1) === "localhost" || /^ip6-(?:localhost|loopback)$/u.test(name))
		return true;
	const self = hostname().toLowerCase().split(".")[0] ?? "";
	if (self !== "" && labels[0] === self) return true;
	return hostsFileLocalNames().has(name);
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
		if (word === "--") {
			const rest = args.slice(index + 1);
			const named = list.commandAfter === undefined ? rest : rest.slice(0, list.commandAfter - operands.length);
			// The CLI's own parser may still read an operand that starts with `-` as an option.
			return named.some((operand) => operand.startsWith("-")) ? null : [...operands, ...rest];
		}
		if (word === "-" || !word.startsWith("-")) {
			if (list.commandAfter !== undefined && operands.length === list.commandAfter)
				return [...operands, ...args.slice(index)];
			operands.push(word);
			continue;
		}
		if (/^-[^-]./u.test(word)) {
			// A cluster parses as its flags apart only when every letter is a listed flag that takes no value.
			if ([...word.slice(1)].every((letter) => /^[A-Za-z]$/u.test(letter) && list.flags.includes(`-${letter}`))) continue;
			return null;
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
		if (input && (!insideWritableRoots(value, places) || heldBySecret(value, places))) return null;
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

/** An `https`, `ssh` or `git` URL, or an scp-style address, on a host that is not this machine. */
function networkUrl(remote: string): boolean {
	if (remote.includes("::")) return false;
	const url = /^([A-Za-z][\w+.-]*):\/\/(?:[^@/]*@)?(\[[^\]]*\]|[^:/]*)/u.exec(remote);
	if (url !== null) return /^(?:https?|ssh|git)$/iu.test(url[1] ?? "") && !hostRefused(url[2] ?? "");
	const scp = /^(?:[\w.-]+@)?([\w.-]+):/u.exec(remote);
	return scp !== null && !hostRefused(scp[1] ?? "");
}

/** Git's exit status and output for `args` in `dir`; status null when it timed out or said too much. Reads config, runs nothing. */
function runGit(dir: string, args: ReadonlyArray<string>): { status: number | null; stdout: string } {
	const result = spawnSync("git", args, {
		cwd: dir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 2_000,
		maxBuffer: 1 << 20,
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
	});
	return {
		status: result.error === undefined ? result.status : null,
		stdout: typeof result.stdout === "string" ? result.stdout : "",
	};
}

/** Git's output for `args` in `dir`, or null when it failed. */
function gitRead(dir: string, args: ReadonlyArray<string>): string | null {
	const { status, stdout } = runGit(dir, args);
	return status === 0 ? stdout : null;
}

/**
 * Every URL git would fetch from or push to for each configured remote, `pushurl`, `insteadOf` and
 * `pushInsteadOf` applied, by remote name; null when git cannot list them.
 */
function remoteUrls(dir: string): Map<string, string[]> | null {
	const listing = gitRead(dir, ["remote", "-v"]);
	if (listing === null) return null;
	const urls = new Map<string, string[]>();
	for (const line of listing.split("\n")) {
		if (line === "") continue;
		const parsed = /^([^\t]+)\t(.*) \((?:fetch|push)\)$/u.exec(line);
		if (parsed === null) return null;
		const [, name = "", url = ""] = parsed;
		urls.set(name, [...(urls.get(name) ?? []), url]);
	}
	return urls;
}

/**
 * The remote a `git push` with no remote operand pushes to, as git picks it: the branch's `pushRemote`, then
 * `remote.pushDefault`, then the branch's `remote`, then `origin`. Null when git cannot say.
 */
function defaultPushRemote(dir: string): string | null {
	const head = gitRead(dir, ["symbolic-ref", "-q", "--short", "HEAD"])?.trim();
	const keys = [
		...(head ? [`branch.${head}.pushRemote`] : []),
		"remote.pushDefault",
		...(head ? [`branch.${head}.remote`] : []),
	];
	for (const key of keys) {
		const result = runGit(dir, ["config", "--get", key]);
		// Exit 1 is "not set"; anything else is an answer git could not give.
		if (result.status === 1) continue;
		if (result.status !== 0) return null;
		const value = result.stdout.trim();
		if (value !== "") return value;
	}
	return "origin";
}

/** True when every `url.<base>.insteadOf` or `pushInsteadOf` rewrite that matches `url` leads to a network URL. */
function rewritesStayNetwork(dir: string, url: string): boolean {
	const result = runGit(dir, ["config", "-z", "--get-regexp", "^url\\..*\\.(push)?insteadof$"]);
	// Exit 1 is "no such key": no rewrite is configured.
	if (result.status === 1) return true;
	if (result.status !== 0) return false;
	for (const entry of result.stdout.split("\0")) {
		if (entry === "") continue;
		const newline = entry.indexOf("\n");
		const key = newline === -1 ? entry : entry.slice(0, newline);
		const prefix = newline === -1 ? "" : entry.slice(newline + 1);
		const base = key.replace(/^url\./u, "").replace(/\.(?:push)?insteadof$/iu, "");
		if (prefix !== "" && url.startsWith(prefix) && !networkUrl(base)) return false;
	}
	return true;
}

/**
 * A push remote that is a network URL, or a configured remote's name whose every URL, as git rewrites it, is one:
 * not a local repository or a remote helper. A name with no remote behind it is a path to git.
 */
function networkRemote(remote: string | undefined, here: string): boolean {
	if (remote !== undefined && !/^[A-Za-z0-9_][\w.-]*$/u.test(remote))
		return networkUrl(remote) && rewritesStayNetwork(here, remote);
	if (remote !== undefined && existsSync(path.resolve(here, remote))) return false;
	const name = remote ?? defaultPushRemote(here);
	const urls = name === null ? undefined : remoteUrls(here)?.get(name);
	return urls !== undefined && urls.length > 0 && urls.every(networkUrl);
}

/** True when every configured remote of the repository at `here` fetches from and pushes to network URLs only. */
function everyRemoteNetwork(here: string): boolean {
	const urls = remoteUrls(here);
	return urls !== null && [...urls.values()].every((list) => list.every(networkUrl));
}

/**
 * True when a `git` argv pushes and may leave: global options `-C` and `--no-pager` only, `-C` into the
 * workspace repository, push options from {@link GIT_PUSH_OPTIONS}, and a remote whose every push URL, as git
 * resolves and rewrites it, is a network URL.
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
	if (args[index] !== "push" || !inWorkspaceRepository(here, places, true)) return false;
	const operands = listedOperands(args.slice(index + 1), GIT_PUSH_OPTIONS, places);
	if (operands === null) return false;
	return networkRemote(operands[0], here);
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

const RSYNC_OPTIONS: OptionList = {
	flags: listed(
		"-a --archive -r --recursive -v --verbose -z --compress -n --dry-run -c --checksum -t --times -u --update -h --human-readable -P --progress --partial --delete",
	),
	values: listed("--exclude --include"),
};

/** The host of a remote rsync operand, or null for a local path. */
function remoteOperandHost(operand: string): string | null {
	if (operand.startsWith("rsync://")) return /^rsync:\/\/(?:[^@/]*@)?([^:/]*)/u.exec(operand)?.[1] ?? "";
	return /^([^/:]*):/u.exec(operand)?.[1] ?? null;
}

/**
 * rsync: every remote operand on another host, every local one in a writable tree, and no local source a secret the
 * sandbox masks or a directory holding one. The last operand is the destination, which rsync writes and never sends.
 */
function copyOperandsStay(operands: ReadonlyArray<string>, places: OutwardPlaces): boolean {
	return operands.every((operand, index) => {
		const host = remoteOperandHost(operand);
		if (host !== null) return !hostRefused(host);
		return insideWritableRoots(operand, places) && (index === operands.length - 1 || !heldBySecret(operand, places));
	});
}

/** An http or https URL whose host is not this machine. */
function webUrlOffHost(text: string): boolean {
	if (!/^https?:\/\//iu.test(text)) return false;
	try {
		return !hostRefused(new URL(text).hostname);
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
	if (!(noun === "api" ? operands.length >= 1 : GH_VERBS.get(noun)?.includes(operands[0] ?? "") === true)) return false;
	// gh picks its own remote and can push the branch to it.
	return everyRemoteNetwork(places.cwd);
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

/**
 * curl: no output, upload, form, config or `@file` value, and an HTTP URL. No `-L`: a redirect could send the
 * request to this machine, which the URL check never saw.
 */
const CURL_OPTIONS: OptionList = {
	flags: listed("-s --silent -S --show-error -f --fail --fail-with-body -i --include --compressed"),
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
 * open-ended, it runs workspace code by design (terraform, pulumi, srun, salloc), it follows links both ways
 * (scp; rsync without `-L` copies a link as a link), or no line of it needs to leave. npm and pnpm publish leave only
 * with `--ignore-scripts`, since the lifecycle scripts come from a package.json the sandbox can edit, and only when
 * the package directory holds no secret file the sandbox masks: the sandbox writes the ignore rules that pick the pack.
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
			return !hostRefused(url !== null ? (url[1] ?? "") : host);
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
		(args, places) =>
			args[0] === "publish" &&
			args.includes("--ignore-scripts") &&
			listedOperands(args.slice(1), NPM_PUBLISH_OPTIONS, places)?.length === 0 &&
			!heldBySecret(".", places),
	],
	[
		"pnpm",
		(args, places) =>
			args[0] === "publish" &&
			args.includes("--ignore-scripts") &&
			listedOperands(args.slice(1), PNPM_PUBLISH_OPTIONS, places)?.length === 0 &&
			!heldBySecret(".", places),
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
 * operands name no local repository, file outside the writable trees, input holding a secret the sandbox masks or
 * this machine, and its argv reaches outward on its own. Any other line runs inside the sandbox.
 */
export function outwardLineLeaves(command: string, places: OutwardPlaces): boolean {
	if (outwardShellReason(command) === null) return false;
	const words = literalSimpleCommand(command);
	if (words === null) return false;
	const [name = "", ...args] = words;
	if (!inWorkspaceRepository(places.cwd, places, name === "git" || name === "gh") || plantedOnPath(places)) return false;
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
