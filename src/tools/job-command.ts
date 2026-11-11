import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import { scrubbedCommandEnv } from "../core/bash-exec.js";
import type { JobCondition, JobPredicate, JobRunner } from "../core/job-types.js";
import { runCommandVector } from "../core/safe-exec.js";
import type { SandboxEnvPolicy } from "../core/sandbox/types.js";
import { shellQuote } from "../core/shell-quote.js";
import { ToolNames } from "../core/tool-names.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import { JOB_CONDITION_LIMIT, type JobConditionEvidence, projectJobPredicate } from "../domains/scheduling/index.js";
import type { JobExecutionContext, JobRunResult } from "../domains/scheduling/job-types.js";
import type { HostEffectCall } from "./registry.js";

const EXECUTABLE_HASH_LIMIT = 128 * 1024 * 1024;
export const JOB_COMMAND_CAPTURE_BYTES = 16 * 1024;

export function canonicalJobCwd(cwd: string, requested?: string): string {
	const root = realpathSync(resolve(cwd));
	const candidate = realpathSync(resolve(root, requested ?? "."));
	if (candidate !== root)
		throw new Error(
			"Stage 1 jobs run only in their creator's canonical workspace; a different cwd needs a separately admitted host.",
		);
	return root;
}

function executableHash(file: string): string {
	const stat = statSync(file);
	if (!stat.isFile() || stat.size > EXECUTABLE_HASH_LIMIT)
		throw new Error("Job executable must be a regular file at most 128 MiB so its identity can be pinned.");
	accessSync(file, constants.X_OK);
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Resolve once for admission; the immutable spec records the executable that runs (#411). */
export function prepareJobCommand(argv: unknown, cwd: string): Extract<JobRunner, { kind: "command" }> {
	if (
		!Array.isArray(argv) ||
		argv.length === 0 ||
		argv.length > 128 ||
		argv.some((word) => typeof word !== "string" || word.includes("\0") || word.length > 16_384)
	)
		throw new Error("job: command argv must contain 1–128 literal strings without NUL bytes.");
	const words = argv as string[];
	const name = words[0] ?? "";
	if (!name || name.includes("="))
		throw new Error(
			"job: argv[0] must name one executable; environment assignments and shell command strings are unsupported.",
		);
	const candidates =
		isAbsolute(name) || name.includes("/") || name.includes("\\")
			? [resolve(cwd, name)]
			: (process.env.PATH ?? "")
					.split(delimiter)
					.filter(Boolean)
					.map((directory) => resolve(cwd, directory, name));
	let file: string | null = null;
	for (const candidate of candidates) {
		try {
			accessSync(candidate, constants.X_OK);
			if (statSync(candidate).isFile()) {
				file = realpathSync(candidate);
				break;
			}
		} catch {
			/* A missing PATH candidate is not an executable (#411). */
		}
	}
	if (file === null)
		throw new Error(`job: executable '${name}' is unavailable; install or select it explicitly before creating a job.`);
	// A relative executable must stay in the creator's workspace after symlinks resolve.
	if (!isAbsolute(name) && (name.includes("/") || name.includes("\\"))) {
		const rel = relative(cwd, file);
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
			throw new Error("job: the relative executable resolves outside the creator workspace.");
	}
	return Object.freeze({
		kind: "command",
		argv: Object.freeze([file, ...words.slice(1)]),
		executableSha256: executableHash(file),
	});
}

/** Pin every further condition's executable the same way the job's own command is pinned. */
export function prepareJobConditions(also: unknown, cwd: string): JobCondition[] {
	if (!Array.isArray(also) || also.length === 0 || also.length > JOB_CONDITION_LIMIT)
		throw new Error(`job: also takes 1..${JOB_CONDITION_LIMIT} further conditions, each {argv, until}.`);
	return also.map((entry: unknown) => {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry))
			throw new Error("job: each also condition is {argv, until}.");
		const { argv, until, ...rest } = entry as Record<string, unknown>;
		if (Object.keys(rest).length > 0 || until === undefined)
			throw new Error("job: each also condition is {argv, until}.");
		const pinned = prepareJobCommand(argv, cwd);
		return {
			argv: pinned.argv,
			...(pinned.executableSha256 === undefined ? {} : { executableSha256: pinned.executableSha256 }),
			until: structuredClone(until) as JobPredicate,
		};
	});
}

function jobCommands(runner: Extract<JobRunner, { kind: "command" }>): ReadonlyArray<{
	readonly argv: readonly string[];
	readonly executableSha256?: string;
}> {
	return [runner, ...(runner.also ?? [])];
}

export function attestJobCommand(runner: Extract<JobRunner, { kind: "command" }>): void {
	for (const command of jobCommands(runner)) {
		const file = command.argv[0];
		if (
			!file ||
			!isAbsolute(file) ||
			realpathSync(file) !== file ||
			!command.executableSha256 ||
			executableHash(file) !== command.executableSha256
		)
			throw new Error(
				"Job executable identity changed or is unavailable; create a newly admitted job for the current executable.",
			);
	}
}

/**
 * Shell-shaped policy text only. Execution always uses the exact argv vector,
 * outside any sandbox, so the projection says `unsandboxed` and a
 * `safety.sandbox: required` yolo session refuses it (R1-safety-secrets-10).
 */
export function jobCommandEffect(runner: JobRunner, cwd: string): readonly HostEffectCall[] {
	if (runner.kind !== "command") return [];
	return jobCommands(runner).map((command, index) => ({
		label: index === 0 ? "scheduled command" : `scheduled condition ${index + 1} command`,
		call: {
			tool: ToolNames.Bash,
			args: { command: command.argv.map(shellQuote).join(" "), cwd, unsandboxed: true },
		},
	}));
}

