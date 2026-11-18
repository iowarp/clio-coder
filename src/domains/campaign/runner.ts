import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, writeSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { runCommandVector, type SafeCommandResult } from "../../core/safe-exec.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { type ArenaEnvPolicy, arenaContenderEnv } from "../arena/index.js";
import { withContainedYoloPin } from "../safety/autonomy.js";
import { type CampaignMetrics, entryRootEnv, entryRoots, foldCampaignMetrics, loadCampaignMetrics } from "./fold.js";
import type { RosterEntry } from "./roster.js";

export const CAMPAIGN_SCHEMA_VERSION = 1;

/** `run --timeout` expiry and an unscripted question (src/cli/run-answers.ts UNSCRIPTED_EXIT_CODE). */
const RUN_TIMEOUT_EXIT = 124;
const RUN_UNSCRIPTED_EXIT = 5;
/** Seconds an entry gets beyond its own `--timeout` to write its records before the campaign stops it. */
const TIMEOUT_GRACE_SECONDS = 30;
const PROBE_TIMEOUT_MS = 120_000;
const PROBE_TEXT_MAX = 4000;
const ERROR_TAIL_LINES = 3;

export interface CampaignProbe {
	extension: string;
	command: string;
}

export interface CampaignInput {
	/** The seeded project every entry starts from; it is copied, never written. */
	fixture: string;
	roster: ReadonlyArray<RosterEntry>;
	/** A `run --answers` file, already validated by the caller. */
	answers: string;
	prompt: string;
	/** Absent or empty; every entry's project copy, home, logs and entry.json land under it. */
	out: string;
	/** Each entry's `run --timeout`; null runs without one. */
	timeoutSeconds: number | null;
	autonomy: "default" | "yolo";
	/** An extension command whose `--json` result is recorded as the desk's final status after each run. */
	probe: CampaignProbe | null;
	/**
	 * The operator's Clio config root. Every entry runs against it directly, as an arena contender does, so its
	 * targets, installed extensions and credential store are the operator's own: no secret is copied under `out`,
	 * and an OAuth refresh an entry makes lands in the operator's store under its lock instead of in a copy that
	 * is thrown away, which would strand a rotated refresh token.
	 */
	operatorConfig: string;
	/**
	 * The operator's installed components directory (`<data>/components`). Entries resolve runtime SDKs such as
	 * copilot-sdk and claude-sdk from it, read-only, since their own data roots start empty.
	 */
	operatorComponents: string;
	/** How to start this same Clio Coder: the executable and the arguments before the subcommand. */
	clio: { file: string; args: ReadonlyArray<string> };
	env: Record<string, string>;
	envPolicy: ArenaEnvPolicy;
	signal?: AbortSignal;
	onProgress?: (line: string) => void;
}

/**
 * How an entry's run ended: `completed` exited 0, `unscripted` stopped on a question the answers file did not
 * script, `timed-out` hit `--timeout`, `failed` exited otherwise, `canceled` was stopped by the operator or never
 * started, and `error` could not be set up or launched.
 */
export type CampaignEntryStatus = "completed" | "unscripted" | "timed-out" | "failed" | "canceled" | "error";

export interface CampaignProbeResult {
	extension: string;
	command: string;
	exitCode: number | null;
	/** The command's text result, clipped. */
	text: string | null;
	data: unknown;
	error: string | null;
}

export interface CampaignEntryResult {
	schemaVersion: number;
	index: number;
	label: string;
	target: string;
	model: string;
	thinking: string | null;
	status: CampaignEntryStatus;
	exitCode: number | null;
	startedAt: string | null;
	/** Wall time of the run process; reported, never a pass criterion. */
	wallMs: number | null;
	dir: string;
	metrics: CampaignMetrics;
	desk: CampaignProbeResult | null;
	error: string | null;
}

export interface CampaignResult {
	schemaVersion: number;
	fixture: string;
	answers: string;
	prompt: string;
	out: string;
	timeoutSeconds: number | null;
	autonomy: "default" | "yolo";
	startedAt: string;
	completedAt: string;
	canceled: boolean;
	entries: CampaignEntryResult[];
}

