import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { clioDataDir, clioStateDir } from "../core/xdg.js";
import {
	type EvalRunArtifact,
	type EvalRunRecord,
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
 * command lists and zero token/cost totals (headless main-agent runs do not
 * produce receipts), and the per-bullet detail lands in a `skill-eval.json`
 * sidecar registered in the bundle's `overview.json` files list.
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
	scenario?: string;
	target?: string;
	timeoutSeconds?: number;
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
	const wanted = options.scenario === undefined ? null : normalizeScenarioId(options.scenario);
	const scenarios =
		wanted === null ? parsed.scenarios : parsed.scenarios.filter((scenario) => scenario.number === wanted);
	if (scenarios.length === 0) {
		printError(
			wanted === null
				? `no parseable scenarios in ${evalsPath}`
				: `scenario S${wanted} not found in ${evalsPath} (have: ${parsed.scenarios.map((s) => s.id).join(", ") || "none"})`,
		);
		return 2;
	}

	const timeoutMs = options.timeoutSeconds !== undefined ? options.timeoutSeconds * 1000 : DEFAULT_RUN_TIMEOUT_MS;
	const startedAt = new Date().toISOString();
	const outcomes: ScenarioOutcome[] = [];
	for (const scenario of scenarios) {
		process.stderr.write(`clio skills eval: ${skill.name} ${scenario.id} baseline/treatment/judge...\n`);
		outcomes.push(await runScenario(skill.name, resolved.baseDir, scenario, options.target, timeoutMs));
	}
	const endedAt = new Date().toISOString();

	const artifact = synthesizeArtifact(skill.name, evalsPath, evalsRaw, startedAt, endedAt, outcomes);
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
	return anyFailure || evidenceErrors.length > 0 ? 1 : 0;
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

function normalizeScenarioId(value: string): number | null {
	const match = /^[sS]?(\d+)$/.exec(value.trim());
	if (match === null) return null;
	return Number.parseInt(match[1] ?? "", 10);
}

async function runScenario(
	skillName: string,
	skillBaseDir: string,
	scenario: SkillEvalScenario,
	target: string | undefined,
	timeoutMs: number,
): Promise<ScenarioOutcome> {
	const scenarioStart = Date.now();
	const workspace = await mkdtemp(join(tmpdir(), "clio-skill-eval-"));
	const targetArgs = target === undefined ? [] : ["--target", target];
	try {
		const baseline = await captureHeadlessRun(
			["run", "--json", "--no-skills", ...targetArgs, scenario.setup],
			workspace,
			timeoutMs,
		);
		const treatment = await captureHeadlessRun(
			["run", "--json", "--no-skills", "--skill", skillBaseDir, ...targetArgs, `/skill:${skillName} ${scenario.setup}`],
			workspace,
			timeoutMs,
		);
		const infra = runInfraError("baseline", baseline) ?? runInfraError("treatment", treatment);
		if (infra !== null) {
			return {
				scenario,
				bullets: errorBullets(scenario, infra),
				baseline,
				treatment,
				judge: null,
				workspace,
				wallTimeMs: Date.now() - scenarioStart,
				infraError: infra,
			};
		}
		// The judge also runs with --json: a model that ends the turn through a
		// terminating tool (write_plan/write_review) prints nothing in text mode,
		// while the event stream still carries the verdict content.
		const judge = await captureHeadlessRun(
			["run", "--json", "--no-skills", ...targetArgs, judgePrompt(scenario, baseline.transcript, treatment.transcript)],
			workspace,
			timeoutMs,
		);
		const judgeInfra = runInfraError("judge", judge);
		if (judgeInfra !== null) {
			return {
				scenario,
				bullets: errorBullets(scenario, judgeInfra),
				baseline,
				treatment,
				judge,
				workspace,
				wallTimeMs: Date.now() - scenarioStart,
				infraError: judgeInfra,
			};
		}
		const bullets = parseJudgeVerdicts(scenario, judge);
		return {
			scenario,
			bullets,
			baseline,
			treatment,
			judge,
			workspace,
			wallTimeMs: Date.now() - scenarioStart,
			infraError: null,
		};
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
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

/**
 * Streaming delta events (`message_update`, `thinking_delta`, `text_delta`)
 * each carry the entire partial assistant message, so a long turn emits tens
 * of megabytes of JSONL that would blow the capture cap and drop the terminal
 * `message_end`/`tool_execution_*` events. Filter them out line-by-line while
 * streaming; the transcript builder never reads them.
 */
const NOISE_EVENT_MARKERS = [
	'"type":"message_update"',
	'"type":"thinking_delta"',
	'"type":"text_delta"',
	'"type":"message_start"',
];

function isNoiseEventLine(line: string): boolean {
	if (!line.startsWith("{")) return false;
	return NOISE_EVENT_MARKERS.some((marker) => line.includes(marker));
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
			if (line.length === 0 || isNoiseEventLine(line)) return;
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
 * one JSONL event per line (session header, message_end, tool_execution_*);
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
			if ((tool === "write_plan" || tool === "write_review") && isRecord(args) && typeof args.content === "string") {
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
			tokens: 0,
			costUsd: 0,
			wallTimeMs: outcome.wallTimeMs,
			harness: { ...ZERO_EVAL_HARNESS_METRICS },
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
			"tokens and cost are zero: headless main-agent runs produce no receipts",
			"this sidecar is additive and is registered in overview.json files[]",
		],
		scenarios: outcomes.map((outcome) => ({
			id: outcome.scenario.id,
			title: outcome.scenario.title,
			setup: outcome.scenario.setup,
			infraError: outcome.infraError,
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
