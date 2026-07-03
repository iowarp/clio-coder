import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { combineBashOutput, runBashCommand } from "../core/bash-exec.js";
import { clioDataDir, clioStateDir } from "../core/xdg.js";
import {
	type EvalHarnessMetrics,
	type EvalRunArtifact,
	type EvalRunRecord,
	evalClioProvenance,
	evalEnvironmentProvenance,
	summarizeEvalResults,
	writeEvalArtifact,
	ZERO_EVAL_HARNESS_METRICS,
} from "../domains/eval/index.js";
import { buildEvalEvidence } from "../domains/evidence/index.js";
import {
	discoverMarketplaceSkills,
	loadSkills,
	parseSkillEvals,
	type SkillEvalScenario,
} from "../domains/resources/index.js";
import { formatColumns, printError } from "./shared.js";

/**
 * Executable skill evals (experimental). Every catalog skill ships an
 * `evals.md` with RED-GREEN scenarios; this lane executes them instead of
 * trusting the prose: per scenario one baseline headless run (no skills), one
 * treatment run (the skill loaded via the explicit --skill path and invoked
 * with /skill:<name>), then one judge run that scores each Expected bullet
 * pass/fail from the two transcripts.
 *
 * Deltas from the task-file eval harness, recorded rather than papered over:
 * the evals domain verifies with setup/verifier commands and has no judge, so
 * bullet verdicts here come from a model run, not command exit codes. The
 * synthesized EvalRunArtifact carries scenario-level records with empty
 * command lists, receipt-backed token/cost totals when headless main-agent
 * receipts are present, and per-bullet detail in a `skill-eval.json` sidecar
 * registered in the bundle's `overview.json` files list.
 */

const DEFAULT_RUN_TIMEOUT_MS = 600_000;
const CHILD_OUTPUT_LIMIT = 4_000_000;
const PREVIEW_MAX_CHARS = 300;
const TRANSCRIPT_HEAD_CHARS = 9_000;
const TRANSCRIPT_TAIL_CHARS = 4_000;
/** Per-eval detail file written beside the standard bundle and registered in overview.files. */
const SKILL_EVAL_SIDECAR = "skill-eval.json";

export interface SkillsEvalOptions {
	json: boolean;
	/**
	 * Fixture commands in evals.md are shell authored by the skill, executed
	 * with the operator's environment. They run only on explicit opt-in;
	 * without it a fixture-bearing scenario reports an error instead of
	 * silently executing third-party shell.
	 */
	trustFixtures: boolean;
	scenario?: string;
	target?: string;
	timeoutSeconds?: number;
	workspace?: string;
}

type BulletVerdict = "pass" | "fail" | "error";

/** Exported for contracts tests. */
export interface ScoredBullet {
	index: number;
	text: string;
	verdict: BulletVerdict;
	reason: string;
}

/** Exported for contracts tests. */
export interface CapturedRun {
	sessionId: string | null;
	transcript: string;
	finalText: string;
	exitCode: number;
	timedOut: boolean;
	wallTimeMs: number;
	stderr: string;
}

interface ScenarioUsage {
	tokens: number;
	costUsd: number;
	harness: EvalHarnessMetrics;
}

interface ScenarioOutcome {
	scenario: SkillEvalScenario;
	bullets: ScoredBullet[];
	baseline: CapturedRun | null;
	treatment: CapturedRun | null;
	judge: CapturedRun | null;
	/** Temp workspace the runs executed in; removed after the run, kept as a record. */
	workspace: string;
	wallTimeMs: number;
	infraError: string | null;
	usage: ScenarioUsage;
}

