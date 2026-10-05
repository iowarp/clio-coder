import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import type { JobRunner } from "../core/job-types.js";
import { runCommandVector } from "../core/safe-exec.js";
import { shellQuote } from "../core/shell-quote.js";
import { ToolNames } from "../core/tool-names.js";
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

export function attestJobCommand(runner: Extract<JobRunner, { kind: "command" }>): void {
	const file = runner.argv[0];
	if (
		!file ||
		!isAbsolute(file) ||
		realpathSync(file) !== file ||
		!runner.executableSha256 ||
		executableHash(file) !== runner.executableSha256
	)
		throw new Error(
			"Job executable identity changed or is unavailable; create a newly admitted job for the current executable.",
		);
}

/** Shell-shaped policy text only. Execution always uses the exact argv vector. */
export function jobCommandEffect(runner: JobRunner, cwd: string): readonly HostEffectCall[] {
	if (runner.kind !== "command") return [];
	return [
		{
			label: "scheduled command",
			call: { tool: ToolNames.Bash, args: { command: runner.argv.map(shellQuote).join(" "), cwd } },
		},
	];
}

export async function executeJobCommand(context: JobExecutionContext): Promise<JobRunResult> {
	const runner = context.job.spec.runner;
	if (runner.kind !== "command") throw new Error("Command job runner received a main occurrence.");
	attestJobCommand(runner);
	if (!context.start()) return { outcome: "deferred", summary: "Job execution is no longer admitted." };
	const result = await runCommandVector(runner.argv[0] as string, runner.argv.slice(1), {
		cwd: context.job.owner.cwd,
		workspaceRoot: context.job.owner.cwd,
		timeoutMs: context.job.spec.timeoutMs,
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
	return {
		outcome: failed ? "failed" : "succeeded",
		summary: JSON.stringify({
			argv: [result.file, ...result.args],
			cwd: result.cwd,
			exitCode: result.exitCode,
			aborted: result.aborted,
			timedOut: result.timedOut,
			truncated: result.outputCapped,
			cleanupIncomplete: result.cleanupIncomplete ?? false,
			pipeDrainIncomplete: result.pipeDrainIncomplete ?? false,
			stdout: result.stdout,
			stderr: result.stderr,
		}),
		json,
		jsonComplete,
		cleanupUnresolved: result.cleanupIncomplete === true || result.pipeDrainIncomplete === true,
		evidenceRefs: [],
		costUsd: 0,
		...(failed ? { errorClass: "execution" as const } : {}),
	};
}
