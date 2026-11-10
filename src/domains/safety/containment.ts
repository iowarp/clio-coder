import { normalizedGitCommands } from "./git-command-normalization.js";
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
