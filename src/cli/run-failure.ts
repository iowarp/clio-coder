import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { readClioVersion } from "../core/package-root.js";
import type { RunResult } from "../domains/dispatch/types.js";
import { CITATION_CHECK_PREFIX } from "../domains/safety/citation-check-prefix.js";
import { redactUrlCredentials } from "../domains/safety/redaction.js";
import type { ErrorSlug } from "./kit/slugs.js";
import { type TurnAnswerEntry, turnAnswer } from "./modes/answer-segments.js";
import { serializeJsonLine, setFrameProjector } from "./modes/jsonl.js";
import type {
	RunJsonDispatchedRunOutcome,
	RunJsonDispatchSettlementFrame,
	RunJsonFrame,
	RunJsonResultFrame,
	RunJsonRunEndFrame,
	RunJsonVerifyFrame,
	RunJsonVerifyResult,
} from "./modes/run-json-schema.js";
import {
	createToolCallIdMinter,
	RUN_RESULT_SCHEMA_VERSION,
	type RunCauseCode,
	type RunCompletionV2,
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

/**
 * The C17 slugs a refusal before any work names as its own v2 cause (SPEC C17, 6.2-6.9); any other slug, `usage`
 * included, reads `not_started`.
 */
const RUN_REFUSAL_SLUGS = [
	"unknown_flag",
	"flag_conflict",
	"empty_task",
	"task_file_conflict",
	"task_flag_conflict",
	"task_authority",
	"schema_unsupported",
	"not_configured",
	"session_live",
	"io",
] as const satisfies ReadonlyArray<ErrorSlug & RunCauseCode>;

export type RunRefusalSlug = (typeof RUN_REFUSAL_SLUGS)[number];

/** A refusal before work as its producer states it: the C17 slug and the diagnostic text. */
export interface RunRefusal {
	readonly slug: RunRefusalSlug;
	readonly message: string;
}

function isRunRefusalSlug(slug: ErrorSlug): slug is RunRefusalSlug {
	return (RUN_REFUSAL_SLUGS as ReadonlyArray<ErrorSlug>).includes(slug);
}

interface RunFailureState {
	pending: boolean;
	diagnostic?: string;
	/** The first refusal written with a slug of its own, as written; it names the exit-2 cause. */
	refusal?: RunRefusal;
}

const runFailureState = new AsyncLocalStorage<RunFailureState>();

/** Keep the first refusal that carries a narrower slug than `not_started`; later ones do not displace it. */
function noteRefusal(state: RunFailureState, slug: ErrorSlug | undefined, message: string): void {
	if (state.refusal === undefined && slug !== undefined && isRunRefusalSlug(slug)) state.refusal = { slug, message };
}

/**
 * Write a run diagnostic to stderr. `slug` is the C17 slug its producer gave it; written before run output starts,
 * a refusal slug becomes the exit-2 cause.
 */
export function writeRunDiagnostic(text: string, slug?: ErrorSlug): void {
	// A diagnostic can quote a failure's message, and it reaches stderr and a turn_end frame's error alike (#446).
	const shown = redactUrlCredentials(text);
	const state = runFailureState.getStore();
	if (state?.pending) {
		state.diagnostic = shown.trim();
		noteRefusal(state, slug, state.diagnostic);
	}
	process.stderr.write(shown);
}

/**
 * A refusal the main run makes after boot but before its turn (`--require-priced`): written like any diagnostic and
 * kept for the exit-2 cause even though run output has started.
 */
export function writeRunRefusal(text: string, slug: RunRefusalSlug): void {
	writeRunDiagnostic(text, slug);
	const state = runFailureState.getStore();
	if (state && !state.pending) noteRefusal(state, slug, redactUrlCredentials(text).trim());
}

/**
 * The cause of an exit-2 refusal before any work: the slug its producer gave it, or `not_started` for a refusal
 * with none narrower (`usage`, or no slug at all).
 */
export function startRefusalCause(refusal: { readonly slug?: ErrorSlug; readonly message: string } | undefined): {
	code: RunCauseCode;
	message?: string;
} {
	if (refusal?.slug === undefined || !isRunRefusalSlug(refusal.slug)) return { code: "not_started" };
	return { code: refusal.slug, message: refusal.message };
}

export function startRunOutput(): void {
	const state = runFailureState.getStore();
	if (state) state.pending = false;
}

/**
 * A text-mode run (no `--output-format json|stream-json`, whose writer is withRunResultV2): `-o` keeps v2's semantics
 * (SPEC 6.6, CLI-P14, CLI-P22) and leaves every byte text mode prints as it was written.
 */
export async function withRunFailureReporting(
	run: () => Promise<number>,
	output?: OutputLastMessageRequest,
	exitCodeFlag = false,
): Promise<number> {
	runCompletion = undefined;
	return output === undefined ? run() : withOutputLastMessage(output, run, exitCodeFlag);
}

/** The answer text mode printed on stdout, the validated structured JSON when there is one; `-o` holds it (CLI-P22). */
let textAnswer: string | undefined;

/** Hand the text-mode `-o` writer the answer just printed on stdout, without its closing newline. */
export function noteTextAnswer(text: string): void {
	textAnswer = text;
}

/**
 * SPEC 6.6 `-o` in text mode: the stale file goes at preflight, a missing directory is exit 2 before the run, and the
 * answer, what text mode printed, is written by temp file and rename only on exit 0; a failed write is exit 1.
 */
async function withOutputLastMessage(
	output: OutputLastMessageRequest,
	run: () => Promise<number>,
	exitCodeFlag: boolean,
): Promise<number> {
	const resolved = resolveOutputTarget(output);
	if (!prepareOutputTarget(resolved)) return 2;
	structuredNote = undefined;
	textAnswer = undefined;
	const answer = (): string => textAnswer ?? "";
	// CLI-P22: a coordinated shutdown ends a successful run with process.exit before run() returns, as under v2; the
	// file is still written then, synchronously, and a failed write still moves the exit code to 1. `--exit-code` decides
	// success on that path too: an unfinished completion leaves no file and exits 1.
	let settled = false;
	const settle = (code: number): boolean => {
		if (settled || code !== 0) return true;
		settled = true;
		return writeOutputFile(resolved, `${answer()}\n`);
	};
	const onExit = (rawExitCode: number): void => {
		const exitCode = completionExitCode(rawExitCode, exitCodeFlag);
		if (exitCode !== rawExitCode) process.exitCode = exitCode;
		if (settle(exitCode)) return;
		process.stderr.write(`clio-coder run: --output-last-message could not be written: ${resolved}\n`);
		process.exitCode = 1;
	};
	process.once("exit", onExit);
	let code: number;
	try {
		code = await run();
	} finally {
		process.off("exit", onExit);
	}
	if (settle(code)) return code;
	writeRunDiagnostic(`clio-coder run: --output-last-message could not be written: ${resolved}\n`);
	return 1;
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

/**
 * The run's answer (CLI-P43): the headless main agent's printed answer, else, for a `--agent` worker, the replies of
 * the `turn_end` frames it streamed. A `--agent` turn with no reply keeps its last text, which its text mode prints.
 */
function settledAnswer(seen: SeenFrames): string {
	const main = mainRunNote.answer?.();
	if (main !== undefined) return main;
	const answer = turnAnswer(seen.answerEntries);
	return answer.text.length > 0 ? answer.text : answer.narration;
}

/** What the headless main agent tells a v2 writer directly: facts no v1 frame carries. */
interface MainRunNoteV2 {
	runId?: string;
	parentSessionId?: string;
	usage?: RunUsageV2;
	sessionReadyMs?: number;
	/** Routes the run can reach whose cost `--max-cost-usd` cannot bound. */
	unpricedRoutes?: string[];
	/** The answer text mode prints, from the headless main agent's own turn entries (CLI-P43). */
	answer?: () => string;
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

/** Hand the v2 writer the structured-output verdict (main or `--agent`); a no-op shape for runs without the flag. */
export function noteStructuredV2(note: StructuredNoteV2): void {
	structuredNote = note;
}

let v2Started: number | null = null;
let v2StreamJson = false;
/** CLI-8: rewrites a stream-json frame's tool-call ids to Clio's; null outside a stream-json run. */
let toolCallIds: ((frame: object) => object) | null = null;
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

/** Every run the main agent dispatched, for the envelope's `dispatch.runs` (row 164); `--agent` lists its receipt instead. */
let dispatchedRuns: RunDispatchedRunV2[] = [];

function dispatchedRunV2(run: RunJsonDispatchedRunOutcome): RunDispatchedRunV2 {
	return {
		runId: run.runId,
		agentId: run.agentId,
		...(run.outcome !== null ? { outcome: run.outcome } : {}),
		...(run.outcomeCode !== null ? { outcomeCode: run.outcomeCode } : {}),
		...(run.outcomeDetail !== null ? { outcomeDetail: run.outcomeDetail } : {}),
	};
}

/** Hand the v2 writer the superseded dispatched failures; a no-op for v1 runs. */
export function noteDispatchSupersededV2(runs: ReadonlyArray<RunJsonDispatchedRunOutcome>): void {
	if (v2Started === null) return;
	supersededRuns = runs.map(dispatchedRunV2);
}

/** Hand the v2 writer every run the main agent dispatched, as they settled; a no-op for v1 runs. */
export function noteDispatchRunsV2(runs: ReadonlyArray<RunJsonDispatchedRunOutcome>): void {
	if (v2Started === null) return;
	dispatchedRuns = runs.map(dispatchedRunV2);
}
/** `--dry-run`: the plan the v2 envelope carries with outcome `previewed` (CLI-L4). */
let runPlan: Readonly<Record<string, unknown>> | undefined;

/** Hand the v2 writer a `--dry-run` plan; a no-op for v1 runs. */
export function noteRunPlan(plan: object): void {
	if (v2Started !== null) runPlan = { ...plan };
}

/**
 * The settled main run's completion (fleet design 4.3): the state the agent declared through `finish`, or `unknown`
 * with `declared: false` when it declared none. Absent until a main run settles.
 */
let runCompletion: RunCompletionV2 | undefined;

/** The settled main run hands over its completion; the envelope carries it and `--exit-code` reads it. */
export function noteRunCompletion(completion: RunCompletionV2): void {
	runCompletion = completion;
}

/** A `run --agent` run's completion from its sealed receipt (CLI-P58); the envelope carries it, `--exit-code` does not read it. */
let agentCompletion: RunCompletionV2 | undefined;

/** The settled `run --agent` run hands over its completion; a no-op for v1 runs. */
export function noteAgentRunCompletion(completion: RunCompletionV2): void {
	if (v2Started !== null) agentCompletion = completion;
}

/**
 * `run --exit-code` (SPEC C19, ruling 7): a run that ended 0 whose completion state (the host's assessment) is
 * `partly_done` or `not_done` exits 1; `done` and an undeclared run keep 0. Every other exit is unchanged, and without
 * the flag the exit is the run's own.
 */
export function completionExitCode(code: number, exitCodeFlag: boolean): number {
	const unfinished = runCompletion?.state === "partly_done" || runCompletion?.state === "not_done";
	return exitCodeFlag && code === 0 && unfinished ? 1 : code;
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
	answer?: () => string;
}): void {
	if (v2Started === null) return;
	if (note.answer !== undefined) mainRunNote.answer = note.answer;
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
	/** `--exit-code` (SPEC C19): a declared completion `partly_done` or `not_done` exits 1. */
	exitCode?: true;
}

/** What the v1 frames told the v2 writer; the run itself still speaks v1 underneath. */
interface SeenFrames {
	session?: { id?: string; target?: string; model?: string; runId?: string };
	/** The final user turn's settled assistant messages and citation checks, which give the answer (CLI-P43). */
	answerEntries: TurnAnswerEntry[];
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
const WORK_CODES: ReadonlyArray<RunCauseCode> = [
	"provider_error",
	"context_overflow",
	"no_answer",
	"output_limit",
	"noop",
	"limitation",
];

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
			const message = (frame as { message?: { role?: unknown } }).message;
			if (message?.role === "assistant") seen.answerEntries.push({ kind: "message", message });
			break;
		}
		case "notice": {
			const text = (frame as { text?: unknown }).text;
			if (typeof text === "string" && text.startsWith(CITATION_CHECK_PREFIX))
				seen.answerEntries.push({ kind: "citation_check" });
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
			const message = (
				frame as {
					message?: { role?: string; stopReason?: unknown; harnessStopped?: unknown; failure?: { stage?: unknown } };
				}
			).message;
			// A harness stop (a repetition guard, or the context guard's `failure.stage` "harness") is not the provider's (FX-22).
			if (message?.role === "assistant")
				seen.providerError =
					message.stopReason === "error" && message.harnessStopped !== true && message.failure?.stage !== "harness";
			// A user message starts the turn whose replies are the answer, unless it delivers a citation check (CLI-P43).
			if (message?.role === "user" && seen.answerEntries.at(-1)?.kind !== "citation_check") seen.answerEntries = [];
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
	return format === "json" ? null : (toolCallIds?.(frame) ?? frame);
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
			const refusal = startRefusalCause(state.refusal);
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
	const seen: SeenFrames = { answerEntries: [], live: [], undelivered: [] };
	v2Started = performance.now();
	v2StreamJson = request.format === "stream-json";
	toolCallIds = v2StreamJson ? createToolCallIdMinter() : null;
	heldSteer = [];
	mainRunNote = {};
	supersededRuns = [];
	dispatchedRuns = [];
	structuredNote = undefined;
	runPlan = undefined;
	runCompletion = undefined;
	agentCompletion = undefined;
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
		const exitCode = completionExitCode(resolution.exitCode, request.exitCode === true);
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
			exitCode,
			outcome: previewed ? "previewed" : resolution.outcome,
			...(resolution.causes[0] !== undefined ? { outcomeDetail: resolution.causes[0].code } : {}),
			causes: resolution.causes,
			...(runCompletion !== undefined
				? { completion: runCompletion }
				: agentCompletion !== undefined
					? { completion: agentCompletion }
					: {}),
			result: {
				text: settledAnswer(seen),
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
				runs: seen.receipt !== undefined ? [seen.receipt] : dispatchedRuns,
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
		return { lines: pending + (heldSteer ?? []).join("") + serializeJsonLine(envelope), exitCode };
	};
	// `-o` is written once, by temp file and rename, only for a run that ends exit 0; any other end leaves no file.
	let outputSettled = false;
	const writeOutputTarget = (code: number): RunExitFact[] => {
		if (outputTarget === undefined || outputSettled || code !== 0) return [];
		outputSettled = true;
		// With --output-schema the file holds the validated JSON, the same bytes text mode prints (SPEC 6.8).
		return writeOutputFile(outputTarget, `${structuredNote?.json ?? settledAnswer(seen)}\n`)
			? []
			: [{ code: "output_write_failed", path: outputTarget }];
	};
	// A coordinated shutdown calls process.exit, which cannot await a flush or reach finish(): a successful run that
	// ends that way still writes `-o` here. `--exit-code` decides success on this path too, and the process exits
	// with the envelope's code whenever that differs (an unfinished completion, or a failed write).
	const onExit = (exitCode: number): void => {
		const extra = writeOutputTarget(completionExitCode(exitCode, request.exitCode === true));
		const out = envelopeLines(exitCode, extra);
		if (out.exitCode !== exitCode) process.exitCode = out.exitCode;
		if (written || isStdoutDead()) return;
		written = true;
		writeSync(1, out.lines);
	};
	const finish = async (code: number): Promise<number> => {
		// `-o` is written only on success, and `--exit-code` decides success, so the mapping comes first.
		const extra = writeOutputTarget(completionExitCode(code, request.exitCode === true));
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
				writeRunDiagnostic(`clio-coder run: --steer-channel cannot be opened: ${channel}: ${refusal}\n`, "io");
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
			toolCallIds = null;
		}
	});
}
