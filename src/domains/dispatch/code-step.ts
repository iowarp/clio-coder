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

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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
	return env;
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

async function spawnCommand(input: CodeStepRunInput, cwd: string): Promise<SpawnOutcome> {
	const command = input.command;
	const [executable, ...args] = command.argv;
	if (executable === undefined) throw new Error(`code step: command '${command.id}' has no executable`);
	return await new Promise<SpawnOutcome>((resolvePromise) => {
		const chunks: Buffer[] = [];
		let outputBytes = 0;
		let captured = 0;
		let settled = false;
		let timedOut = false;
		let spawnError: string | null = null;
		const child = spawn(executable, args, {
			cwd,
			env: codeStepEnv(command, input.env ?? process.env),
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
	const startedAtMs = Date.now();
	const clock = process.hrtime.bigint();
	const startedAt = new Date(startedAtMs).toISOString();
	const spawned = await spawnCommand(input, cwd);
	const durationMs = Number((process.hrtime.bigint() - clock) / 1_000_000n);
	const endedAt = new Date(startedAtMs + durationMs).toISOString();
	const capturedText =
		spawned.captured.toString("utf8") + (spawned.spawnError === null ? "" : `\n${spawned.spawnError}\n`);
	const printed = Buffer.from(capturedText, "utf8");
	const excerpt = tailUtf8(printed, CODE_STEP_EXCERPT_MAX_BYTES, CODE_STEP_TRUNCATION_MARKER);
	const rendered = command.argv.join(" ");
	const passed = spawned.exitCode === 0;
	const evidence = spawned.timedOut
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
		argv: [...command.argv],
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
