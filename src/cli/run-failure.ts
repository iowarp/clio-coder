import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { readClioVersion } from "../core/package-root.js";
import type { RunResult } from "../domains/dispatch/types.js";
import { redactUrlCredentials } from "../domains/safety/redaction.js";
import { serializeJsonLine, setFrameProjector, writeFrame } from "./modes/jsonl.js";
import type {
	RunJsonDispatchedRunOutcome,
	RunJsonDispatchSettlementFrame,
	RunJsonFrame,
	RunJsonResultFrame,
	RunJsonRunEndFrame,
	RunJsonTerminalTurnEndFrame,
	RunJsonVerifyFrame,
	RunJsonVerifyResult,
} from "./modes/run-json-schema.js";
import {
	RUN_RESULT_SCHEMA_VERSION,
	type RunCauseCode,
	type RunDispatchedRunV2,
	type RunExitFact,
	type RunLimitsV2,
	type RunResultEnvelopeV2,
	type RunSteerFrameV2,
	type RunUsageV2,
	resolveRunExit,
	signalForExitCode,
	verifyChecksV2,
} from "./modes/run-json-schema-v2.js";
import { flushRawStdout, isStdoutDead, writeRawStdout } from "./output-guard.js";
import { steerChannelRefusal } from "./steer-channel.js";

interface RunFailureState {
	pending: boolean;
	diagnostic?: string;
	/** Every diagnostic written before output started, in order; the last one is `diagnostic`. */
	diagnostics?: string[];
}

const runFailureState = new AsyncLocalStorage<RunFailureState>();

/** A full-mode `run --json` stream ends with exactly one `run_end` (S-51); the headless run notes the one it wrote. */
let runEndWritten = false;

export function noteRunEndWritten(): void {
	runEndWritten = true;
}

export function writeRunDiagnostic(text: string): void {
	// A diagnostic can quote a failure's message, and it reaches stderr and a turn_end frame's error alike (#446).
	const shown = redactUrlCredentials(text);
	const state = runFailureState.getStore();
	if (state?.pending) {
		state.diagnostic = shown.trim();
		state.diagnostics = [...(state.diagnostics ?? []), state.diagnostic];
	}
	process.stderr.write(shown);
}

/**
 * A refusal the main run makes after boot but before its turn (`--require-priced`): written like any diagnostic and
 * kept for the exit-2 cause even though run output has started.
 */
export function writeRunRefusal(text: string): void {
	writeRunDiagnostic(text);
	const state = runFailureState.getStore();
	if (state && !state.pending) state.diagnostics = [...(state.diagnostics ?? []), redactUrlCredentials(text).trim()];
}