export async function runSkillsEvalCommand(nameOrPath: string, options: SkillsEvalOptions): Promise<number> {
	const resolved = resolveSkillBaseDir(nameOrPath);
	if (resolved.baseDir === null) {
		printError(resolved.error ?? `unknown skill: ${nameOrPath}`);
		return 2;
	}
	const list = loadSkills({ disableDiscovery: true, explicitSkillPaths: [resolved.baseDir] });
	const skill = list.items[0];
	if (skill === undefined) {
		printError(`skill did not load from ${resolved.baseDir}: ${list.diagnostics.map((d) => d.message).join("; ")}`);
		return 2;
	}
	const evalsPath = join(resolved.baseDir, "evals.md");
	let evalsRaw: string;
	try {
		evalsRaw = await readFile(evalsPath, "utf8");
	} catch {
		printError(`skill ${skill.name} has no evals.md at ${evalsPath}`);
		return 2;
	}
	const parsed = parseSkillEvals(evalsRaw);
	for (const diagnostic of parsed.diagnostics) {
		process.stderr.write(`clio skills eval: ${diagnostic}\n`);
	}
	const matcher = options.scenario === undefined ? null : scenarioMatcher(options.scenario);
	if (options.scenario !== undefined && matcher === null) {
		printError(`invalid --scenario "${options.scenario}": use a scenario id like S1 or a bare number`);
		return 2;
	}
	const scenarios = matcher === null ? parsed.scenarios : parsed.scenarios.filter(matcher);
	if (scenarios.length === 0) {
		printError(
			matcher === null
				? `no parseable scenarios in ${evalsPath}`
				: `scenario ${options.scenario} not found in ${evalsPath} (have: ${parsed.scenarios.map((s) => s.id).join(", ") || "none"})`,
		);
		return 2;
	}

	const timeoutMs = options.timeoutSeconds !== undefined ? options.timeoutSeconds * 1000 : DEFAULT_RUN_TIMEOUT_MS;
	const workspaceOverride = await resolveWorkspaceOverride(options.workspace);
	if (typeof workspaceOverride !== "string" && workspaceOverride !== null) {
		printError(workspaceOverride.error);
		return 2;
	}
	const startedAt = new Date().toISOString();
	const outcomes: ScenarioOutcome[] = [];
	for (const scenario of scenarios) {
		process.stderr.write(`clio skills eval: ${skill.name} ${scenario.id} baseline/treatment/judge...\n`);
		outcomes.push(
			await runScenario(
				skill.name,
				resolved.baseDir,
				scenario,
				options.target,
				timeoutMs,
				workspaceOverride,
				options.trustFixtures,
			),
		);
	}
	const endedAt = new Date().toISOString();

	const artifact = synthesizeArtifact(skill.name, evalsPath, evalsRaw, startedAt, endedAt, outcomes, options.target);
	let evidenceId: string | null = null;
	let evidenceDirectory: string | null = null;
	const evidenceErrors: string[] = [];
	try {
		await writeEvalArtifact(clioDataDir(), artifact);
		const built = await buildEvalEvidence({
			dataDir: clioDataDir(),
			stateDir: clioStateDir(),
			artifact,
			sidecars: [SKILL_EVAL_SIDECAR],
		});
		evidenceId = built.evidenceId;
		evidenceDirectory = built.directory;
		await writeFile(
			join(built.directory, SKILL_EVAL_SIDECAR),
			`${JSON.stringify(sidecar(skill.name, artifact.evalId, outcomes), null, 2)}\n`,
			"utf8",
		);
	} catch (error) {
		evidenceErrors.push(error instanceof Error ? error.message : String(error));
	}
	for (const message of evidenceErrors) {
		process.stderr.write(`clio skills eval: evidence build failed: ${message}\n`);
	}

	if (options.json) {
		for (const outcome of outcomes) {
			for (const bullet of outcome.bullets) {
				process.stdout.write(
					`${JSON.stringify({
						schema: "experimental",
						kind: "skill-eval-bullet",
						skill: skill.name,
						scenario: outcome.scenario.id,
						title: outcome.scenario.title,
						bullet: bullet.index,
						expected: bullet.text,
						verdict: bullet.verdict,
						reason: bullet.reason,
						baselineSessionId: outcome.baseline?.sessionId ?? null,
						treatmentSessionId: outcome.treatment?.sessionId ?? null,
						judgeSessionId: outcome.judge?.sessionId ?? null,
						evalId: artifact.evalId,
						evidenceId,
					})}\n`,
				);
			}
		}
	} else {
		printHumanReport(skill.name, outcomes, artifact.evalId, evidenceId, evidenceDirectory);
	}
	const anyFailure = outcomes.some((outcome) => outcome.bullets.some((bullet) => bullet.verdict !== "pass"));
	// 1 means the skill failed its rubric; 3 means the verdicts stand but the
	// evidence archive write failed, so infra flakiness is not read as a
	// regression by callers branching on the code.
	if (anyFailure) return 1;
	return evidenceErrors.length > 0 ? 3 : 0;
}

