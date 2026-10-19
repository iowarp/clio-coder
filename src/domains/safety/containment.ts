import { normalizedGitCommands } from "./git-command-normalization.js";
import { shellCommandSteps } from "./protected-artifacts.js";

/**
 * Containment at autonomy default: containment first, judgment second, asking
 * last. The operator's own bash and run_script calls run inside the
 * main-session sandbox (`src/core/sandbox/main-session.ts`) whenever a backend
 * exists, and a contained call needs no approval ask for what Clio cannot see
 * or bound in its command text, because the OS bounds where it writes and
 * hides the operator's credentials. A call leaves containment when it asks to
 * (`unsandboxed: true`) or when it reaches outward: publishing, a code host's
 * API, a cloud CLI or a network write all need the credentials the sandbox
 * hides, so they run unsandboxed after the ordinary default rails and the
 * safety judge.
 */

/** Code-host and cloud CLIs: every subcommand acts with credentials the sandbox hides. */
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

/** Words that run the command after them: the outward check reads through them. */
const WRAPPERS: ReadonlySet<string> = new Set([
	"timeout",
	"nohup",
	"nice",
	"time",
	"stdbuf",
	"ionice",
	"npx",
	"pnpx",
	"bunx",
	"xargs",
]);

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

function stepOutwardReason(words: ReadonlyArray<string>): string | null {
	const [head, ...args] = unwrapped(words);
	if (head === undefined) return null;
	const name = head.split("/").pop() ?? head;
	if (CREDENTIALED_CLIS.has(name)) return `${name} acts with the operator's credentials`;
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
 * Why a shell command reaches outward and so leaves the main-session sandbox,
 * or null when it stays inside. `git push` is read the way the classifier
 * marks it outward; the rest by the executable each step runs. A false match
 * only sends the call through the safety judge.
 */
export function outwardShellReason(command: string): string | null {
	if (
		normalizedGitCommands(command).some(
			(candidate) => /^git push(?:\s|$)/u.test(candidate) && !/(?:^|\s)--dry-run(?:\s|$)/u.test(candidate),
		)
	) {
		return "git push publishes commits";
	}
	for (const step of shellCommandSteps(command)) {
		const reason = stepOutwardReason([step.executable, ...step.args]);
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