/** Pre-work refusals that carry a narrower cause than `not_started`, known by the diagnostic each one writes. */
const START_REFUSALS: ReadonlyArray<readonly [RegExp, RunCauseCode]> = [
	// SPEC C17: an option `run` does not take, including a global or interactive-only flag written after `run`.
	[/^clio-coder run: unknown option: /u, "unknown_flag"],
	[
		/^clio-coder run: \S+ (?:is a global option and must come before the subcommand|applies only to the interactive session)/u,
		"unknown_flag",
	],
	// SPEC 6.2: no task text, from an empty pipe, a terminal with no task, or `-` on a terminal.
	[/^clio-coder run: empty task/u, "empty_task"],
	[/^clio-coder run: `-` reads the task from stdin, but stdin is a terminal/u, "empty_task"],
	// SPEC 6.4 mode matrix: a main-only input given with --agent, or a dispatch-only flag without it.
	[/^clio-coder run: .* (?:applies|apply) to the main agent/u, "flag_conflict"],
	[/^clio-coder run: .* apply to the main-agent task/u, "flag_conflict"],
	[/^clio-coder run: @\S+: image attachments go to the main agent, not --agent dispatch/u, "flag_conflict"],
	[/^clio-coder run: fleet dispatch flags require --agent /u, "flag_conflict"],
	[/--output-format cannot be combined with --json or --json-events/u, "flag_conflict"],
	[/--deny-tools removes every tool --allow-tools names /u, "flag_conflict"],
	[/--dry-run prints its plan as JSON with --output-format json/u, "flag_conflict"],
	// SPEC 6.2, 6.3: the task envelope's refusals (src/cli/task-envelope.ts).
	[/--task-file carries the task and its attachments/u, "task_file_conflict"],
	[/^clio-coder run: task file key \S+ is also given as /u, "task_flag_conflict"],
	[/^clio-coder run: task file carries .*pass --trust-task-file/u, "task_authority"],
	[/^clio-coder run: task file output\.schema: /u, "schema_unsupported"],
	// SPEC 6.6: an envelope version this release does not read.
	[/^clio-coder run: task file schemaVersion: /u, "schema_unsupported"],
	[/^clio-coder run: not configured: /u, "not_configured"],
	// SPEC 6.8: a schema `--output-schema` cannot enforce, refused before any model call.
	[/^clio-coder run: --output-schema: /u, "schema_unsupported"],
	// SPEC 6.9: the preflight's refusal names the unpriced route; declaring its pricing is the fix.
	[/^clio-coder run: --require-priced: /u, "not_configured"],
	// The orchestrator's resume refusal when another process holds the session (SPEC L3, 6.7; liveSessionRefusal).
	[/^clio-coder run: failed to resume session \S+: session \S+ is open in another process /u, "session_live"],
	// SPEC 6.6, C17: a --steer-channel that cannot be opened is refused before boot (CLI-P22).
	[/^clio-coder run: --steer-channel cannot be opened: /u, "io"],
];

/** The cause of an exit-2 refusal before any work, from the diagnostics it wrote: the first that names one wins. */
export function startRefusalCause(diagnostics: ReadonlyArray<string>): { code: RunCauseCode; message?: string } {
	for (const diagnostic of diagnostics) {
		const row = START_REFUSALS.find(([pattern]) => pattern.test(diagnostic));
		if (row !== undefined) return { code: row[1], message: diagnostic };
	}
	return { code: "not_started" };
}

export function startRunOutput(): void {
	const state = runFailureState.getStore();
	if (state) state.pending = false;
}

export async function withRunFailureReporting(
	json: boolean,
	run: () => Promise<number>,
	fullMainStream = false,
	output?: OutputLastMessageRequest,
): Promise<number> {
	if (!json) return run();
	// CLI-P14: `-o` beside --json keeps v2's semantics (SPEC 6.6) and leaves every v1 frame as it was written.
	const execute =
		output === undefined
			? run
			: async (): Promise<number> => {
					const resolved = resolveOutputTarget(output);
					if (!prepareOutputTarget(resolved)) return 2;
					let text = "";
					structuredNote = undefined;
					setFrameProjector((frame) => {
						const answer = turnAnswer(frame);
						if (answer !== null) text = answer;
						return frame;
					});
					let code: number;
					try {
						code = await run();
					} finally {
						setFrameProjector(null);
					}
					if (code !== 0 || writeOutputFile(resolved, `${structuredAnswerJson() ?? text}\n`)) return code;
					writeRunDiagnostic(`clio-coder run: --output-last-message could not be written: ${resolved}\n`);
					return 1;
				};
	const state: RunFailureState = { pending: true };
	const startedAt = new Date().toISOString();
	runEndWritten = false;
	const runEndFrame = (exitCode: number): RunJsonRunEndFrame => ({
		type: "run_end",
		startedAt,
		endedAt: new Date().toISOString(),
		exitCode,
		error: state.diagnostic || `clio-coder run failed (exit ${exitCode})`,
		outcome: exitCode === 124 ? "timed_out" : "failed",
	});
	const runEndOwed = (exitCode: number): boolean => {
		if (!fullMainStream || exitCode === 0 || isStdoutDead() || runEndWritten) return false;
		runEndWritten = true;
		return true;
	};
	const failureFrame = (exitCode: number): RunJsonTerminalTurnEndFrame => ({
		type: "turn_end",
		startedAt,
		endedAt: new Date().toISOString(),
		exitCode,
		text: "",
		error: state.diagnostic || `clio-coder run failed before output started (exit ${exitCode})`,
		outcome: exitCode === 124 ? "timed_out" : "failed",
	});
	// Audit finding 9: coordinated boot shutdown calls process.exit, which cannot await a stdout flush.
	const onExit = (exitCode: number): void => {
		if (exitCode === 0 || isStdoutDead()) return;
		if (state.pending) {
			state.pending = false;
			writeSync(1, `${JSON.stringify(failureFrame(exitCode))}\n`);
		}
		if (runEndOwed(exitCode)) writeSync(1, `${JSON.stringify(runEndFrame(exitCode))}\n`);
	};
	process.once("exit", onExit);
	return runFailureState.run(state, async () => {
		try {
			const code = await execute();
			let wrote = false;
			if (state.pending && code !== 0) {
				state.pending = false;
				writeFrame(failureFrame(code));
				wrote = true;
			}
			if (runEndOwed(code)) {
				writeFrame(runEndFrame(code));
				wrote = true;
			}
			if (wrote) await flushRawStdout();
			return code;
		} catch (error) {
			const diagnostic = redactUrlCredentials(error instanceof Error ? error.message : String(error));
			if (state.pending) {
				state.pending = false;
				state.diagnostic = diagnostic;
				writeFrame(failureFrame(1));
			}
			if (runEndOwed(1)) writeFrame({ ...runEndFrame(1), error: state.diagnostic || diagnostic });
			if (!isStdoutDead()) await flushRawStdout();
			throw error;
		} finally {
			process.off("exit", onExit);
		}
	});
}