function resolveSkillBaseDir(nameOrPath: string): { baseDir: string | null; error?: string } {
	const asPath = resolve(nameOrPath);
	if (existsSync(join(asPath, "SKILL.md"))) return { baseDir: asPath };
	const marketplace = discoverMarketplaceSkills({ cwd: process.cwd() });
	const entry = marketplace.skills.find((skill) => skill.name === nameOrPath && skill.origin === "catalog");
	if (entry !== undefined) return { baseDir: entry.sourceUrl };
	return {
		baseDir: null,
		error: `skill not found: ${nameOrPath} (expected a catalog skill name or a directory containing SKILL.md)`,
	};
}

/**
 * A full id like "D2" selects exactly that scenario; a bare number selects
 * every scenario with that number (evals.md files may mix letter prefixes).
 */
function scenarioMatcher(value: string): ((scenario: SkillEvalScenario) => boolean) | null {
	const trimmed = value.trim();
	const full = /^([A-Za-z])(\d+)$/.exec(trimmed);
	if (full !== null) {
		const id = `${(full[1] ?? "").toUpperCase()}${Number.parseInt(full[2] ?? "", 10)}`;
		return (scenario) => scenario.id === id;
	}
	const bare = /^(\d+)$/.exec(trimmed);
	if (bare !== null) {
		const wanted = Number.parseInt(bare[1] ?? "", 10);
		return (scenario) => scenario.number === wanted;
	}
	return null;
}

async function resolveWorkspaceOverride(workspace: string | undefined): Promise<string | null | { error: string }> {
	if (workspace === undefined) return null;
	const resolved = resolve(workspace);
	try {
		const info = await stat(resolved);
		if (!info.isDirectory()) return { error: `--workspace is not a directory: ${resolved}` };
		return resolved;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { error: `--workspace is not readable: ${resolved}: ${detail}` };
	}
}

async function runScenario(
	skillName: string,
	skillBaseDir: string,
	scenario: SkillEvalScenario,
	target: string | undefined,
	timeoutMs: number,
	workspaceOverride: string | null,
	trustFixtures: boolean,
): Promise<ScenarioOutcome> {
	const scenarioStart = Date.now();
	const workspace = workspaceOverride ?? (await mkdtemp(join(tmpdir(), "clio-skill-eval-")));
	const removeWorkspace = workspaceOverride === null;
	const targetArgs = target === undefined ? [] : ["--target", target];
	try {
		const fixtureError = await runFixtureCommands(scenario, workspace, timeoutMs, trustFixtures);
		if (fixtureError !== null) {
			return await completeScenarioOutcome({
				scenario,
				bullets: errorBullets(scenario, fixtureError),
				baseline: null,
				treatment: null,
				judge: null,
				workspace,
				wallTimeMs: Date.now() - scenarioStart,
				infraError: fixtureError,
			});
		}
		const baseline = await captureHeadlessRun(
			["run", "--json", "--json-events", "terminal", "--no-skills", ...targetArgs, scenario.setup],
			workspace,
			timeoutMs,
		);
		const treatment = await captureHeadlessRun(
			[
				"run",
				"--json",
				"--json-events",
				"terminal",
				"--no-skills",
				"--skill",
				skillBaseDir,
				...targetArgs,
				`/skill:${skillName} ${scenario.setup}`,
			],
			workspace,
			timeoutMs,
		);
		const infra = runInfraError("baseline", baseline) ?? runInfraError("treatment", treatment);
		if (infra !== null) {
			return await completeScenarioOutcome({
				scenario,
				bullets: errorBullets(scenario, infra),
				baseline,
				treatment,
				judge: null,
				workspace,
				wallTimeMs: Date.now() - scenarioStart,
				infraError: infra,
			});
		}
		// The judge also runs with --json: a model that ends the turn through a
		// terminating tool (artifact plan/review/report) prints nothing in text mode,
		// while the event stream still carries the verdict content.
		const judge = await captureHeadlessRun(
			[
				"run",
				"--json",
				"--json-events",
				"terminal",
				"--no-skills",
				...targetArgs,
				judgePrompt(scenario, baseline.transcript, treatment.transcript),
			],
			workspace,
			timeoutMs,
		);
		const judgeInfra = runInfraError("judge", judge);
		if (judgeInfra !== null) {
			return await completeScenarioOutcome({
				scenario,
				bullets: errorBullets(scenario, judgeInfra),
				baseline,
				treatment,
				judge,
				workspace,
				wallTimeMs: Date.now() - scenarioStart,
				infraError: judgeInfra,
			});
		}
		const bullets = parseJudgeVerdicts(scenario, judge);
		return await completeScenarioOutcome({
			scenario,
			bullets,
			baseline,
			treatment,
			judge,
			workspace,
			wallTimeMs: Date.now() - scenarioStart,
			infraError: null,
		});
	} finally {
		if (removeWorkspace) await rm(workspace, { recursive: true, force: true });
	}
}

