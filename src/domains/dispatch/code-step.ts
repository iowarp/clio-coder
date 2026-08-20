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
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { AI_AGENT_NAME } from "../../core/agent-environment.js";
import type { CommitAttributionEvidence } from "../../core/commit-attribution.js";
import {
	gitCommitAttributionEnabled,
	reportCommitAttributionDiagnostic,
	withManagedGitCommitAttributionEnvironment,
} from "../../core/git-commit-attribution.js";
import { FLEET_COMMAND_BASE_ENV, type FleetCommand } from "../agents/fleet-commands.js";
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

export const CODE_STEP_TRUNCATION_MARKER = "\n[... output truncated, see artifact ...]\n";

export interface CodeStepRunInput {
	stepId: string;
	command: FleetCommand;
	/** Absolute workspace root the command's relative cwd resolves against. */
	workspaceRoot: string;
	/** Absolute directory the command log is written to; omitted means no artifact. */
	artifactDir?: string;
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
	/** Trusted attribution facts for a commit command; omitted uses Clio-authored child-process defaults. */
	commitAttribution?: {
		enabled: boolean;
		evidence: Readonly<CommitAttributionEvidence>;
	};
	signal?: AbortSignal;
}

/**
 * Receipt-equivalent provenance for one deterministic run. It records exactly
 * what ran, where, for how long, and what came back, without inventing any of
 * the model-run facts (tokens, cost, route) a code step does not have.
 */
