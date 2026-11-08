/**
 * Deterministic code-step runner.
 *
 * A known command is not a judgement call. Anything whose invocation can be
 * written down runs here as a subprocess: it costs nothing, finishes in
 * milliseconds, and returns the same answer every time. What comes back is a
 * typed `code-report`, sealed like an agent's terminal result, so a red suite
 * reaches the next builder through the same door an agent's report would have
 * used.
 *
 * Unattended by construction: argv from the repo registry, fixed cwd, closed
 * environment allowlist, bounded timeout, byte-capped capture, no stdin, no
 * permission prompt, no shell.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { AI_AGENT_NAME } from "../../core/agent-environment.js";
import type { CommitAttributionEvidence } from "../../core/commit-attribution.js";
import {
	gitCommitAttributionEnabled,
	reportCommitAttributionDiagnostic,
	withManagedGitCommitAttributionEnvironment,
} from "../../core/git-commit-attribution.js";
import { internalGitArgv } from "../../core/internal-git.js";
import {
	createProcessGroupCleanup,
	type ProcessGroupCleanupStatus,
	SAFE_EXEC_DEFAULT_KILL_GRACE_MS,
	SAFE_EXEC_PIPE_DRAIN_BOUND_MS,
} from "../../core/safe-exec.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { scrubSandboxEnv } from "../../core/sandbox/env-scrub.js";
import { type MainSandboxPolicy, planMainSandboxSpawn } from "../../core/sandbox/main-session.js";
import { clioStateDir } from "../../core/xdg.js";
import { type CheckoutSnapshot, changedCheckoutPaths, snapshotCheckout } from "../../tools/checkout-changes.js";
import {
	PLAYBOOK_COMMAND_BASE_ENV,
	type PlaybookCommand,
	validatePlaybookCommandArgs,
} from "../agents/playbook-commands.js";
import type { CodeReportResult } from "../agents/result-contract.js";

/** Bytes of command output retained for the artifact log. */
export const CODE_STEP_CAPTURE_MAX_BYTES = 1_048_576;
/**
 * Bytes of command output carried inside the report itself. Enough for a
 * builder to act on without opening the artifact, bounded so a runaway stack
 * trace cannot swamp the next agent's context window.
 */
export const CODE_STEP_EXCERPT_MAX_BYTES = 8_000;

export const CODE_STEP_TIMEOUT_EXIT_CODE = 124;
export const CODE_STEP_SPAWN_FAILURE_EXIT_CODE = 127;
/** A commit step asked to record a tree with nothing in it. */
export const CODE_STEP_EMPTY_DIFF_EXIT_CODE = 125;
export const CODE_STEP_EMPTY_DIFF_MESSAGE = "nothing to commit: the workspace has no changes to record";

/**
 * The registered commit command is a bare `git commit` and the workers who made the work never run git, so code stages
 * it. The tree a commit records is the tree the run verified, so it takes every change since the last commit point.
 * Attributing paths to steps would commit a partial tree after a resume, when a repair ran in the earlier process or a
 * rerun source found its work already done.
 */
export interface CommitStage {
	/** Workspace state at the last commit point; null when the resumed run left none, which stages no changes. */
	baseline: WorkspaceChangeSnapshot | null;
	/** A required artifact of a source step, staged even when the repository ignores it. */
	artifacts: ReadonlyArray<string>;
}

export const CODE_STEP_TRUNCATION_MARKER = "\n[... output truncated, see artifact ...]\n";