async function completeScenarioOutcome(outcome: Omit<ScenarioOutcome, "usage">): Promise<ScenarioOutcome> {
	return {
		...outcome,
		usage: await usageForCapturedRuns([outcome.baseline, outcome.treatment, outcome.judge]),
	};
}

async function runFixtureCommands(
	scenario: SkillEvalScenario,
	workspace: string,
	timeoutMs: number,
	trustFixtures: boolean,
): Promise<string | null> {
	const commands = scenario.fixtureCommands?.trim();
	if (commands === undefined || commands.length === 0) return null;
	if (!trustFixtures) {
		return "scenario declares fixture commands, which are real shell from the skill's evals.md; review them and rerun with --trust-fixtures";
	}
	const validationError = validateFixtureCommands(commands);
	if (validationError !== null) return `fixture setup rejected: ${validationError}`;
	const result = await runBashCommand(commands, {
		cwd: workspace,
		timeoutMs: Math.min(timeoutMs, 120_000),
	});
	const output = combineBashOutput(result).trim();
	if (result.timedOut) return `fixture setup timed out${output.length > 0 ? `: ${truncate(output, 300)}` : ""}`;
	if (result.outputCapped) {
		return `fixture setup output exceeded limit${output.length > 0 ? `: ${truncate(output, 300)}` : ""}`;
	}
	if (result.error !== null) {
		return `fixture setup failed${output.length > 0 ? `: ${truncate(output, 300)}` : `: ${result.error.message}`}`;
	}
	return null;
}

/**
 * Best-effort lint over trusted fixture scripts, not a sandbox: fixtures only
 * run behind --trust-fixtures, and these checks exist to catch obvious
 * workspace escapes in otherwise-reviewed scripts (shell is not reliably
 * classifiable by regex).
 */