/** An input the campaign refuses before any entry starts. */
export class CampaignInputError extends Error {}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function isWithin(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

export function validateCampaignInput(input: Pick<CampaignInput, "fixture" | "out" | "prompt">): void {
	if (input.prompt.trim().length === 0) throw new CampaignInputError("campaign run needs a non-empty --prompt");
	const fixture = resolve(input.fixture);
	const out = resolve(input.out);
	if (!existsSync(fixture)) throw new CampaignInputError(`--fixture ${fixture} does not exist`);
	if (isWithin(out, fixture))
		throw new CampaignInputError(`--out ${out} is inside the fixture; the fixture is copied whole`);
	if (existsSync(out) && readdirSync(out).length > 0)
		throw new CampaignInputError(`--out ${out} already holds files; name an absent or empty directory`);
}

function entryDirName(index: number, label: string): string {
	return `${String(index + 1).padStart(2, "0")}-${label.replace(/[^A-Za-z0-9._-]+/gu, "-")}`;
}

function runArgs(input: CampaignInput, entry: RosterEntry, project: string): string[] {
	return [
		...input.clio.args,
		"run",
		"--cwd",
		project,
		"--target",
		entry.target,
		"--model",
		entry.model,
		...(entry.thinking !== null ? ["--thinking", entry.thinking] : []),
		"--answers",
		input.answers,
		...(input.timeoutSeconds !== null ? ["--timeout", String(input.timeoutSeconds)] : []),
		...(input.autonomy === "yolo" ? ["--autonomy", "yolo"] : []),
		"--",
		input.prompt,
	];
}

function statusOf(result: SafeCommandResult): CampaignEntryStatus {
	if (result.aborted) return "canceled";
	if (result.timedOut || result.exitCode === RUN_TIMEOUT_EXIT) return "timed-out";
	if (result.launched === false) return "error";
	if (result.exitCode === 0) return "completed";
	if (result.exitCode === RUN_UNSCRIPTED_EXIT) return "unscripted";
	return "failed";
}

/** The last lines a child wrote to stderr, without the `error:` lead printError puts on each. */
function tail(text: string): string | null {
	const lines = text
		.trim()
		.split("\n")
		.slice(-ERROR_TAIL_LINES)
		.map((line) => line.replace(/^error: /u, ""))
		.join("\n");
	return lines.length > 0 ? lines : null;
}

/** Run the extension command the operator named and keep its structured result as the desk's final status. */
async function probeDesk(
	input: CampaignInput,
	probe: CampaignProbe,
	project: string,
	env: Record<string, string>,
): Promise<CampaignProbeResult> {
	const base = { extension: probe.extension, command: probe.command };
	let result: SafeCommandResult;
	try {
		result = await runCommandVector(
			input.clio.file,
			[...input.clio.args, "extensions", "run", probe.extension, probe.command, "--json"],
			{
				cwd: project,
				workspaceRoot: project,
				env,
				timeoutMs: PROBE_TIMEOUT_MS,
				...(input.signal ? { signal: input.signal } : {}),
			},
		);
	} catch (error) {
		return { ...base, exitCode: null, text: null, data: null, error: errorText(error) };
	}
	if (result.exitCode !== 0)
		return { ...base, exitCode: result.exitCode, text: null, data: null, error: tail(result.stderr) ?? "probe failed" };
	try {
		const parsed = JSON.parse(result.stdout.trim()) as { output?: { text?: unknown; data?: unknown } };
		const text = typeof parsed.output?.text === "string" ? parsed.output.text.trim().slice(0, PROBE_TEXT_MAX) : null;
		return { ...base, exitCode: 0, text, data: parsed.output?.data ?? null, error: null };
	} catch (error) {
		return { ...base, exitCode: 0, text: null, data: null, error: `unreadable --json result: ${errorText(error)}` };
	}
}

async function runEntry(input: CampaignInput, entry: RosterEntry, index: number): Promise<CampaignEntryResult> {
	const dir = join(input.out, entryDirName(index, entry.label));
	const project = join(dir, "project");
	const roots = entryRoots(join(dir, "home"), input.operatorConfig, input.operatorComponents);
	const result: CampaignEntryResult = {
		schemaVersion: CAMPAIGN_SCHEMA_VERSION,
		index,
		label: entry.label,
		target: entry.target,
		model: entry.model,
		thinking: entry.thinking,
		status: "canceled",
		exitCode: null,
		startedAt: null,
		wallMs: null,
		dir,
		metrics: foldCampaignMetrics(null, [], [], null),
		desk: null,
		error: null,
	};
	const save = (): void => {
		safeResourceWrite(join(dir, "entry.json"), `${JSON.stringify(result, null, 2)}\n`);
	};
	mkdirSync(dir, { recursive: true });
	if (input.signal?.aborted) {
		result.error = "canceled before it started";
		save();
		return result;
	}
	try {
		cpSync(input.fixture, project, { recursive: true });
		for (const root of [roots.data, roots.state, roots.cache]) mkdirSync(root, { recursive: true, mode: 0o700 });
		const scoped = { ...arenaContenderEnv(input.env, input.envPolicy, entry.target), ...entryRootEnv(roots) };
		const env = input.autonomy === "yolo" ? withContainedYoloPin(scoped) : scoped;
		const stdout = openSync(join(dir, "run.stdout.log"), "w");
		const stderr = openSync(join(dir, "run.stderr.log"), "w");
		let run: SafeCommandResult;
		result.startedAt = new Date().toISOString();
		try {
			run = await runCommandVector(input.clio.file, runArgs(input, entry, project), {
				cwd: project,
				workspaceRoot: project,
				env,
				timeoutMs: input.timeoutSeconds === null ? 0 : (input.timeoutSeconds + TIMEOUT_GRACE_SECONDS) * 1000,
				output: {
					onStdout: (chunk) => void writeSync(stdout, chunk),
					onStderr: (chunk) => void writeSync(stderr, chunk),
					retainTailBytes: 4096,
				},
				...(input.signal ? { signal: input.signal } : {}),
			});
		} finally {
			closeSync(stdout);
			closeSync(stderr);
		}
		result.exitCode = run.exitCode;
		result.wallMs = run.durationMs;
		result.status = statusOf(run);
		if (result.status !== "completed") result.error = run.failure ?? tail(run.stderr);
		try {
			result.metrics = loadCampaignMetrics(roots, project);
		} catch (error) {
			result.error = result.error ?? `metrics: ${errorText(error)}`;
		}
		if (input.probe !== null && result.status !== "canceled")
			result.desk = await probeDesk(input, input.probe, project, env);
	} catch (error) {
		result.status = "error";
		result.error = errorText(error);
	}
	save();
	return result;
}

/**
 * Run one fixture across a roster, one entry at a time so wall times do not contend. Each entry gets a fresh copy
 * of the fixture and its own empty Clio data, state and cache roots beside the operator's config and installed
 * components, runs headless `clio-coder run --answers`, and is folded from what that run persisted. An entry that
 * fails, times out or cannot start is recorded and the campaign moves on; a stop signal cancels the running entry
 * and the rest.
 */
export async function runCampaign(input: CampaignInput): Promise<CampaignResult> {
	validateCampaignInput(input);
	const fixture = resolve(input.fixture);
	const out = resolve(input.out);
	mkdirSync(out, { recursive: true });
	const normalized: CampaignInput = { ...input, fixture, out, answers: resolve(input.answers) };
	const startedAt = new Date().toISOString();
	const entries: CampaignEntryResult[] = [];
	for (const [index, entry] of input.roster.entries()) {
		input.onProgress?.(`entry ${index + 1}/${input.roster.length} ${entry.label}: running`);
		const result = await runEntry(normalized, entry, index);
		const seconds = result.wallMs === null ? "" : ` in ${(result.wallMs / 1000).toFixed(1)}s`;
		input.onProgress?.(`entry ${index + 1}/${input.roster.length} ${entry.label}: ${result.status}${seconds}`);
		entries.push(result);
	}
	return {
		schemaVersion: CAMPAIGN_SCHEMA_VERSION,
		fixture,
		answers: normalized.answers,
		prompt: input.prompt,
		out,
		timeoutSeconds: input.timeoutSeconds,
		autonomy: input.autonomy,
		startedAt,
		completedAt: new Date().toISOString(),
		canceled: input.signal?.aborted === true,
		entries,
	};
}