export interface CodeStepRunInput {
	/** A run id the caller announced before the command started; minted here when absent. */
	runId?: string;
	/** Run-local mutation paths supplied only for a fleet loop's code check. */
	mutatedPaths?: ReadonlyArray<string>;
	/** Caller notes appended to the command check's evidence, such as an ancestor whose changes could not be measured. */
	notes?: ReadonlyArray<string>;
	/** Already resolved literal arguments; never interpolated a second time. */
	args?: ReadonlyArray<string>;
	stepId: string;
	command: PlaybookCommand;
	/** Absolute workspace root the command's relative cwd resolves against. */
	workspaceRoot: string;
	/** Absolute directory the command log is written to; omitted means no artifact. */
	artifactDir?: string;
	/** Shared stdout/stderr capture ceiling; defaults to CODE_STEP_CAPTURE_MAX_BYTES. */
	maxOutputBytes?: number;
	/** Full process environment the allowlist is drawn from. Defaults to the orchestrator's. */
	env?: NodeJS.ProcessEnv;
	/**
	 * Values for the registry's whole-token `{{name}}` argv placeholders. This
	 * is how an agent's commit message reaches `git commit` without the agent
	 * authoring a command: the repository declares the invocation, code fills
	 * one declared slot, and the value is a single argv element that no shell
	 * ever sees.
	 */
	substitutions?: Readonly<Record<string, string>>;
	/**
	 * Refuse to run against a clean tree. A commit that would record nothing is
	 * a failure, not a no-op: it means the step it describes produced nothing.
	 */
	requireWorkspaceChanges?: boolean;
	/** What a commit step records, staged before the empty-tree check and the registered command. */
	stage?: CommitStage;
	/** Trusted attribution facts for a commit command; omitted uses Clio-authored child-process defaults. */
	commitAttribution?: {
		enabled: boolean;
		evidence: Readonly<CommitAttributionEvidence>;
	};
	/**
	 * Run the command, and every changed test it adds, inside the main-session
	 * sandbox. Host verification uses it for checks a worker may have written;
	 * a backend gone at spawn time refuses the command instead of running it bare.
	 */
	shellSandbox?: MainSandboxPolicy;
	signal?: AbortSignal;
}

/**
 * Receipt-equivalent provenance for one deterministic run. It records exactly
 * what ran, where, for how long, and what came back, without inventing any of
 * the model-run facts (tokens, cost, route) a code step does not have.
 */
/** Where one fleet root's code steps keep their captured output logs; the record itself is journaled (#434). */
export function codeStepDir(rootId: string): string {
	return join(clioStateDir(), "code-steps", rootId);
}

export interface CodeStepRecord {
	version: 1;
	runId: string;
	stepId: string;
	commandId: string;
	argv: ReadonlyArray<string>;
	/** Individual command outcomes when a check also ran changed test files. */
	commandRuns?: ReadonlyArray<{ argv: ReadonlyArray<string>; cwd: string; exitCode: number; durationMs: number }>;
	cwd: string;
	envNames: ReadonlyArray<string>;
	timeoutMs: number;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	exitCode: number;
	signal: string | null;
	timedOut: boolean;
	/** Bytes the command produced before any cap was applied. */
	outputBytes: number;
	outputTruncated: boolean;
	/** SHA-256 over the captured (post-cap) output, so the artifact is checkable. */
	outputDigest: string;
	artifactPaths: ReadonlyArray<string>;
	/** SHA-256 over the canonical report, the code step's stand-in for a receipt digest. */
	reportDigest: string;
}

export interface CodeStepOutcome {
	report: CodeReportResult;
	record: CodeStepRecord;
	/** Stdout retained within the shared capture cap, for structured command judgments. */
	stdout: string;
	/** Canonical JSON of the report; this is the text that crosses plan edges. */
	output: string;
	/** Whether the command's process started: false when the step refused before launch or the spawn itself failed. */
	launched: boolean;
}

/** Stable stringification of the report, so its digest is reproducible. */
export function canonicalCodeReport(report: CodeReportResult): string {
	return JSON.stringify({
		passed: report.passed,
		exitCode: report.exitCode,
		checks: report.checks.map((check) => ({ name: check.name, passed: check.passed, evidence: check.evidence })),
		artifactPaths: [...report.artifactPaths],
		outputExcerpt: report.outputExcerpt,
	});
}

export function codeReportDigest(report: CodeReportResult): string {
	return createHash("sha256").update(canonicalCodeReport(report), "utf8").digest("hex");
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Keep the tail: a failing command explains itself at the end, not the start. */
function tailUtf8(value: Buffer, limit: number, marker: string): { text: string; truncated: boolean } {
	if (value.length <= limit) return { text: value.toString("utf8"), truncated: false };
	return { text: marker + value.subarray(value.length - limit).toString("utf8"), truncated: true };
}

function resolveCwd(command: PlaybookCommand, workspaceRoot: string): string {
	const root = resolve(workspaceRoot);
	if (command.cwd === "") return root;
	const target = resolve(root, command.cwd);
	if (!target.startsWith(root)) throw new Error(`code step: command '${command.id}' cwd escapes the workspace`);
	return target;
}

/** Closed environment: the base allowlist plus whatever this command declared. */
function codeStepEnv(command: PlaybookCommand, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const names = [...PLAYBOOK_COMMAND_BASE_ENV, ...command.env];
	const env: NodeJS.ProcessEnv = {};
	for (const name of names) {
		const value = source[name];
		if (value !== undefined) env[name] = value;
	}
	env.AI_AGENT = AI_AGENT_NAME;
	return env;
}

const ARGV_PLACEHOLDER = /^\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}$/u;