function validateFixtureCommands(commands: string): string | null {
	const checks: Array<{ pattern: RegExp; reason: string }> = [
		{
			pattern: /(^|[\s;&|(<>='"`])\/(?!dev\/null(?:\s|$))(?=\S)/,
			reason: "absolute paths are not allowed in fixture commands",
		},
		{
			pattern: /(^|[\s;&|()'"`/=])\.\.(?=$|[/\s;&|()'"`])/,
			reason: "parent-directory path segments are not allowed in fixture commands",
		},
		{
			pattern: /(^|[\s;&|()])~(?=$|[/\s;&|()])/,
			reason: "home-directory expansion is not allowed in fixture commands",
		},
		{
			pattern:
				/\$(?:\{(?:HOME|CLIO_HOME|CLIO_CONFIG_DIR|CLIO_DATA_DIR|CLIO_STATE_DIR|CLIO_CACHE_DIR)\}|(?:HOME|CLIO_HOME|CLIO_CONFIG_DIR|CLIO_DATA_DIR|CLIO_STATE_DIR|CLIO_CACHE_DIR)\b)/,
			reason: "home and Clio directory environment variables are not allowed in fixture commands",
		},
		{
			pattern: /(^|[\s;&|()])(?:cd|pushd|popd)\b/,
			reason: "directory-changing commands are not allowed in fixture commands",
		},
		{
			pattern: /(^|[\s;&|()])(?:sudo|su|ssh|scp|rsync)\b/,
			reason: "privilege-changing or remote commands are not allowed in fixture commands",
		},
	];
	for (const check of checks) {
		if (check.pattern.test(commands)) return check.reason;
	}
	return null;
}

async function usageForCapturedRuns(runs: ReadonlyArray<CapturedRun | null>): Promise<ScenarioUsage> {
	const sessionIds = new Set(
		runs.flatMap((run) => (run?.sessionId !== null && run?.sessionId !== undefined ? [run.sessionId] : [])),
	);
	const usage: ScenarioUsage = {
		tokens: 0,
		costUsd: 0,
		harness: { ...ZERO_EVAL_HARNESS_METRICS },
	};
	if (sessionIds.size === 0) return usage;
	const receiptRoot = join(clioStateDir(), "receipts");
	let files: string[];
	try {
		files = (await readdir(receiptRoot)).filter((name) => name.endsWith(".json"));
	} catch {
		return usage;
	}
	for (const file of files) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(join(receiptRoot, file), "utf8"));
		} catch {
			continue;
		}
		if (!isRecord(parsed) || typeof parsed.sessionId !== "string" || !sessionIds.has(parsed.sessionId)) continue;
		usage.tokens += readNumber(parsed.tokenCount);
		usage.costUsd += readNumber(parsed.costUsd);
		usage.harness.receiptCount += 1;
		usage.harness.toolCalls += readNumber(parsed.toolCalls);
		if (isRecord(parsed.safety) && isRecord(parsed.safety.decisions)) {
			usage.harness.safetyBlocks += readNumber(parsed.safety.decisions.blocked);
		}
	}
	return usage;
}

function runInfraError(label: string, run: CapturedRun): string | null {
	if (run.timedOut) return `${label} run timed out`;
	if (run.exitCode !== 0) {
		const detail = run.stderr.trim().split("\n").at(-1) ?? "";
		return `${label} run exited ${run.exitCode}${detail.length > 0 ? `: ${detail}` : ""}`;
	}
	if (run.transcript.trim().length === 0 && run.finalText.trim().length === 0) {
		return `${label} run produced no transcript`;
	}
	return null;
}

function errorBullets(scenario: SkillEvalScenario, reason: string): ScoredBullet[] {
	return scenario.expected.map((text, index) => ({ index: index + 1, text, verdict: "error", reason }));
}

function captureHeadlessRun(args: ReadonlyArray<string>, cwd: string, timeoutMs: number): Promise<CapturedRun> {
	const startedMs = Date.now();
	return new Promise((resolvePromise) => {
		let stdout = "";
		let pendingStdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const keepLine = (line: string): void => {
			if (line.length === 0) return;
			if (stdout.length < CHILD_OUTPUT_LIMIT) stdout += `${line}\n`;
		};
		const child = spawn(process.execPath, [process.argv[1] ?? "", ...args], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			pendingStdout += chunk;
			const lines = pendingStdout.split("\n");
			pendingStdout = lines.pop() ?? "";
			for (const line of lines) keepLine(line);
		});
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < CHILD_OUTPUT_LIMIT) stderr += chunk;
		});
		let killTimer: NodeJS.Timeout | undefined;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
		}, timeoutMs);
		const finish = (exitCode: number): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (killTimer !== undefined) clearTimeout(killTimer);
			keepLine(pendingStdout);
			pendingStdout = "";
			const parsedRun = parseRunStdout(stdout);
			resolvePromise({
				...parsedRun,
				exitCode,
				timedOut,
				wallTimeMs: Date.now() - startedMs,
				stderr,
			});
		};
		child.on("error", (error) => {
			stderr += `\n${error.message}`;
			finish(1);
		});
		child.on("close", (code) => finish(typeof code === "number" ? code : timedOut ? 124 : 1));
	});
}