/** `-o` as the caller gave it; the path resolves against the run directory (SPEC 6.2). */
interface OutputLastMessageRequest {
	path: string;
	cwd?: string;
}

function resolveOutputTarget(request: OutputLastMessageRequest): string {
	const base = request.cwd !== undefined ? path.resolve(request.cwd) : process.cwd();
	return path.resolve(base, request.path);
}

/** SPEC 6.6: a stale `-o` file is removed at preflight; false (refusal written) when its directory does not exist. */
function prepareOutputTarget(resolved: string): boolean {
	if (!existsSync(path.dirname(resolved))) {
		writeRunDiagnostic(`clio-coder run: --output-last-message directory does not exist: ${path.dirname(resolved)}\n`);
		return false;
	}
	rmSync(resolved, { force: true });
	return true;
}

/** `-o` is written once, by temp file and rename; false when the write failed, which leaves no file. */
function writeOutputFile(resolved: string, bytes: string): boolean {
	const temporary = `${resolved}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, bytes);
		renameSync(temporary, resolved);
		return true;
	} catch {
		rmSync(temporary, { force: true });
		return false;
	}
}

/** The answer a v1 `turn_end` frame carries: what text mode prints on stdout. */
function turnAnswer(frame: RunJsonFrame): string | null {
	if (frame.type !== "turn_end") return null;
	const carried = (frame as { text?: unknown }).text;
	return answerText(frame) ?? (typeof carried === "string" ? carried : null);
}

/** What the headless main agent tells a v2 writer directly: facts no v1 frame carries. */
interface MainRunNoteV2 {
	runId?: string;
	parentSessionId?: string;
	usage?: RunUsageV2;
	sessionReadyMs?: number;
	/** Routes the run can reach whose cost `--max-cost-usd` cannot bound. */
	unpricedRoutes?: string[];
}

/** SPEC 6.6/6.8: what `--output-schema` settled; absent for a run without the flag. */
interface StructuredNoteV2 {
	enforcedBy: "host" | "host+provider";
	/** The validated object, only for an answer that matched. */
	structured?: Record<string, unknown>;
	/** The JSON text that matched, which `-o` holds. */
	json?: string;
	/** The validator's errors for an answer that still did not match. */
	errors?: string[];
}

let structuredNote: StructuredNoteV2 | undefined;

/** The validated `--output-schema` JSON the run noted, which `-o` holds instead of the answer text (SPEC 6.8). */
function structuredAnswerJson(): string | undefined {
	return structuredNote?.json;
}

/** Hand the v2 writer the structured-output verdict (main or `--agent`); a no-op shape for runs without the flag. */
export function noteStructuredV2(note: StructuredNoteV2): void {
	structuredNote = note;
}

let v2Started: number | null = null;
let v2StreamJson = false;
/** Steer frames read before the session frame went out; null once it has. */
let heldSteer: string[] | null = null;
let textSummary = false;

/** `--output-format text` asks the main run for one stderr summary line once it settles. */
export function requestRunTextSummary(): void {
	textSummary = true;
}

export function runTextSummaryRequested(): boolean {
	return textSummary;
}
let mainRunNote: MainRunNoteV2 = {};
/** CLI-5: dispatched failures a later dispatch of the same task delivered, for the envelope's `dispatch.superseded`. */
let supersededRuns: RunDispatchedRunV2[] = [];

/** Hand the v2 writer the superseded dispatched failures; a no-op for v1 runs. */
export function noteDispatchSupersededV2(runs: ReadonlyArray<RunJsonDispatchedRunOutcome>): void {
	if (v2Started === null) return;
	supersededRuns = runs.map((run) => ({
		runId: run.runId,
		agentId: run.agentId,
		...(run.outcome !== null ? { outcome: run.outcome } : {}),
		...(run.outcomeCode !== null ? { outcomeCode: run.outcomeCode } : {}),
		...(run.outcomeDetail !== null ? { outcomeDetail: run.outcomeDetail } : {}),
	}));
}
/** `--dry-run`: the plan the v2 envelope carries with outcome `previewed` (CLI-L4). */
let runPlan: Readonly<Record<string, unknown>> | undefined;

/** Hand the v2 writer a `--dry-run` plan; a no-op for v1 runs. */
export function noteRunPlan(plan: object): void {
	if (v2Started !== null) runPlan = { ...plan };
}

/**
 * SPEC 6.9 `limits`: what was requested and what is enforced. Every accepted limit is enforced, because one
 * this build cannot enforce is refused at preflight. Undefined when no limit was given.
 */
export function runLimitsV2(
	requested: RunLimitsV2["requested"] | undefined,
	usage?: RunUsageV2,
	unpricedRoutes?: ReadonlyArray<string>,
): RunLimitsV2 | undefined {
	if (requested === undefined || Object.keys(requested).length === 0) return undefined;
	const spend = (usage?.total ?? usage?.main)?.sums.usd.coverage.unknown ?? 0;
	return {
		requested: { ...requested },
		enforced: Object.keys(requested),
		...(requested.maxCostUsd !== undefined
			? { cost: { overshootPossible: true, unpricedCalls: spend, unpricedRoutes: [...(unpricedRoutes ?? [])] } }
			: {}),
	};
}

/** True while a `--output-format json|stream-json` run is being written, so v1 runs pay for nothing v2 reads. */
export function runResultV2Active(): boolean {
	return v2Started !== null;
}

/** Hand the v2 writer the run id, the folded usage or the moment the session was ready; a no-op for v1 runs. */
export function noteMainRunV2(note: {
	runId?: string;
	usage?: RunUsageV2;
	sessionReady?: true;
	parentSessionId?: string;
	unpricedRoutes?: string[];
}): void {
	if (v2Started === null) return;
	if (note.unpricedRoutes !== undefined) mainRunNote.unpricedRoutes = [...note.unpricedRoutes];
	if (note.runId !== undefined) mainRunNote.runId = note.runId;
	if (note.parentSessionId !== undefined) mainRunNote.parentSessionId = note.parentSessionId;
	if (note.usage !== undefined) mainRunNote.usage = note.usage;
	if (note.sessionReady === true && mainRunNote.sessionReadyMs === undefined)
		mainRunNote.sessionReadyMs = Math.round(performance.now() - v2Started);
}

/** One steer frame per channel line the reader took, written only under `--output-format stream-json`. */
export function noteSteerV2(line: number, status: RunSteerFrameV2["status"], reason?: string): void {
	if (!v2StreamJson || isStdoutDead()) return;
	const frame: RunSteerFrameV2 = { type: "steer", line, status, ...(reason !== undefined ? { reason } : {}) };
	// The session frame is always first: a line read before it waits for it.
	if (heldSteer !== null) heldSteer.push(serializeJsonLine(frame));
	else writeRawStdout(serializeJsonLine(frame));
}

/** A `run --output-format json|stream-json` request, as far as the v2 writer needs it. */
export interface RunResultV2Request {
	format: "json" | "stream-json";
	mode: "main" | "agent";
	agentId?: string;
	verify: ReadonlyArray<string>;
	outputLastMessage?: string;
	/** `--steer-channel`: refused before boot when it cannot be opened (SPEC 6.6). */
	steerChannel?: string;
	cwd?: string;
	timeoutSeconds?: number;
	/** The limits the run was given (SPEC 6.9); the envelope carries them as `limits` when any is set. */
	limits?: RunLimitsV2["requested"];
}

/** What the v1 frames told the v2 writer; the run itself still speaks v1 underneath. */
interface SeenFrames {
	session?: { id?: string; target?: string; model?: string; runId?: string };
	text: string;
	runEnd?: RunJsonRunEndFrame;
	verify?: RunJsonVerifyResult[];
	live: RunJsonDispatchedRunOutcome[];
	undelivered: RunJsonDispatchedRunOutcome[];
	receipt?: RunResult;
	failedChecks?: string[];
	verdict?: string;
	/** Milliseconds from the run's start to the loop's first `agent_start` and first streamed delta, as written. */
	firstRequestMs?: number;
	firstTokenMs?: number;
	/** The last assistant message ended in the provider's error (not a harness stop): SPEC 6.5 row 8 `provider_error`. */
	providerError?: boolean;
}

const LIMIT_CODES: ReadonlyArray<RunCauseCode> = [
	"session_cost_ceiling",
	"max_cost_usd",
	"autonomous_cap",
	"max_requests",
	"max_tool_calls",
];
const WORK_CODES: ReadonlyArray<RunCauseCode> = ["provider_error", "no_answer", "output_limit", "noop", "limitation"];

function answerText(frame: RunJsonFrame): string | null {
	const message = (frame as { message?: { role?: string; content?: unknown } }).message;
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return null;
	const parts: string[] = [];
	for (const block of message.content as unknown[]) {
		const entry = block as { type?: unknown; text?: unknown } | null;
		if (entry?.type === "text" && typeof entry.text === "string") parts.push(entry.text);
	}
	return parts.length > 0 ? parts.join("") : null;
}

/** Read one v1 frame into `seen` and return what a v2 stream writes in its place; null withholds it. */
function projectV1Frame(frame: RunJsonFrame, seen: SeenFrames, format: RunResultV2Request["format"]): object | null {
	const sinceStart = v2Started === null ? undefined : Math.round(performance.now() - v2Started);
	if (frame.type === "agent_start" && seen.firstRequestMs === undefined && sinceStart !== undefined)
		seen.firstRequestMs = sinceStart;
	if ((frame.type === "text_delta" || frame.type === "thinking_delta") && seen.firstTokenMs === undefined)
		if (sinceStart !== undefined) seen.firstTokenMs = sinceStart;
	switch (frame.type) {
		case "session": {
			const header = frame as { id?: string | null; target?: string | null; model?: string | null; runId?: string };
			seen.session = {
				...(typeof header.id === "string" ? { id: header.id } : {}),
				...(typeof header.target === "string" ? { target: header.target } : {}),
				...(typeof header.model === "string" ? { model: header.model } : {}),
				...(header.runId !== undefined ? { runId: header.runId } : {}),
			};
			if (format === "json") return null;
			// v2 never sends null: a pending session has no `id` key at all.
			const rewritten: Record<string, unknown> = { ...frame, schemaVersion: RUN_RESULT_SCHEMA_VERSION };
			for (const [key, value] of Object.entries(rewritten)) if (value === null) delete rewritten[key];
			const held = heldSteer;
			// writeFrame writes the returned session frame synchronously; held steer frames follow it, and a frame noted
			// before they go out joins them, so a line's frames keep their order.
			if (held !== null)
				queueMicrotask(() => {
					if (heldSteer !== held) return;
					heldSteer = null;
					if (held.length > 0 && !isStdoutDead()) writeRawStdout(held.join(""));
				});
			return rewritten;
		}
		case "turn_end": {
			const text = turnAnswer(frame);
			if (text !== null) seen.text = text;
			break;
		}
		case "verify":
			seen.verify = (frame as RunJsonVerifyFrame).checks;
			break;
		case "dispatch_settlement": {
			const settlement = frame as RunJsonDispatchSettlementFrame;
			seen.live = settlement.live;
			seen.undelivered = settlement.undelivered;
			break;
		}
		case "run_end":
			seen.runEnd = frame as RunJsonRunEndFrame;
			return null;
		case "message_end": {
			const message = (frame as { message?: { role?: string; stopReason?: unknown; harnessStopped?: unknown } }).message;
			if (message?.role === "assistant")
				seen.providerError = message.stopReason === "error" && message.harnessStopped !== true;
			break;
		}
		case "result": {
			const result = frame as RunJsonResultFrame;
			seen.receipt = result.result;
			if (result.verdict !== undefined) seen.verdict = result.verdict;
			if (result.failedChecks !== undefined) seen.failedChecks = result.failedChecks;
			return null;
		}
	}
	return format === "json" ? null : frame;
}

/**
 * The facts behind a run's exit, read from the exit code the run returned and the frames it wrote. Under v2 a
 * `--agent` worker that started (a receipt exists) and exited 2 is a failed run, not a refused one.
 */
function exitFacts(code: number, seen: SeenFrames, state: RunFailureState, request: RunResultV2Request): RunExitFact[] {
	const diagnostic = state.diagnostic;
	const text = seen.runEnd?.error ?? diagnostic;
	const message = text !== undefined && text.length > 0 ? { message: text } : {};
	const detail = seen.runEnd?.outcomeDetail ?? seen.receipt?.outcomeDetail ?? undefined;
	const signal = signalForExitCode(code);
	if (signal !== null) return [{ code: "interrupted", signal, ...message }];
	// An exit no row names keeps its code; run_failed carries what was said about it.
	const unnamed: RunExitFact[] = [
		{ code: "forced_exit", exitCode: code },
		{ code: "run_failed", ...message },
	];
	switch (code) {
		case 0:
			return [];
		case 124:
			return [
				{
					code: "deadline",
					...(request.timeoutSeconds !== undefined ? { seconds: request.timeoutSeconds } : {}),
					...message,
				},
			];
		case 141:
			return [{ code: "reader_closed" }];
		case 2: {
			if (request.mode === "agent" && seen.receipt !== undefined)
				return [{ code: "worker_failed", exitCode: 2, ...message }];
			const refusal = startRefusalCause(state.diagnostics ?? []);
			return [{ code: refusal.code, ...(refusal.message !== undefined ? { message: refusal.message } : message) }];
		}
		case 5:
			return [{ code: "unscripted", ...message }];
		case 3:
			return [{ code: /judge/i.test(text ?? "") ? "judge_streak" : "permission_required", ...message }];
		case 4: {
			const limit = LIMIT_CODES.find((entry) => entry === detail);
			if (limit !== undefined) {
				// A run cap's refusal names its numbers: "(limit N, observed M)".
				const counts = /\(limit (\d+), observed (\d+)\)/.exec(text ?? "");
				const payload = counts ? { limit: Number(counts[1]), observed: Number(counts[2]) } : {};
				return [{ code: limit, ...payload, ...message }];
			}
			if (text?.startsWith("budget_ceiling:"))
				return [{ code: /--max-cost-usd/.test(text) ? "max_cost_usd" : "session_cost_ceiling", ...message }];
			return unnamed;
		}
		case 1: {
			// SPEC 6.8: the answer did not match --output-schema; for --agent this outranks the worker's own exit.
			if (structuredNote?.errors !== undefined && (detail === "schema_mismatch" || request.mode === "agent"))
				return [{ code: "schema_mismatch", errors: structuredNote.errors, ...message }];
			// `--fail-on-verify` (SPEC 6.10) ranks above a sealed verdict: the failed checks are what that verdict judged.
			if (detail === "verify_failed") {
				const checks = (seen.verify ?? []).filter((check) => !check.passed).map((check) => check.command);
				return [{ code: "verify_failed", checks, ...message }];
			}
			if (seen.verdict === "failed" || (seen.failedChecks?.length ?? 0) > 0)
				return [{ code: "verdict_failed", failedChecks: seen.failedChecks ?? [], ...message }];
			const work = WORK_CODES.find((entry) => entry === detail);
			if (work !== undefined) return [{ code: work, ...message }];
			// SPEC 6.5 row 8: the provider's error ended the run; a harness stop or admission refusal stays run_failed.
			if (detail === undefined && request.mode === "main" && seen.providerError === true)
				return [{ code: "provider_error", ...message }];
			if (request.mode === "agent" && seen.receipt !== undefined)
				return [{ code: "worker_failed", exitCode: 1, ...message }];
			return [{ code: "run_failed", ...message }];
		}
		default:
			return unnamed;
	}
}

/**
 * `run --output-format json|stream-json`: the run speaks v1 underneath; its frames cross a projector that keeps the
 * stream-json event frames, rewrites the session header to schema v2 and withholds v1's closing frames, and the run
 * ends with one v2 envelope whose exit code comes from `resolveRunExit`. `json` writes only the envelope.
 */
export async function withRunResultV2(request: RunResultV2Request, run: () => Promise<number>): Promise<number> {
	const state: RunFailureState = { pending: true };
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	const seen: SeenFrames = { text: "", live: [], undelivered: [] };
	v2Started = performance.now();
	v2StreamJson = request.format === "stream-json";
	heldSteer = [];
	mainRunNote = {};
	supersededRuns = [];
	structuredNote = undefined;
	runPlan = undefined;
	let written = false;
	let outputTarget: string | undefined;
	const envelopeLines = (code: number, extra: RunExitFact[] = []): { lines: string; exitCode: number } => {
		const skipReason = code === 124 ? "deadline" : signalForExitCode(code) !== null ? "interrupted" : "turn_failed";
		const resolution = resolveRunExit([...exitFacts(code, seen, state, request), ...extra]);
		const previewed = runPlan !== undefined && resolution.causes.length === 0;
		const session = seen.session;
		const runId = session?.runId ?? mainRunNote.runId ?? seen.receipt?.runId;
		const usage = mainRunNote.usage;
		const timings = {
			...(mainRunNote.sessionReadyMs !== undefined ? { sessionReadyMs: mainRunNote.sessionReadyMs } : {}),
			...(seen.firstRequestMs !== undefined ? { firstRequestMs: seen.firstRequestMs } : {}),
			...(seen.firstTokenMs !== undefined ? { firstTokenMs: seen.firstTokenMs } : {}),
		};
		const limits = runLimitsV2(request.limits, usage, mainRunNote.unpricedRoutes);
		const envelope: RunResultEnvelopeV2 = {
			type: "run_end",
			schemaVersion: RUN_RESULT_SCHEMA_VERSION,
			mode: request.mode,
			...(runId !== undefined ? { runId } : {}),
			...(session?.id !== undefined ? { sessionId: session.id } : {}),
			...(mainRunNote.parentSessionId !== undefined && mainRunNote.parentSessionId !== session?.id
				? { parentSessionId: mainRunNote.parentSessionId }
				: {}),
			...(request.agentId !== undefined ? { agentId: request.agentId } : {}),
			pid: process.pid,
			cwd: process.cwd(),
			clioCoderVersion: readClioVersion(),
			startedAt,
			endedAt: new Date().toISOString(),
			durationMs: Date.now() - started,
			exitCode: resolution.exitCode,
			outcome: previewed ? "previewed" : resolution.outcome,
			...(resolution.causes[0] !== undefined ? { outcomeDetail: resolution.causes[0].code } : {}),
			causes: resolution.causes,
			result: {
				text: seen.text,
				artifacts: [],
				...(structuredNote?.structured !== undefined && resolution.exitCode === 0
					? { structured: structuredNote.structured }
					: {}),
				...(structuredNote !== undefined ? { enforcedBy: structuredNote.enforcedBy } : {}),
			},
			...(session?.target !== undefined || session?.model !== undefined
				? {
						route: {
							...(session.target !== undefined ? { target: session.target } : {}),
							...(session.model !== undefined ? { model: session.model } : {}),
						},
					}
				: {}),
			...(usage !== undefined ? { usage } : {}),
			verify: { requested: request.verify.length, checks: verifyChecksV2(request.verify, seen.verify, skipReason) },
			dispatch: {
				runs: seen.receipt !== undefined ? [seen.receipt] : [],
				live: seen.live,
				undelivered: seen.undelivered,
				...(supersededRuns.length > 0 ? { superseded: supersededRuns } : {}),
			},
			timings,
			...(limits !== undefined ? { limits } : {}),
			...(previewed && runPlan !== undefined ? { plan: runPlan } : {}),
		};
		const pending =
			request.format === "stream-json" && session === undefined && !previewed
				? serializeJsonLine({
						type: "session",
						schemaVersion: RUN_RESULT_SCHEMA_VERSION,
						mode: request.mode,
						pending: true,
						timestamp: startedAt,
						cwd: process.cwd(),
					})
				: "";
		return { lines: pending + (heldSteer ?? []).join("") + serializeJsonLine(envelope), exitCode: resolution.exitCode };
	};
	// `-o` is written once, by temp file and rename, only for a run that ends exit 0; any other end leaves no file.
	let outputSettled = false;
	const writeOutputTarget = (code: number): RunExitFact[] => {
		if (outputTarget === undefined || outputSettled || code !== 0) return [];
		outputSettled = true;
		// With --output-schema the file holds the validated JSON, the same bytes text mode prints (SPEC 6.8).
		return writeOutputFile(outputTarget, `${structuredNote?.json ?? seen.text}\n`)
			? []
			: [{ code: "output_write_failed", path: outputTarget }];
	};
	// A coordinated shutdown calls process.exit, which cannot await a flush or reach finish(): a successful run that
	// ends that way still writes `-o` here, and a failed write still moves the exit code to the envelope's.
	const onExit = (exitCode: number): void => {
		const extra = writeOutputTarget(exitCode);
		const out = envelopeLines(exitCode, extra);
		if (extra.length > 0) process.exitCode = out.exitCode;
		if (written || isStdoutDead()) return;
		written = true;
		writeSync(1, out.lines);
	};
	const finish = async (code: number): Promise<number> => {
		const extra = writeOutputTarget(code);
		const out = envelopeLines(code, extra);
		if (!written && !isStdoutDead()) {
			written = true;
			writeRawStdout(out.lines);
			await flushRawStdout();
		}
		return out.exitCode;
	};
	return runFailureState.run(state, async () => {
		if (request.outputLastMessage !== undefined) {
			const resolved = resolveOutputTarget({
				path: request.outputLastMessage,
				...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
			});
			if (!prepareOutputTarget(resolved)) return finish(2);
			outputTarget = resolved;
		}
		if (request.steerChannel !== undefined) {
			const base = request.cwd !== undefined ? path.resolve(request.cwd) : process.cwd();
			const channel = path.resolve(base, request.steerChannel);
			const refusal = steerChannelRefusal(channel);
			if (refusal !== undefined) {
				writeRunDiagnostic(`clio-coder run: --steer-channel cannot be opened: ${channel}: ${refusal}\n`);
				return finish(2);
			}
		}
		setFrameProjector((frame) => projectV1Frame(frame, seen, request.format));
		process.once("exit", onExit);
		try {
			return await finish(await run());
		} catch (error) {
			state.diagnostic = redactUrlCredentials(error instanceof Error ? error.message : String(error));
			await finish(1);
			throw error;
		} finally {
			process.off("exit", onExit);
			setFrameProjector(null);
			v2StreamJson = false;
		}
	});
}