/**
 * Bind a registered command's argv.
 *
 * Substitution is whole-token only. `{{commitMessage}}` is one argv element and
 * becomes exactly one argv element; a token that merely embeds a placeholder is
 * refused, so a supplied value can never grow a flag or split into two
 * arguments. An unbound placeholder is an error rather than an empty string:
 * committing with an empty message is the failure this check exists to stop.
 */
export function resolveCommandArgv(
	command: PlaybookCommand,
	substitutions: Readonly<Record<string, string>> = {},
): string[] {
	return command.argv.map((token) => {
		const match = ARGV_PLACEHOLDER.exec(token);
		if (match === null) {
			if (token.includes("{{")) {
				throw new Error(`code step: command '${command.id}' argv token '${token}' embeds a placeholder`);
			}
			return token;
		}
		const name = match[1] ?? "";
		const value = substitutions[name];
		if (value === undefined || value.length === 0) {
			throw new Error(`code step: command '${command.id}' has no value for placeholder '{{${name}}}'`);
		}
		return value;
	});
}

/** Whether the checkout has anything a commit could record. */
export function workspaceHasChanges(root: string): boolean {
	const status = execFileSync("git", internalGitArgv(["-C", root, "status", "--porcelain", "-uall"]), {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	return status.trim().length > 0;
}

export interface WorkspaceChangeSnapshot {
	checkout: CheckoutSnapshot;
	/** The workspace's path below the checkout top level, "" or ending in "/". */
	prefix: string;
	/** What git ignored under the workspace at a commit point, relative to it, a wholly ignored directory as `dir/`. */
	ignored?: ReadonlyArray<string>;
}

/**
 * Git-visible file state under `root`. A code step records nothing about what
 * it wrote, so the fleet diffs one snapshot before and one after the command
 * to learn which files it created or edited. Null outside a git workspace or
 * when git cannot report status.
 */
export function workspaceChangeSnapshot(root: string): WorkspaceChangeSnapshot | null {
	const checkout = snapshotCheckout(root);
	if (checkout === null) return null;
	let prefix: string;
	try {
		prefix = relative(checkout.root, realpathSync(root));
	} catch {
		return null;
	}
	if (prefix.startsWith("..") || isAbsolute(prefix)) return null;
	return { checkout, prefix: prefix === "" ? "" : `${prefix.split(sep).join("/")}/` };
}

/**
 * A commit point's snapshot. It also records what git ignored then, because a file that only stops being ignored did not
 * change: a worker dropping a .gitignore rule must not commit the pre-existing .env behind it. Null like the snapshot.
 */
export function commitPointSnapshot(root: string): WorkspaceChangeSnapshot | null {
	const snapshot = workspaceChangeSnapshot(root);
	if (snapshot === null) return null;
	try {
		const ignored = execFileSync(
			"git",
			internalGitArgv(["-C", root, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]),
			{ encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
		);
		return { ...snapshot, ignored: ignored.split("\0").filter((path) => path.length > 0) };
	} catch {
		// Null stages no changes, the same answer as a status git could not report.
		return null;
	}
}

/** Changed paths inside the workspace, relative to it, as later checks resolve them. */
export function workspaceChangedPaths(before: WorkspaceChangeSnapshot, after: WorkspaceChangeSnapshot): string[] {
	if (before.prefix !== after.prefix) return [];
	return changedCheckoutPaths(before.checkout, after.checkout)
		.filter((path) => path.startsWith(before.prefix))
		.map((path) => path.slice(before.prefix.length));
}

interface CommitStageResult {
	leftOut: ReadonlyArray<string>;
	alreadyStaged: ReadonlyArray<string>;
}

const COMMIT_BASELINE_FILE = "commit-baseline.json";

/** Durable so a resumed run in a new process commits against the same point. */
export function writeCommitBaseline(dir: string, snapshot: WorkspaceChangeSnapshot): void {
	const { checkout, prefix, ignored } = snapshot;
	safeResourceWrite(
		join(dir, COMMIT_BASELINE_FILE),
		JSON.stringify({ root: checkout.root, prefix, paths: [...checkout.paths], ignored: ignored ?? [] }),
	);
}

export function readCommitBaseline(dir: string): WorkspaceChangeSnapshot | null {
	try {
		const record = JSON.parse(readFileSync(join(dir, COMMIT_BASELINE_FILE), "utf8")) as {
			root: string;
			prefix: string;
			paths: Array<[string, string]>;
			ignored?: string[];
		};
		return {
			checkout: { root: record.root, paths: new Map(record.paths) },
			prefix: record.prefix,
			...(record.ignored !== undefined ? { ignored: record.ignored } : {}),
		};
	} catch {
		// Absent for a run that predates baselines or died before writing one; the caller stages no changes.
		return null;
	}
}

function ignoredAt(baseline: WorkspaceChangeSnapshot | null): (path: string) => boolean {
	const entries = baseline?.ignored ?? [];
	const files = new Set(entries.filter((entry) => !entry.endsWith("/")));
	const directories = entries.filter((entry) => entry.endsWith("/"));
	return (path) => files.has(path) || directories.some((directory) => path.startsWith(directory));
}

/** The paths git ignores now. It consults the index, so a tracked file never reads as ignored. */
function ignoredNow(root: string, paths: ReadonlyArray<string>): ReadonlySet<string> {
	if (paths.length === 0) return new Set();
	try {
		const out = execFileSync("git", internalGitArgv(["-C", root, "check-ignore", "-z", "--stdin"]), {
			input: `${paths.join("\0")}\0`,
			encoding: "utf8",
			timeout: 30_000,
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["pipe", "pipe", "pipe"],
		});
		return new Set(out.split("\0").filter((path) => path.length > 0));
	} catch (err) {
		// Exit 1 is git's answer for "none of them"; anything else is a real failure.
		if ((err as { status?: number }).status === 1) return new Set();
		throw err;
	}
}

/** Stage a commit's outputs and name what git will do beyond them. */
function stageCommitOutputs(root: string, stage: CommitStage): CommitStageResult {
	const now = workspaceChangeSnapshot(root);
	if (now === null) throw new Error("git could not report the workspace status");
	const visible = [...now.checkout.paths.keys()]
		.filter((path) => path.startsWith(now.prefix))
		.map((path) => path.slice(now.prefix.length));
	// Only a path git reports now goes in. One that merely left the status since the baseline may have become ignored,
	// such as a pre-existing untracked .env behind a new .gitignore rule, and update-index does not consult ignore rules.
	const visibleNow = new Set(visible);
	const produced = stage.baseline === null ? [] : workspaceChangedPaths(stage.baseline, now);
	// An untracked embedded repository lists as `dir/`, which only `git add` can record; it stays out and is named.
	const wasIgnored = ignoredAt(stage.baseline);
	const candidates = produced.filter((path) => visibleNow.has(path) && !path.endsWith("/") && !wasIgnored(path));
	// `git rm --cached` of a file now ignored shows as a staged deletion with the file still on disk. Taking it through
	// update-index would re-add that content, so the deletion stays as staged and the commit records it.
	const ignored = ignoredNow(root, candidates);
	const staged = candidates.filter((path) => !ignored.has(path));
	// update-index takes a path that is new, edited, deleted or already staged alike, where `git add -A` refuses a
	// staged deletion as an unmatched pathspec. --replace lets a file take the place of a directory, and the reverse.
	const paths = [...staged, ...stage.artifacts];
	if (paths.length > 0) {
		execFileSync(
			"git",
			internalGitArgv(["-C", root, "update-index", "--add", "--remove", "--replace", "-z", "--stdin"]),
			{
				input: `${paths.join("\0")}\0`,
				timeout: 30_000,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
	}
	// Not --relative: a bare `git commit` records staged paths outside a subdirectory workspace too.
	const index = execFileSync(
		"git",
		internalGitArgv(["-C", root, "diff", "--cached", "--no-renames", "--name-only", "-z"]),
		{
			encoding: "utf8",
			timeout: 30_000,
			maxBuffer: 16 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		},
	)
		.split("\0")
		.filter((path) => path.length > 0);
	const inside = index.filter((path) => path.startsWith(now.prefix)).map((path) => path.slice(now.prefix.length));
	const outside = index.filter((path) => !path.startsWith(now.prefix));
	const inIndex = new Set(inside);
	const ours = new Set(paths);
	return {
		leftOut: visible.filter((path) => !inIndex.has(path)),
		alreadyStaged: [...inside.filter((path) => !ours.has(path)), ...outside],
	};
}

function stagingNotes({ leftOut, alreadyStaged }: CommitStageResult): string[] {
	const named = (paths: ReadonlyArray<string>) => `${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", ..." : ""}`;
	return [
		...(leftOut.length > 0 ? [`${leftOut.length} other change(s) left out of this commit: ${named(leftOut)}`] : []),
		// A bare `git commit` records the whole index, so what was staged before this step goes with it.
		...(alreadyStaged.length > 0
			? [
					`${alreadyStaged.length} change(s) were staged before this step, and a commit records them too: ${named(alreadyStaged)}`,
				]
			: []),
	];
}

export function newCodeRunId(): string {
	return `code-${createHash("sha256")
		.update(`${process.pid}:${Date.now()}:${Math.random()}`)
		.digest("hex")
		.slice(0, 12)}`;
}

interface SpawnOutcome {
	exitCode: number;
	signal: string | null;
	timedOut: boolean;
	captured: Buffer;
	stdout: Buffer;
	outputBytes: number;
	spawnError: string | null;
	/** Whether a process was created; a missing executable fails before one exists. */
	launched: boolean;
}

async function spawnCommand(input: CodeStepRunInput, cwd: string, argv: ReadonlyArray<string>): Promise<SpawnOutcome> {
	const command = input.command;
	const captureMaxBytes = input.maxOutputBytes ?? CODE_STEP_CAPTURE_MAX_BYTES;
	if (!Number.isSafeInteger(captureMaxBytes) || captureMaxBytes <= 0)
		throw new Error("code step: maxOutputBytes must be a positive safe integer");
	const [executable, ...args] = argv;
	if (executable === undefined) throw new Error(`code step: command '${command.id}' has no executable`);
	const contained =
		input.shellSandbox === undefined ? undefined : planMainSandboxSpawn(input.shellSandbox, { argv: [...argv] }, cwd);
	if (contained?.kind === "refused") {
		return {
			exitCode: CODE_STEP_SPAWN_FAILURE_EXIT_CODE,
			signal: null,
			timedOut: false,
			captured: Buffer.from(`${contained.message}\n`, "utf8"),
			stdout: Buffer.alloc(0),
			outputBytes: 0,
			spawnError: contained.message,
			launched: false,
		};
	}
	const source = input.env ?? process.env;
	const allowed = codeStepEnv(command, source);
	return await new Promise<SpawnOutcome>((resolvePromise) => {
		const attribution = withManagedGitCommitAttributionEnvironment(
			contained === undefined ? allowed : scrubSandboxEnv(allowed, contained.env, source).env,
			{
				cwd,
				enabled: input.commitAttribution?.enabled ?? gitCommitAttributionEnabled(process.env),
				...(input.commitAttribution?.evidence === undefined ? {} : { evidence: input.commitAttribution.evidence }),
			},
		);
		reportCommitAttributionDiagnostic(attribution.diagnostic);
		const chunks: Buffer[] = [];
		const stdoutChunks: Buffer[] = [];
		let outputBytes = 0;
		let captured = 0;
		let settled = false;
		let timedOut = false;
		let spawnError: string | null = null;
		let leaderExit: { code: number | null; signal: string | null } | null = null;
		let closed = false;
		let drainFinished = false;
		let pipeDrainIncomplete = false;
		let drainTimer: ReturnType<typeof setTimeout> | undefined;
		let cleanupStatus: ProcessGroupCleanupStatus | null = null;
		const child = spawn(contained?.file ?? executable, contained?.args ?? args, {
			cwd,
			env: attribution.env,
			stdio: ["ignore", "pipe", "pipe"],
			// The command leads its own process group, so a timeout kills the
			// whole tree rather than orphaning a test runner's children.
			detached: process.platform !== "win32",
		});
		if (contained !== undefined) child.once("exit", contained.afterExit);
		const collect = (chunk: Buffer, stdout: boolean): void => {
			outputBytes += chunk.length;
			if (captured >= captureMaxBytes) return;
			const room = captureMaxBytes - captured;
			const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
			chunks.push(slice);
			if (stdout) stdoutChunks.push(slice);
			captured += slice.length;
		};
		child.stdout?.on("data", (chunk: Buffer) => collect(chunk, true));
		child.stderr?.on("data", (chunk: Buffer) => collect(chunk, false));
		const groupExists = (): boolean => {
			if (child.pid === undefined) return false;
			if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
			try {
				process.kill(-child.pid, 0);
				return true;
			} catch (error) {
				return (error as NodeJS.ErrnoException).code !== "ESRCH";
			}
		};
		const owner = createProcessGroupCleanup({
			graceMs: SAFE_EXEC_DEFAULT_KILL_GRACE_MS,
			probe: groupExists,
			signal: (signal) => {
				if (child.pid === undefined) return false;
				if (process.platform === "win32") return child.kill(signal);
				try {
					process.kill(-child.pid, signal);
					return true;
				} catch (error) {
					return (error as NodeJS.ErrnoException).code !== "ESRCH";
				}
			},
			onDone: (status) => {
				cleanupStatus = status;
				boundDrain();
				finish();
			},
		});
		const timer = setTimeout(() => {
			timedOut = true;
			owner.kill();
		}, command.timeoutMs);
		const onAbort = (): void => {
			owner.kill();
		};
		input.signal?.addEventListener("abort", onAbort, { once: true });
		function boundDrain(): void {
			if (closed || drainTimer !== undefined) return;
			drainTimer = setTimeout(() => {
				drainFinished = true;
				pipeDrainIncomplete = !child.stdout.readableEnded || !child.stderr.readableEnded;
				child.stdout.destroy();
				child.stderr.destroy();
				finish();
			}, SAFE_EXEC_PIPE_DRAIN_BOUND_MS);
		}
		function finish(): void {
			if (settled || cleanupStatus === null || (!closed && !drainFinished)) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(drainTimer);
			input.signal?.removeEventListener("abort", onAbort);
			child.unref();
			const cleanupFailure = cleanupStatus.incomplete
				? "command process group survived bounded cleanup"
				: pipeDrainIncomplete
					? "command output pipes did not drain before the cleanup deadline"
					: null;
			const exitCode = timedOut
				? CODE_STEP_TIMEOUT_EXIT_CODE
				: spawnError !== null
					? CODE_STEP_SPAWN_FAILURE_EXIT_CODE
					: (leaderExit?.code ?? (leaderExit?.signal ? 128 : 1));
			resolvePromise({
				exitCode: cleanupFailure !== null && exitCode === 0 ? 1 : exitCode,
				signal: leaderExit?.signal ?? null,
				timedOut,
				captured: Buffer.concat(chunks),
				stdout: Buffer.concat(stdoutChunks),
				outputBytes,
				spawnError: spawnError ?? cleanupFailure,
				launched: child.pid !== undefined,
			});
		}
		child.on("error", (error) => {
			// A missing binary lands here. Exit 127 with the real message beats a
			// preflight probe that guesses.
			spawnError = error instanceof Error ? error.message : String(error);
			if (child.pid === undefined) {
				owner.dispose();
				cleanupStatus = { descendantsCleaned: false, incomplete: false };
			} else owner.kill();
		});
		child.once("exit", (code, signal) => {
			leaderExit = { code, signal };
			clearTimeout(timer);
			boundDrain();
			owner.leaderExited();
			finish();
		});
		child.on("close", (code, signal) => {
			closed = true;
			leaderExit ??= { code, signal };
			if (child.pid !== undefined) owner.leaderExited();
			finish();
		});
		if (input.signal?.aborted) onAbort();
	});
}

/**
 * Every refusal runCodeStep can throw before it spawns anything. A caller that
 * announces a step as started runs this first, so a step that could never
 * start is reported as an error rather than as running.
 */
export function preflightCodeStep(
	input: Pick<CodeStepRunInput, "command" | "workspaceRoot" | "artifactDir" | "args" | "substitutions">,
): { cwd: string; argv: string[] } {
	const command = input.command;
	if (input.artifactDir !== undefined && !isAbsolute(input.artifactDir)) {
		throw new Error("code step: artifactDir must be absolute");
	}
	const cwd = resolveCwd(command, input.workspaceRoot);
	const extraArgs = input.args ?? [];
	if (
		extraArgs.length > 64 ||
		extraArgs.some((arg) => typeof arg !== "string" || arg.includes("\0") || arg.length > 8192)
	) {
		throw new Error("code step: invalid additional arguments");
	}
	validatePlaybookCommandArgs(command, extraArgs);
	return { cwd, argv: [...resolveCommandArgv(command, input.substitutions), ...extraArgs] };
}

/**
 * Run one registered command and return its typed report plus the provenance
 * record. Never throws for a failing command: a red suite is a successful run
 * of the runner and a conformant report, and the plan decides what that means.
 */
export async function runCodeStep(input: CodeStepRunInput): Promise<CodeStepOutcome> {
	const command = input.command;
	const { cwd, argv } = preflightCodeStep(input);
	const runId = input.runId ?? newCodeRunId();
	const startedAtMs = Date.now();
	const clock = process.hrtime.bigint();
	const startedAt = new Date(startedAtMs).toISOString();
	let stageFailure: string | null = null;
	let notes = input.notes ?? [];
	if (input.stage !== undefined) {
		try {
			notes = [...notes, ...stagingNotes(stageCommitOutputs(input.workspaceRoot, input.stage))];
		} catch (err) {
			stageFailure = `could not stage the commit: ${err instanceof Error ? err.message : String(err)}`;
		}
	}
	let emptyWorkspace = false;
	if (stageFailure === null && input.requireWorkspaceChanges === true) {
		try {
			emptyWorkspace = !workspaceHasChanges(cwd);
		} catch (err) {
			stageFailure = `could not read the workspace status: ${err instanceof Error ? err.message : String(err)}`;
		}
	}
	const refusal = stageFailure ?? (emptyWorkspace ? CODE_STEP_EMPTY_DIFF_MESSAGE : null);
	let spawned =
		refusal !== null
			? {
					exitCode: stageFailure !== null ? 1 : CODE_STEP_EMPTY_DIFF_EXIT_CODE,
					signal: null,
					timedOut: false,
					captured: Buffer.from(`${refusal}\n`, "utf8"),
					stdout: Buffer.alloc(0),
					outputBytes: 0,
					spawnError: null,
					launched: false,
				}
			: await spawnCommand(input, cwd, argv);
	const launched = spawned.launched;
	const primaryDurationMs = Number((process.hrtime.bigint() - clock) / 1_000_000n);
	const primaryEvidence =
		(refusal ??
			(spawned.timedOut
				? `timed out after ${command.timeoutMs}ms (exit ${spawned.exitCode})`
				: `exit ${spawned.exitCode} in ${primaryDurationMs}ms`)) + (notes.length > 0 ? `; ${notes.join("; ")}` : "");
	const checks = [
		{
			name: command.id,
			passed: spawned.exitCode === 0,
			evidence: `\`${argv.join(" ")}\` ${primaryEvidence}`,
		},
	];
	const commandRuns = [{ argv: [...argv], cwd, exitCode: spawned.exitCode, durationMs: primaryDurationMs }];
	const testFiles = input.mutatedPaths?.length
		? (await import("../../tools/verify/test-files.js")).resolveTestFileChecks(input.workspaceRoot, input.mutatedPaths)
		: { checks: [], notes: [], refusals: [] };
	// A changed test that cannot be run fails the step so the loop repairs or reports it, never a silent pass.
	for (const refusal of testFiles.refusals) {
		checks.push({ name: "changed tests", passed: false, evidence: refusal });
		spawned = { ...spawned, exitCode: spawned.exitCode === 0 ? 1 : spawned.exitCode };
	}
	for (const test of testFiles.checks) {
		if (input.signal?.aborted || spawned.timedOut) break;
		const testCommand: PlaybookCommand = {
			id: `changed tests (${test.check.id})`,
			argv: test.argv,
			cwd: test.check.cwd,
			timeoutMs: Math.max(
				1,
				Math.min(command.timeoutMs - Number((process.hrtime.bigint() - clock) / 1_000_000n), test.check.timeoutMs),
			),
			env: command.env,
			description: test.check.description,
		};
		const testCwd = resolveCwd(testCommand, input.workspaceRoot);
		const testClock = process.hrtime.bigint();
		const result = await spawnCommand({ ...input, command: testCommand }, testCwd, test.argv);
		const testDurationMs = Number((process.hrtime.bigint() - testClock) / 1_000_000n);
		checks.push({
			name: testCommand.id,
			passed: result.exitCode === 0,
			evidence: `\`${test.argv.join(" ")}\` exit ${result.exitCode} in ${testDurationMs}ms${test.detail === undefined ? "" : `; ${test.detail}`}`,
		});
		commandRuns.push({ argv: [...test.argv], cwd: testCwd, exitCode: result.exitCode, durationMs: testDurationMs });
		const captured = Buffer.concat([
			spawned.captured,
			Buffer.from(
				`\n$ ${test.argv.join(" ")}\ncwd: ${testCwd}\nexit: ${result.exitCode}\n${test.detail === undefined ? "" : `note: ${test.detail}\n`}`,
			),
			result.captured,
			Buffer.from(result.spawnError === null ? "" : `\n${result.spawnError}\n`),
		]);
		spawned = {
			...spawned,
			exitCode: spawned.exitCode === 0 ? result.exitCode : spawned.exitCode,
			signal: spawned.signal ?? result.signal,
			timedOut: spawned.timedOut || result.timedOut,
			captured: captured.subarray(-Math.min(captured.length, input.maxOutputBytes ?? CODE_STEP_CAPTURE_MAX_BYTES)),
			outputBytes: spawned.outputBytes + result.outputBytes,
		};
	}
	const durationMs = Number((process.hrtime.bigint() - clock) / 1_000_000n);
	const endedAt = new Date(startedAtMs + durationMs).toISOString();
	const capturedText =
		spawned.captured.toString("utf8") +
		(spawned.spawnError === null ? "" : `\n${spawned.spawnError}\n`) +
		(testFiles.notes.length + testFiles.refusals.length === 0
			? ""
			: `\n${[...testFiles.refusals, ...testFiles.notes].join("\n")}\n`);
	const printed = Buffer.from(capturedText, "utf8");
	const excerpt = tailUtf8(printed, CODE_STEP_EXCERPT_MAX_BYTES, CODE_STEP_TRUNCATION_MARKER);
	const rendered = argv.join(" ");
	const passed = spawned.exitCode === 0;

	const artifactPaths: string[] = [];
	if (input.artifactDir !== undefined) {
		const artifactPath = join(input.artifactDir, `${input.stepId}.log`);
		mkdirSync(input.artifactDir, { recursive: true });
		writeFileSync(
			artifactPath,
			[
				`$ ${rendered}`,
				`cwd: ${cwd}`,
				`exit: ${spawned.exitCode}`,
				`duration_ms: ${durationMs}`,
				`timed_out: ${spawned.timedOut}`,
				...(input.notes ?? []).map((note) => `note: ${note}`),
				"",
				capturedText,
			].join("\n"),
			"utf8",
		);
		artifactPaths.push(artifactPath);
	}

	const report: CodeReportResult = {
		passed,
		exitCode: spawned.exitCode,
		checks,
		artifactPaths,
		outputExcerpt: excerpt.text,
	};
	const record: CodeStepRecord = {
		version: 1,
		runId,
		stepId: input.stepId,
		commandId: command.id,
		argv: [...argv],
		...(commandRuns.length > 1 ? { commandRuns } : {}),
		cwd,
		envNames: [...PLAYBOOK_COMMAND_BASE_ENV, ...command.env],
		timeoutMs: command.timeoutMs,
		startedAt,
		endedAt,
		durationMs,
		exitCode: spawned.exitCode,
		signal: spawned.signal,
		timedOut: spawned.timedOut,
		outputBytes: spawned.outputBytes,
		outputTruncated: spawned.outputBytes > spawned.captured.length || excerpt.truncated,
		outputDigest: sha256(capturedText),
		artifactPaths,
		reportDigest: codeReportDigest(report),
	};
	return { report, record, stdout: spawned.stdout.toString("utf8"), output: canonicalCodeReport(report), launched };
}