/**
 * Fold a headless run's stdout into a compact transcript. `--json` runs emit
 * one terminal JSONL event per line (session header, message_end,
 * tool_execution_*, turn_start, turn_end);
 * text-mode runs emit the final assistant text, which passes through as-is.
 */
function parseRunStdout(stdout: string): { sessionId: string | null; transcript: string; finalText: string } {
	let sessionId: string | null = null;
	const lines: string[] = [];
	let finalText = "";
	let sawJson = false;
	for (const line of stdout.split("\n")) {
		if (line.trim().length === 0) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(event)) continue;
		sawJson = true;
		if (event.type === "session" && typeof event.id === "string") {
			sessionId = event.id;
			continue;
		}
		if (event.type === "tool_execution_start") {
			const tool = readString(event.toolName) ?? readString(event.tool) ?? "tool";
			const args = event.args ?? event.arguments ?? event.input;
			lines.push(`TOOL ${tool} args=${preview(args)}`);
			// Terminating tools end the turn with no assistant text; their content
			// IS the answer, so keep it whole (the judge verdict may live here).
			if (tool === "artifact" && isRecord(args) && typeof args.content === "string") {
				lines.push(`TERMINAL ${tool} content:\n${args.content}`);
			}
			continue;
		}
		if (event.type === "tool_execution_end") {
			const tool = readString(event.toolName) ?? readString(event.tool) ?? "tool";
			const status = event.isError === true ? "error" : "ok";
			lines.push(`RESULT ${tool} ${status}: ${preview(event.result)}`);
			continue;
		}
		if (event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant") {
			const content = Array.isArray(event.message.content) ? event.message.content : [];
			const text = content
				.filter((item): item is { type: "text"; text: string } => {
					return isRecord(item) && item.type === "text" && typeof item.text === "string";
				})
				.map((item) => item.text)
				.join("")
				.trim();
			if (text.length > 0) {
				lines.push(`ASSISTANT: ${text}`);
				finalText = text;
			}
		}
	}
	if (!sawJson) {
		const text = stdout.trim();
		return { sessionId: null, transcript: text, finalText: text };
	}
	return { sessionId, transcript: elide(lines.join("\n")), finalText };
}

function judgePrompt(scenario: SkillEvalScenario, baselineTranscript: string, treatmentTranscript: string): string {
	const bullets = scenario.expected.map((text, index) => `${index + 1}. ${text}`).join("\n");
	return [
		"You are scoring a skill evaluation. Two transcripts follow: BASELINE ran without the skill, TREATMENT ran with the skill loaded.",
		"Score each EXPECTED bullet strictly against the TREATMENT transcript; the baseline exists only for gap context.",
		"A bullet passes only if the treatment transcript observably satisfies it; anything unverifiable from the transcript fails.",
		'Reply with STRICT JSON only, no prose and no code fences, exactly: {"bullets":[{"index":1,"pass":true,"reason":"<= 25 words"}]}',
		`Include one entry per bullet, indexes 1 through ${scenario.expected.length} in order.`,
		"Do not use any tools. Respond with the JSON verdict directly.",
		"",
		`SCENARIO ${scenario.id} - ${scenario.title}`,
		`SETUP: ${scenario.setup}`,
		"",
		"EXPECTED BULLETS:",
		bullets,
		"",
		"BASELINE TRANSCRIPT:",
		baselineTranscript.length > 0 ? baselineTranscript : "(empty)",
		"",
		"TREATMENT TRANSCRIPT:",
		treatmentTranscript.length > 0 ? treatmentTranscript : "(empty)",
	].join("\n");
}