export interface CodeStepRecord {
	version: 1;
	runId: string;
	stepId: string;
	commandId: string;
	argv: ReadonlyArray<string>;
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
	/** Canonical JSON of the report; this is the text that crosses plan edges. */
	output: string;
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

function resolveCwd(command: FleetCommand, workspaceRoot: string): string {
	const root = resolve(workspaceRoot);
	if (command.cwd === "") return root;
	const target = resolve(root, command.cwd);
	if (!target.startsWith(root)) throw new Error(`code step: command '${command.id}' cwd escapes the workspace`);
	return target;
}

/** Closed environment: the base allowlist plus whatever this command declared. */
export function codeStepEnv(command: FleetCommand, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const names = [...FLEET_COMMAND_BASE_ENV, ...command.env];
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
	command: FleetCommand,
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
	const status = execFileSync("git", ["-C", root, "status", "--porcelain", "-uall"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30_000,
	});
	return status.trim().length > 0;
}

function newCodeRunId(): string {
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
	outputBytes: number;
	spawnError: string | null;
}

async function spawnCommand(input: CodeStepRunInput, cwd: string, argv: ReadonlyArray<string>): Promise<SpawnOutcome> {
	const command = input.command;
	const [executable, ...args] = argv;
	if (executable === undefined) throw new Error(`code step: command '${command.id}' has no executable`);
	return await new Promise<SpawnOutcome>((resolvePromise) => {
		const attribution = withManagedGitCommitAttributionEnvironment(codeStepEnv(command, input.env ?? process.env), {
			cwd,
			enabled: input.commitAttribution?.enabled ?? gitCommitAttributionEnabled(process.env),
			...(input.commitAttribution?.evidence === undefined ? {} : { evidence: input.commitAttribution.evidence }),
		});
		reportCommitAttributionDiagnostic(attribution.diagnostic);
		const chunks: Buffer[] = [];
		let outputBytes = 0;
		let captured = 0;
		let settled = false;
		let timedOut = false;
		let spawnError: string | null = null;
		const child = spawn(executable, args, {
			cwd,
			env: attribution.env,
			stdio: ["ignore", "pipe", "pipe"],
			// The command leads its own process group, so a timeout kills the
			// whole tree rather than orphaning a test runner's children.
			detached: process.platform !== "win32",
		});
		const collect = (chunk: Buffer): void => {
			outputBytes += chunk.length;
			if (captured >= CODE_STEP_CAPTURE_MAX_BYTES) return;
			const room = CODE_STEP_CAPTURE_MAX_BYTES - captured;
			const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
			chunks.push(slice);
			captured += slice.length;
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		const kill = (): void => {
			if (child.pid === undefined) return;
			try {
				if (process.platform === "win32") child.kill("SIGKILL");
				else process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, command.timeoutMs);
		const onAbort = (): void => {
			kill();
		};
		input.signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (exitCode: number, signal: string | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			input.signal?.removeEventListener("abort", onAbort);
			resolvePromise({
				exitCode,
				signal,
				timedOut,
				captured: Buffer.concat(chunks),
				outputBytes,
				spawnError,
			});
		};
		child.on("error", (error) => {
			// A missing binary lands here. Exit 127 with the real message beats a
			// preflight probe that guesses.
			spawnError = error instanceof Error ? error.message : String(error);
			finish(CODE_STEP_SPAWN_FAILURE_EXIT_CODE, null);
		});
		child.on("close", (code, signal) => {
			if (timedOut) return finish(CODE_STEP_TIMEOUT_EXIT_CODE, signal);
			if (code !== null) return finish(code, signal);
			finish(signal === null ? 1 : 128, signal);
		});
	});
}

/**
 * Run one registered command and return its typed report plus the provenance
 * record. Never throws for a failing command: a red suite is a successful run
 * of the runner and a conformant report, and the plan decides what that means.
 */
export async function runCodeStep(input: CodeStepRunInput): Promise<CodeStepOutcome> {
	const command = input.command;
	if (input.artifactDir !== undefined && !isAbsolute(input.artifactDir)) {
		throw new Error("code step: artifactDir must be absolute");
	}
	const cwd = resolveCwd(command, input.workspaceRoot);
	const runId = newCodeRunId();
	const argv = resolveCommandArgv(command, input.substitutions);
	const startedAtMs = Date.now();
	const clock = process.hrtime.bigint();
	const startedAt = new Date(startedAtMs).toISOString();
	const emptyWorkspace = input.requireWorkspaceChanges === true && !workspaceHasChanges(cwd);
	const spawned = emptyWorkspace
		? {
				exitCode: CODE_STEP_EMPTY_DIFF_EXIT_CODE,
				signal: null,
				timedOut: false,
				captured: Buffer.from(`${CODE_STEP_EMPTY_DIFF_MESSAGE}\n`, "utf8"),
				outputBytes: 0,
				spawnError: null,
			}
		: await spawnCommand(input, cwd, argv);
	const durationMs = Number((process.hrtime.bigint() - clock) / 1_000_000n);
	const endedAt = new Date(startedAtMs + durationMs).toISOString();
	const capturedText =
		spawned.captured.toString("utf8") + (spawned.spawnError === null ? "" : `\n${spawned.spawnError}\n`);
	const printed = Buffer.from(capturedText, "utf8");
	const excerpt = tailUtf8(printed, CODE_STEP_EXCERPT_MAX_BYTES, CODE_STEP_TRUNCATION_MARKER);
	const rendered = argv.join(" ");
	const passed = spawned.exitCode === 0;
	const evidence = emptyWorkspace
		? CODE_STEP_EMPTY_DIFF_MESSAGE
		: spawned.timedOut
			? `timed out after ${command.timeoutMs}ms (exit ${spawned.exitCode})`
			: `exit ${spawned.exitCode} in ${durationMs}ms`;

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
		checks: [{ name: command.id, passed, evidence: `\`${rendered}\` ${evidence}` }],
		artifactPaths,
		outputExcerpt: excerpt.text,
	};
	const record: CodeStepRecord = {
		version: 1,
		runId,
		stepId: input.stepId,
		commandId: command.id,
		argv: [...argv],
		cwd,
		envNames: [...FLEET_COMMAND_BASE_ENV, ...command.env],
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
	return { report, record, output: canonicalCodeReport(report) };
}