/** At yolo nobody is there to log a CLI in, so the code host tokens pass despite the credential scrub (#445). */
function jobCommandEnv(autonomy: AutonomyLevel | undefined): Record<string, string> {
	const env: Record<string, string> = {};
	if (autonomy !== "yolo") return env;
	for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	return env;
}

/** The first non-empty stderr line, so a poll that cannot start says why at once. */
function firstStderrLine(stderr: string): string | undefined {
	const line = stderr
		.split(/\r?\n/u)
		.map((text) => text.trim())
		.find((text) => text.length > 0);
	return line === undefined ? undefined : line.slice(0, 200);
}

interface CommandPoll {
	failed: boolean;
	json: unknown;
	jsonComplete: boolean;
	cleanupUnresolved: boolean;
	report: Record<string, unknown>;
}

async function pollCommand(
	argv: readonly string[],
	context: JobExecutionContext,
	autonomy: AutonomyLevel | undefined,
	envPolicy: SandboxEnvPolicy,
): Promise<CommandPoll> {
	const result = await runCommandVector(argv[0] as string, argv.slice(1), {
		cwd: context.job.owner.cwd,
		workspaceRoot: context.job.owner.cwd,
		timeoutMs: context.job.spec.timeoutMs,
		baseEnv: scrubbedCommandEnv(envPolicy),
		env: jobCommandEnv(autonomy),
		maxOutputBytes: JOB_COMMAND_CAPTURE_BYTES,
		signal: context.signal,
	});
	let json: unknown = null;
	let jsonComplete = false;
	if (!result.outputCapped && result.stdoutRetained !== false) {
		try {
			json = JSON.parse(result.stdout);
			jsonComplete = true;
		} catch {
			/* Plain command output has no typed JSON predicate value. */
		}
	}
	const failed =
		result.aborted ||
		result.timedOut ||
		result.outputCapped ||
		result.cleanupIncomplete ||
		result.pipeDrainIncomplete ||
		result.exitCode !== 0;
	const stderrHead = failed ? firstStderrLine(result.stderr) : undefined;
	return {
		failed,
		json,
		jsonComplete,
		cleanupUnresolved: result.cleanupIncomplete === true || result.pipeDrainIncomplete === true,
		report: {
			argv: [result.file, ...result.args],
			cwd: result.cwd,
			exitCode: result.exitCode,
			aborted: result.aborted,
			timedOut: result.timedOut,
			truncated: result.outputCapped,
			cleanupIncomplete: result.cleanupIncomplete ?? false,
			pipeDrainIncomplete: result.pipeDrainIncomplete ?? false,
			...(stderrHead === undefined ? {} : { stderrHead }),
			stdout: result.stdout,
			stderr: result.stderr,
		},
	};
}

/**
 * The command gets the environment bash gets, credentials scrubbed, so cluster tools it calls work. A job with
 * further conditions polls every one of their commands too and records what each predicate reads, so the controller
 * decides the match from what the host saw rather than from one command's word for the others.
 */
export async function executeJobCommand(
	context: JobExecutionContext,
	autonomy?: AutonomyLevel,
	envPolicy: SandboxEnvPolicy = { passEnv: [], secretNames: [] },
): Promise<JobRunResult> {
	const runner = context.job.spec.runner;
	if (runner.kind !== "command") throw new Error("Command job runner received a main occurrence.");
	attestJobCommand(runner);
	if (!context.start()) return { outcome: "deferred", summary: "Job execution is no longer admitted." };
	const also = runner.also;
	if (also === undefined) {
		const poll = await pollCommand(runner.argv, context, autonomy, envPolicy);
		return {
			outcome: poll.failed ? "failed" : "succeeded",
			summary: JSON.stringify(poll.report),
			json: poll.json,
			jsonComplete: poll.jsonComplete,
			cleanupUnresolved: poll.cleanupUnresolved,
			evidenceRefs: [],
			costUsd: 0,
			...(poll.failed ? { errorClass: "execution" as const } : {}),
		};
	}
	const until = context.job.spec.until;
	if (until === null) throw new Error("Command job conditions require the job's own until.");
	const conditions = [{ argv: runner.argv, until }, ...also];
	const polls: Array<{ condition: number; poll: CommandPoll }> = [];
	for (const [index, condition] of conditions.entries()) {
		if (context.signal.aborted) break;
		polls.push({ condition: index + 1, poll: await pollCommand(condition.argv, context, autonomy, envPolicy) });
		if (polls.at(-1)?.poll.cleanupUnresolved === true) break;
	}
	const failed = polls.length < conditions.length || polls.some(({ poll }) => poll.failed);
	const conditionEvidence: JobConditionEvidence[] = conditions.map((condition, index) => {
		const poll = polls[index]?.poll;
		return poll === undefined || poll.failed || !poll.jsonComplete
			? { complete: false }
			: { complete: true, json: projectJobPredicate(condition.until, poll.json) };
	});
	// A failing condition leads, so the first exit code and stderr line a person reads are the ones that matter.
	const reports = [...polls]
		.sort((left, right) => Number(right.poll.failed) - Number(left.poll.failed))
		.map(({ condition, poll }) => ({ condition, ...poll.report, stdout: String(poll.report.stdout).slice(0, 400) }));
	return {
		outcome: failed ? "failed" : "succeeded",
		summary: JSON.stringify(reports),
		json: conditionEvidence,
		jsonComplete: true,
		cleanupUnresolved: polls.some(({ poll }) => poll.cleanupUnresolved),
		evidenceRefs: [],
		costUsd: 0,
		...(failed ? { errorClass: "execution" as const } : {}),
	};
}