/** Exported for contracts tests. */
export function parseJudgeVerdicts(scenario: SkillEvalScenario, judge: CapturedRun): ScoredBullet[] {
	const parsed = extractBulletsObject(judge.finalText) ?? extractBulletsObject(judge.transcript);
	const entries = new Map<number, { pass: boolean; reason: string }>();
	if (parsed !== null && Array.isArray(parsed.bullets)) {
		for (const item of parsed.bullets) {
			if (!isRecord(item)) continue;
			const index = typeof item.index === "number" ? item.index : Number.parseInt(String(item.index), 10);
			if (!Number.isInteger(index)) continue;
			entries.set(index, {
				pass: item.pass === true,
				reason: readString(item.reason) ?? "",
			});
		}
	}
	return scenario.expected.map((text, i) => {
		const index = i + 1;
		const entry = entries.get(index);
		if (entry === undefined) {
			return { index, text, verdict: "error" as const, reason: "judge output missing this bullet" };
		}
		return { index, text, verdict: entry.pass ? ("pass" as const) : ("fail" as const), reason: entry.reason };
	});
}

/**
 * Find the JSON object carrying the judge's `bullets` array anywhere in the
 * text: models wrap verdicts in prose, code fences, or terminating tool
 * content, so this walks candidate `{` openers around the first "bullets" key
 * and balance-scans to the matching close brace.
 */
export function extractBulletsObject(text: string): Record<string, unknown> | null {
	const stripped = text.replace(/```(?:json)?/g, "");
	const bulletsAt = stripped.indexOf('"bullets"');
	if (bulletsAt < 0) return null;
	let start = stripped.lastIndexOf("{", bulletsAt);
	while (start >= 0) {
		const candidate = balancedJsonSlice(stripped, start);
		if (candidate !== null) {
			try {
				const parsed = JSON.parse(candidate) as unknown;
				if (isRecord(parsed) && Array.isArray(parsed.bullets)) return parsed;
			} catch {
				// Try the next opener out.
			}
		}
		// lastIndexOf clamps a negative fromIndex to 0, so stepping from 0 would
		// loop forever on a leading brace.
		if (start === 0) break;
		start = stripped.lastIndexOf("{", start - 1);
	}
	return null;
}

/** Slice a balanced {...} region starting at `start`, string-aware. */
function balancedJsonSlice(text: string, start: number): string | null {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i += 1) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			if (inString) escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

function synthesizeArtifact(
	skillName: string,
	evalsPath: string,
	evalsRaw: string,
	startedAt: string,
	endedAt: string,
	outcomes: ReadonlyArray<ScenarioOutcome>,
	target: string | undefined,
): EvalRunArtifact {
	const contentHash = createHash("sha256").update(evalsRaw, "utf8").digest("hex");
	const stamp = startedAt.replace(/[-:.]/g, "");
	const evalId = `skill-${skillName}-${stamp}-${contentHash.slice(0, 8)}`;
	const results: EvalRunRecord[] = outcomes.map((outcome) => {
		const pass = outcome.bullets.length > 0 && outcome.bullets.every((bullet) => bullet.verdict === "pass");
		const record: EvalRunRecord = {
			taskId: outcome.scenario.id,
			runId: `${evalId}-${outcome.scenario.id}`,
			repeatIndex: 0,
			cwd: outcome.workspace,
			prompt: outcome.scenario.setup,
			tags: [
				"skill-eval",
				`skill:${skillName}`,
				...outcome.bullets.map((bullet) => `bullet-${bullet.index}:${bullet.verdict}`),
			],
			pass,
			exitCode: pass ? 0 : 1,
			tokens: outcome.usage.tokens,
			costUsd: outcome.usage.costUsd,
			wallTimeMs: outcome.wallTimeMs,
			harness: outcome.usage.harness,
			commands: [],
		};
		if (!pass) record.failureClass = "verifier_failed";
		return record;
	});
	return {
		version: 1,
		evalId,
		taskFile: evalsPath,
		taskFileHash: contentHash,
		clio: evalClioProvenance(),
		environment: evalEnvironmentProvenance(),
		target: target ?? null,
		model: null,
		thinking: null,
		paths: { taskFile: evalsPath, receipts: [], sessionLedgers: [] },
		repeat: 1,
		startedAt,
		endedAt,
		summary: summarizeEvalResults(results),
		results,
	};
}

function sidecar(skillName: string, evalId: string, outcomes: ReadonlyArray<ScenarioOutcome>): unknown {
	return {
		version: 1,
		schema: "experimental",
		kind: "skill-eval",
		skill: skillName,
		evalId,
		deltas: [
			"bullet verdicts are judge-scored from run transcripts, not command exit codes; the evals-domain artifact carries scenario-level records with empty command lists",
			"tokens and cost are rolled up from headless main-agent receipts when those receipts are present",
			"this sidecar is additive and is registered in overview.json files[]",
		],
		scenarios: outcomes.map((outcome) => ({
			id: outcome.scenario.id,
			title: outcome.scenario.title,
			setup: outcome.scenario.setup,
			fixtureCommands: outcome.scenario.fixtureCommands ?? null,
			infraError: outcome.infraError,
			usage: outcome.usage,
			bullets: outcome.bullets,
			baseline: sidecarRun(outcome.baseline),
			treatment: sidecarRun(outcome.treatment),
			judge: sidecarRun(outcome.judge),
		})),
	};
}

function sidecarRun(run: CapturedRun | null): unknown {
	if (run === null) return null;
	return {
		sessionId: run.sessionId,
		exitCode: run.exitCode,
		timedOut: run.timedOut,
		wallTimeMs: run.wallTimeMs,
		transcript: run.transcript,
		stderrTail: run.stderr.slice(-500),
	};
}

function printHumanReport(
	skillName: string,
	outcomes: ReadonlyArray<ScenarioOutcome>,
	evalId: string,
	evidenceId: string | null,
	evidenceDirectory: string | null,
): void {
	const rows: string[][] = [["scenario", "bullet", "verdict", "expected"]];
	for (const outcome of outcomes) {
		for (const bullet of outcome.bullets) {
			rows.push([outcome.scenario.id, String(bullet.index), bullet.verdict, truncate(bullet.text, 76)]);
		}
	}
	process.stdout.write(formatColumns(rows));
	const total = outcomes.reduce((sum, outcome) => sum + outcome.bullets.length, 0);
	const passed = outcomes.reduce(
		(sum, outcome) => sum + outcome.bullets.filter((bullet) => bullet.verdict === "pass").length,
		0,
	);
	process.stdout.write(`\n${skillName}: ${passed}/${total} bullets passed (judge-scored, experimental)\n`);
	for (const outcome of outcomes) {
		if (outcome.infraError !== null) {
			process.stdout.write(`${outcome.scenario.id}: infra error: ${outcome.infraError}\n`);
			continue;
		}
		for (const bullet of outcome.bullets.filter((item) => item.verdict !== "pass")) {
			process.stdout.write(
				`${outcome.scenario.id} bullet ${bullet.index} ${bullet.verdict}${bullet.reason.length > 0 ? `: ${bullet.reason}` : ""}\n`,
			);
		}
	}
	process.stdout.write(`eval artifact: ${evalId}\n`);
	if (evidenceId !== null && evidenceDirectory !== null) {
		process.stdout.write(`evidence: ${evidenceId} at ${evidenceDirectory} (per-bullet detail in skill-eval.json)\n`);
	}
}

function preview(value: unknown): string {
	if (value === undefined) return "";
	const text = typeof value === "string" ? value : safeStringify(value);
	return truncate(text.replace(/\s+/g, " ").trim(), PREVIEW_MAX_CHARS);
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

function elide(text: string): string {
	if (text.length <= TRANSCRIPT_HEAD_CHARS + TRANSCRIPT_TAIL_CHARS) return text;
	return `${text.slice(0, TRANSCRIPT_HEAD_CHARS)}\n[... transcript elided ...]\n${text.slice(-TRANSCRIPT_TAIL_CHARS)}`;
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
