import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { BackendCompletionTimings } from "../../core/cache-telemetry.js";
import type { ToolResultDigestProvenance } from "../../tools/result-disposition.js";
import {
	buildMemoryInterventionUserPrompt,
	MEMORY_INTERVENTION_SYSTEM_PROMPT,
} from "../prompts/memory-intervention.js";
import type { CostProvenance } from "../providers/index.js";
import type { BackgroundSkipReason } from "./background-budget.js";
import {
	renderTaskMemoryEntries,
	TASK_MEMORY_CONTENT_MAX_CHARS,
	type TaskMemoryBank,
	type TaskMemoryEntry,
	type TaskMemoryRenderableClass,
} from "./task-bank.js";
import { rejectReminder, rejectStoredContent, stripBoundaryControlTokens } from "./task-memory-output.js";

export const TASK_MEMORY_POLICY_MAX_OPERATIONS = 8;
/**
 * Fallback deadline for a caller that supplies no timeout, which is the
 * middleware constructed without settings and `runTaskMemoryPolicy` called
 * directly.
 *
 * This must equal the settings default in `src/core/defaults.ts`; a contract
 * test pins the pair. Two numbers for one setting means any path that misses
 * the settings object silently gets the one nobody chose.
 */
export const TASK_MEMORY_POLICY_DEFAULT_TIMEOUT_MS = 60_000;

export interface TaskMemoryTrajectoryStep {
	step: number;
	toolName: string;
	operationFingerprint: string;
	callDescription: string;
	outcome: "ok" | "error";
	resultDigest: string;
	resultDigestProvenance: ToolResultDigestProvenance;
}

/** Admission changed while a client prepared; no inference request was sent. */
export class TaskMemoryEndpointBusyError extends Error {}

/**
 * A foreground request claimed the shared endpoint slot this step held, so the
 * step's transport was aborted. The step yields and runs again once the
 * endpoint has room; it is neither a route failure nor a deadline.
 */
export class TaskMemoryEndpointPreemptedError extends Error {}

/** Restricted context cannot reach the selected background model. */
export class TaskMemoryInformationFlowBlockedError extends Error {}

/**
 * The background budget refused the step before any request left the process
 * (`decideBackgroundStep`). Occupancy refusals keep `TaskMemoryEndpointBusyError`,
 * so they still yield and resume when the endpoint has room.
 */
export class TaskMemoryBudgetSkipError extends Error {
	constructor(
		readonly reason: Exclude<BackgroundSkipReason, "endpoint_busy">,
		readonly resumeAt?: string,
	) {
		super(`background memory step skipped: ${reason}${resumeAt === undefined ? "" : ` until ${resumeAt}`}`);
	}
}

export interface TaskMemoryModelRequest {
	systemPrompt: string;
	userPrompt: string;
	maxTokens: number;
	signal: AbortSignal;
	/** Known usage may arrive even when completion rejects or the policy has been canceled. */
	onUsage?: (usage: TaskMemoryStepUsage) => void;
}

/**
 * What one memory step cost, as the client that made the call observed it.
 *
 * The policy never prices anything itself; it carries this from the client to
 * the composition root, which is the only layer that knows about the cost
 * ledger. Without it a memory step was billed by a provider and recorded
 * nowhere an operator could read: 137,205 tokens over 14 days appeared in no
 * `/cost` row and in no usage report (#229).
 */
export interface TaskMemoryStepUsage {
	/** Target the step ran against, used as the cost row's provider id. */
	targetId: string;
	attributedModelId: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
	missingTokenCalls?: number;
	costUsd: number;
	costProvenance: CostProvenance;
	/** Wall time of the model call itself, measured by the client. */
	durationMs: number;
	/** Backend prefill facts when the serving runtime reported them (#247). */
	backend: BackendCompletionTimings | null;
}

export interface TaskMemoryModelResponse {
	text: string;
	inputTokens?: number;
	outputTokens?: number;
	/** Provider-reported spend for this call. Absent on clients that report none. */
	usage?: TaskMemoryStepUsage;
}

/** The target and wire model a memory client is bound to, as resolved after any fallback. */
export interface TaskMemoryRoute {
	targetId: string;
	modelId: string;
}

export interface TaskMemoryModelClient {
	/** Absent on clients that do not know their route. Telemetry only; the policy never reads it. */
	readonly route?: TaskMemoryRoute;
	complete(input: TaskMemoryModelRequest): Promise<TaskMemoryModelResponse>;
}

export type TaskMemoryPolicyDecision = "silent" | "injected" | "gated" | "timeout" | "malformed";

/**
 * Why a step ended where it did.
 *
 * `decision` alone cannot be acted on. Six distinct situations resolve to a
 * null reminder, and they call for opposite responses: a route that refused the
 * connection needs the server started, a model that wrote `<no_intervention/>`
 * needs nothing at all, and an answer whose every operation named an invented
 * verb needs the prompt changed. A session that recorded four `silent` steps and
 * zero bank writes was indistinguishable from a healthy quiet one, which is how
 * a broken tier survived a whole session unnoticed.
 */
export type TaskMemoryPolicyReason =
	/** A cited reminder reached the visible channel. */
	| "intervened"
	/** The model answered and chose `<no_intervention/>` or wrote no phase two. */
	| "model_silent"
	/** The reminder repeated the one already on screen. */
	| "duplicate_reminder"
	/** The rules tier already spoke for this boundary; phase one still applied. */
	| "suppressed"
	/** A spontaneous reminder cited no bank entry. */
	| "uncited"
	/** A file named in the reminder no longer exists in the workspace. */
	| "invalid_path"
	/** A cited failed attempt has since succeeded in the observed trajectory. */
	| "resolved_failure"
	/** The reminder exceeded the token cap and was dropped rather than truncated. */
	| "over_budget"
	/**
	 * The reminder was not the single short line the prompt asks for: it held a
	 * chat-template token, JSON, deliberation, a foreign script or a repeated
	 * sentence. It is dropped whole, never shown and never injected.
	 */
	| "invalid_reminder"
	/** No envelope was found, or its operation list violated the grammar. */
	| "unparseable"
	/** Every operation named a verb the bank has no writer for. */
	| "all_operations_invalid"
	/** The request did not answer inside the policy timeout. */
	| "deadline"
	/**
	 * The transport hit its own deadline first and threw. Separated from
	 * `client_error` because a route that answers too slowly and a route that
	 * refuses the connection call for opposite responses, and separated from
	 * `deadline` because it says the abort came from the request rather than
	 * from the policy's race.
	 */
	| "timed_out"
	/**
	 * Known occupancy exhausts the endpoint request capacity, so no step starts.
	 * A shared gateway URL alone does not establish a one-slot capacity bound.
	 */
	| "endpoint_busy"
	/** A foreground request preempted the step's endpoint slot; it runs again when there is room. */
	| "endpoint_preempted"
	/** Session spend plus this step's projected cost would reach `safety.limits.sessionCostUsd`. */
	| "cost_ceiling"
	/** The subscription window the route bills against is at or past its warning level. */
	| "quota_window"
	/** The provider's usage endpoint answered 429 and its retry interval has not passed. */
	| "quota_retry"
	/** The endpoint's measured speed cannot finish this step inside `context.memory.timeoutMs`. */
	| "time_budget"
	/** The model client threw: unreachable route, auth failure, malformed request. */
	| "client_error"
	/** Information-flow admission refused the request before inference. */
	| "information_flow_blocked"
	/** No background role is configured, so the llm tier never ran. */
	| "no_client"
	/**
	 * Nothing in this process can consume a reminder, so no step was started. A
	 * headless run submits no further turn, and the step is detached from the
	 * boundary that triggered it, so the process exits before it can land.
	 */
	| "no_consumer"
	/** A step was already in flight, so this boundary's triggers stayed pending. */
	| "step_in_flight"
	/** Consecutive model deadlines degraded this session to the free rules tier. */
	| "llm_timeout_backoff"
	/** Rules tier: the turn ended with no repeated failure worth reporting. */
	| "no_repeated_failure"
	/** Rules tier: compaction reactivation found no knowledge entries to restore. */
	| "bank_empty"
	/** The owning session/branch generation was invalidated. */
	| "scope_changed";

/**
 * The model's own words for one step, handed to an observer before they are
 * discarded. Content-bearing by construction, so the composition root only wires
 * it when the operator asked for a trace.
 */
export interface TaskMemoryEnvelope {
	systemPrompt: string;
	userPrompt: string;
	/** Raw completion text, or empty when the call threw or timed out. */
	response: string;
	decision: TaskMemoryPolicyDecision;
	reason: TaskMemoryPolicyReason;
	bankOperations: number;
	droppedOperations: number;
	reminder: string | null;
	/**
	 * Client failure message, redacted of nothing because it never carries bank
	 * text. On an `invalid_reminder` step it names which check the reminder failed.
	 */
	error: string | null;
}

export interface TaskMemoryPolicyInput {
	/** Content authority, checked after inference and before any bank write. */
	isCurrent?: () => boolean;
	/** Cancellation releases policy bookkeeping even if the transport ignores abort. */
	signal?: AbortSignal;
	/** Reports actual provider usage, including responses arriving after cancellation/deadline. */
	onStepUsage?: (usage: TaskMemoryStepUsage) => void;
	task: string;
	trajectory: ReadonlyArray<TaskMemoryTrajectoryStep>;
	deterministicTrigger: boolean;
	maxTokens: number;
	/** Capability-derived completion budget; defaults to the visible reminder budget. */
	modelMaxTokens?: number;
	timeoutMs?: number;
	/** Phase one still applies; phase two is suppressed when another memory reminder already won this boundary. */
	suppressIntervention?: boolean;
	/** Last visible memory reminder, used to keep repeated model output silent. */
	previousReminder?: string | null;
	/** Workspace used to verify file references at delivery; defaults to the process workspace. */
	workspaceRoot?: string;
	/** Opt-in raw-envelope observer. Absent unless an operator turned tracing on. */
	onEnvelope?: (envelope: TaskMemoryEnvelope) => void;
	/**
	 * Run a single-purpose pass instead of the bank-maintenance step: its own
	 * system prompt over its own rendering of what happened. The answer uses the
	 * same envelope, so every parse and hygiene check still applies.
	 */
	pass?: {
		systemPrompt: string;
		trajectoryText: string;
		/**
		 * Durable lessons already kept for this repository, shown so the pass does
		 * not write them again under new wording. A `delete` naming one is reported
		 * in `retiredLessonIds` and never touches the bank.
		 */
		keptLessons?: ReadonlyArray<{ id: string; text: string }>;
		/** Rendering budget for `trajectoryText`; defaults to the maintenance trajectory budget. */
		trajectoryMaxChars?: number;
	};
}

export interface TaskMemoryPolicyResult {
	/** Admission diagnostic, present only when information flow refused the request. */
	refusalReason?: string;
	/** When a budget skip expects room again: a quota window reset or a 429 retry instant. */
	resumeAt?: string;
	decision: TaskMemoryPolicyDecision;
	reason: TaskMemoryPolicyReason;
	bankOperations: number;
	/** Operations the bank refused. Nonzero with `bankOperations` at zero is a total loss. */
	droppedOperations: number;
	reminder: string | null;
	inputTokens: number;
	outputTokens: number;
	/** Provider-reported spend, when the client reported any. Null on every path that made no call. */
	usage: TaskMemoryStepUsage | null;
	/** Kept lessons the pass asked to delete because the turn showed them wrong. */
	retiredLessonIds?: string[];
	/**
	 * The bank entries this call's prompt showed, as they read then. Empty when
	 * no prompt was built. It is the selection the prompt was rendered from, not
	 * a second rendering.
	 */
	presentedEntries: TaskMemoryEntry[];
}

type TaskMemoryOperation =
	| { op: "update_status"; content: string }
	| { op: "save_knowledge"; content: string; id?: string }
	| { op: "save_lesson"; content: string; id?: string; command?: string; source?: string; quote?: string }
	| { op: "save_procedural"; content: string; id?: string }
	| { op: "delete"; id: string };

interface ParsedMemoryStep {
	operations: TaskMemoryOperation[];
	context: string | null;
	/** Why a phase-two reminder was refused, or null when it was accepted or absent. */
	contextRejection: string | null;
}

interface ReadContextResult {
	context: string | null;
	rejection: string | null;
}

interface ReadOperationsResult {
	operations: TaskMemoryOperation[];
	/** Entries named an op the bank has no verb for; kept only to detect a total loss. */
	dropped: number;
}

const TASK_PROMPT_MAX_CHARS = 2_000;
const TRAJECTORY_PROMPT_MAX_CHARS = 4_000;

/**
 * Render the trajectory as JSON that parses, dropping whole steps to fit.
 *
 * Slicing the serialized string cut it mid-token, so a window at the documented
 * per-field maxima reached the model as JSON ending in an unterminated string.
 * That corrupts the only input the model reasons over, and it does so precisely
 * on the busiest windows. The oldest steps go first: the newest are the ones a
 * memory step is being asked about.
 */
function renderTrajectory(trajectory: TaskMemoryPolicyInput["trajectory"]): string {
	let steps = [...trajectory];
	let rendered = JSON.stringify(steps);
	while (rendered.length > TRAJECTORY_PROMPT_MAX_CHARS && steps.length > 1) {
		steps = steps.slice(1);
		rendered = JSON.stringify(steps);
	}
	// A single step can still exceed the budget on its own. Truncating its fields
	// keeps the envelope parseable where truncating the JSON would not.
	if (rendered.length > TRAJECTORY_PROMPT_MAX_CHARS && steps.length === 1) {
		const only = steps[0];
		if (only !== undefined) {
			const room = Math.max(0, TRAJECTORY_PROMPT_MAX_CHARS - JSON.stringify([{ ...only, resultDigest: "" }]).length);
			rendered = JSON.stringify([{ ...only, resultDigest: only.resultDigest.slice(0, room) }]);
		}
	}
	return rendered;
}

export async function runTaskMemoryPolicy(
	bank: TaskMemoryBank,
	client: TaskMemoryModelClient,
	input: TaskMemoryPolicyInput,
): Promise<TaskMemoryPolicyResult> {
	const controller = new AbortController();
	const timeoutMs = positiveInteger(input.timeoutMs, TASK_MEMORY_POLICY_DEFAULT_TIMEOUT_MS);
	const timeoutMarker = Symbol("task-memory-timeout");
	let timer: NodeJS.Timeout | undefined;
	const cancelledMarker = Symbol("task-memory-cancelled");
	let cancel: () => void = () => {};
	const cancelled = new Promise<typeof cancelledMarker>((resolve) => {
		cancel = () => {
			controller.abort();
			resolve(cancelledMarker);
		};
	});
	input.signal?.addEventListener("abort", cancel, { once: true });
	if (input.signal?.aborted) cancel();
	let userPrompt = "";
	let rawResponse = "";
	let clientError: string | null = null;
	let stepUsage: TaskMemoryStepUsage | null = null;
	let presentedEntries: TaskMemoryEntry[] = [];
	let usageReported = false;
	const reportUsage = (usage: TaskMemoryStepUsage): void => {
		if (usageReported) return;
		usageReported = true;
		stepUsage = usage;
		try {
			input.onStepUsage?.(usage);
		} catch {
			/* Accounting cannot steer content. */
		}
	};
	// Every exit reports through here so the trace sees the same envelope the
	// telemetry row summarizes, including the paths that used to throw away both.
	const settle = (
		decision: TaskMemoryPolicyDecision,
		reason: TaskMemoryPolicyReason,
		parts: Partial<Omit<TaskMemoryPolicyResult, "decision" | "reason">> = {},
	): TaskMemoryPolicyResult => {
		const result: TaskMemoryPolicyResult = {
			decision,
			reason,
			bankOperations: parts.bankOperations ?? 0,
			droppedOperations: parts.droppedOperations ?? 0,
			reminder: parts.reminder ?? null,
			inputTokens: parts.inputTokens ?? stepUsage?.input ?? 0,
			outputTokens: parts.outputTokens ?? stepUsage?.output ?? 0,
			usage: stepUsage,
			...(parts.refusalReason === undefined ? {} : { refusalReason: parts.refusalReason }),
			...(parts.resumeAt === undefined ? {} : { resumeAt: parts.resumeAt }),
			...(parts.retiredLessonIds === undefined ? {} : { retiredLessonIds: parts.retiredLessonIds }),
			presentedEntries,
		};
		try {
			if (input.isCurrent?.() !== false)
				input.onEnvelope?.({
					systemPrompt: input.pass?.systemPrompt ?? MEMORY_INTERVENTION_SYSTEM_PROMPT,
					userPrompt,
					response: rawResponse,
					decision,
					reason,
					bankOperations: result.bankOperations,
					droppedOperations: result.droppedOperations,
					reminder: result.reminder,
					error: clientError,
				});
		} catch {
			// A failing observer is an operator's diagnostic, never the policy's problem.
		}
		return result;
	};
	try {
		if (input.signal?.aborted || input.isCurrent?.() === false) return settle("silent", "scope_changed");
		const keptLessons = input.pass?.keptLessons ?? [];
		presentedEntries = bank.select(input.maxTokens);
		userPrompt = buildMemoryInterventionUserPrompt({
			task: input.task.slice(0, TASK_PROMPT_MAX_CHARS),
			bank: [
				renderTaskMemoryEntries(presentedEntries),
				...(keptLessons.length === 0
					? []
					: ["", "Lessons already kept for this repository:", ...keptLessons.map((item) => `- [${item.id}] ${item.text}`)]),
			].join("\n"),
			trajectory:
				input.pass?.trajectoryText.slice(0, positiveInteger(input.pass.trajectoryMaxChars, TRAJECTORY_PROMPT_MAX_CHARS)) ??
				renderTrajectory(input.trajectory),
		});
		const completion = client
			.complete({
				systemPrompt: input.pass?.systemPrompt ?? MEMORY_INTERVENTION_SYSTEM_PROMPT,
				userPrompt,
				maxTokens: positiveInteger(input.modelMaxTokens, input.maxTokens),
				signal: controller.signal,
				onUsage: reportUsage,
			})
			.then((response) => {
				if (response.usage !== undefined) reportUsage(response.usage);
				return response;
			});
		const timeout = new Promise<typeof timeoutMarker>((resolve) => {
			timer = setTimeout(() => resolve(timeoutMarker), timeoutMs);
		});
		const response = await Promise.race([completion, timeout, cancelled]);
		if (response === cancelledMarker) return settle("silent", "scope_changed");
		if (response === timeoutMarker) {
			controller.abort();
			void completion.catch(() => undefined);
			return settle("timeout", "deadline");
		}
		rawResponse = typeof response.text === "string" ? response.text : "";
		stepUsage = response.usage ?? stepUsage;
		const usage = {
			inputTokens: nonNegativeInteger(response.inputTokens ?? stepUsage?.input),
			outputTokens: nonNegativeInteger(response.outputTokens ?? stepUsage?.output),
		};
		if (input.signal?.aborted || input.isCurrent?.() === false) return settle("silent", "scope_changed", usage);
		const read = readPolicyStep(
			rawResponse,
			userPrompt,
			input.pass === undefined ? MAINTENANCE_OPERATIONS : LESSON_PASS_OPERATIONS,
		);
		if (!read.ok) return settle("malformed", read.reason, { ...usage, droppedOperations: read.dropped });
		const priorKnowledge = new Map(bank.snapshot().knowledge.map((entry) => [entry.id, entry.content]));
		const keptIds = new Set(keptLessons.map((item) => item.id));
		const retiredLessonIds = read.step.operations.flatMap((operation) =>
			operation.op === "delete" && keptIds.has(operation.id) ? [operation.id] : [],
		);
		// The lesson pass may delete lessons and nothing else: a kept durable one is
		// reported for retirement, a bank lesson is removed, and any other id is
		// left alone and counted as dropped below.
		const bankLessonIds = new Set(
			bank
				.snapshot()
				.knowledge.filter((entry) => entry.durable === true)
				.map((entry) => entry.id),
		);
		const operations = resolveOperations(
			bank,
			read.step.operations.filter(
				(operation) =>
					operation.op !== "delete" ||
					(!keptIds.has(operation.id) && (input.pass === undefined || bankLessonIds.has(operation.id))),
			),
		);
		applyOperations(bank, operations);
		// A model's operation is dropped either by the grammar, which does not know
		// the verb, or by identity repair, which could not resolve a delete target.
		// Both are model output the bank refused, so both belong in one count.
		const counts = {
			...usage,
			bankOperations: operations.length,
			droppedOperations: read.dropped + (read.step.operations.length - retiredLessonIds.length - operations.length),
			...(retiredLessonIds.length === 0 ? {} : { retiredLessonIds }),
		};
		if (read.step.contextRejection !== null) {
			// A bad completion is a diagnostic for the operator who traces memory, not
			// a card. Phase one already applied; only the reminder is lost.
			clientError = `reminder rejected: ${read.step.contextRejection}`;
			return settle("gated", "invalid_reminder", counts);
		}
		if (read.step.context === null) return settle("silent", "model_silent", counts);
		// An over-budget reminder is a phase-two policy violation, not a parse
		// failure. Truncating it would strip the citation that earns it a voice, so
		// the reminder is suppressed while phase one stays applied.
		const reminder = withMemoryPrefix(read.step.context, input.maxTokens);
		if (reminder.length === 0) return settle("gated", "over_budget", counts);
		if (input.suppressIntervention === true) return settle("silent", "suppressed", counts);
		if (reminder === input.previousReminder) return settle("silent", "duplicate_reminder", counts);
		const citedIds = citedRenderableEntryIds(bank, reminder);
		if (!input.deterministicTrigger && citedIds.length === 0) return settle("gated", "uncited", counts);
		if (citesResolvedFailure(bank, citedIds, input.trajectory)) return settle("gated", "resolved_failure", counts);
		const restoresKnownFact = bank
			.snapshot()
			.knowledge.some((entry) => citedIds.includes(entry.id) && priorKnowledge.get(entry.id) === entry.content);
		if (
			input.trajectory.some((step) => step.outcome === "error") &&
			!hasFailureLesson(input.trajectory) &&
			!restoresKnownFact
		)
			return settle("gated", "no_repeated_failure", counts);
		if (!hasCurrentWorkspacePaths(reminder, input.workspaceRoot ?? process.cwd()))
			return settle("gated", "invalid_path", counts);
		bank.recordInjection(citedIds);
		return settle("injected", "intervened", { ...counts, reminder });
	} catch (error) {
		if (error instanceof TaskMemoryEndpointBusyError) return settle("silent", "endpoint_busy");
		if (error instanceof TaskMemoryEndpointPreemptedError) return settle("silent", "endpoint_preempted");
		if (error instanceof TaskMemoryBudgetSkipError)
			return settle("silent", error.reason, error.resumeAt === undefined ? {} : { resumeAt: error.resumeAt });
		clientError = errorMessage(error);
		if (error instanceof TaskMemoryInformationFlowBlockedError)
			return settle("silent", "information_flow_blocked", { refusalReason: clientError });
		// A transport that aborted at its own deadline spent the whole budget and
		// produced nothing. Reporting it as silence made a step that held a local
		// server for its full timeout indistinguishable from a model that read the
		// trajectory and decided there was nothing to say (#229).
		if (isTimeoutError(error)) return settle("timeout", "timed_out");
		return settle("silent", "client_error");
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		input.signal?.removeEventListener("abort", cancel);
	}
}

/** The four verbs the maintenance prompt documents. A lesson is not one of them. */
const MAINTENANCE_OPERATIONS: ReadonlySet<TaskMemoryOperation["op"]> = new Set([
	"update_status",
	"save_knowledge",
	"save_procedural",
	"delete",
]);
/** The two verbs the turn-end lesson pass documents. */
/** A quote shorter than this matches too much source to bind a fact to a location. */
const LESSON_QUOTE_MIN_CHARS = 12;

const LESSON_PASS_OPERATIONS: ReadonlySet<TaskMemoryOperation["op"]> = new Set(["save_lesson", "delete"]);

const OPERATIONS_OPEN = "<operations>";
const OPERATIONS_CLOSE = "</operations>";
const CONTEXT_OPEN = "<context_for_action>";
const CONTEXT_CLOSE = "</context_for_action>";

/**
 * Small local models rarely emit a byte-exact envelope: they wrap it in a
 * markdown fence, prepend a reasoning block, or add a closing sentence. None of
 * that changes what they decided, so the envelope is located rather than
 * matched, and anything outside it is discarded.
 */
function cleanPolicyResponse(raw: string): string {
	return (
		raw
			.replace(/<(think|thinking|reasoning|scratchpad)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
			// An unterminated reasoning block means the output budget ran out mid-thought;
			// nothing after it is trustworthy, and nothing before it is an envelope.
			.replace(/<(think|thinking|reasoning|scratchpad)\b[^>]*>[\s\S]*$/iu, " ")
			.replace(/^[^\S\n]*```[^\n]*$/gmu, " ")
			.trim()
	);
}

/**
 * Reminder text rides inside a `<system-reminder>` block on the next user turn.
 * Tag-shaped output from the memory model must not be able to close that block
 * early, so tag shapes are dropped while comparisons and arrows survive.
 */
function stripTagShapes(value: string): string {
	return value.replace(/<\/?[a-zA-Z][^>]*>/gu, " ");
}

/**
 * Find where the operation list ends, by reading the JSON array rather than by
 * searching for the close tag.
 *
 * An operation's content is free text, and a session working on the memory tier
 * writes this envelope's own grammar into it. `indexOf` then finds a close tag
 * that sits inside a JSON string and hands `JSON.parse` a truncated document, so
 * a correct answer is discarded as unparseable. `lastIndexOf` fails the mirror
 * case, where a reminder quotes the tag again after the list has closed. The
 * array's own bracket depth is the only boundary that both cases agree on.
 *
 * Returns the index just past the array's closing bracket, or -1 when the text
 * holds no balanced array.
 */
function operationsEndIndex(text: string, from: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	let started = false;
	for (let index = from; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "[" || char === "{") {
			depth += 1;
			started = true;
			continue;
		}
		if (char === "]" || char === "}") {
			depth -= 1;
			if (depth < 0) return -1;
			if (depth === 0 && started) return index + 1;
			continue;
		}
		// Anything before the array opens that is not whitespace means the model
		// wrote something other than an operation list.
		if (!started && char !== undefined && char.trim().length > 0) return -1;
	}
	return -1;
}

type ReadPolicyStepResult =
	| { ok: true; step: ParsedMemoryStep; dropped: number }
	| { ok: false; reason: "unparseable" | "all_operations_invalid"; dropped: number };

/**
 * The rejecting variant of the parser. It separates "the model produced no
 * envelope" from "the model produced an envelope whose every operation named a
 * verb the bank does not have", because those two point at different fixes and
 * the boolean form of this function could not tell them apart.
 */
function readPolicyStep(
	response: string,
	reference: string,
	allowed: ReadonlySet<TaskMemoryOperation["op"]>,
): ReadPolicyStepResult {
	const unparseable = { ok: false, reason: "unparseable", dropped: 0 } as const;
	if (typeof response !== "string" || response.length === 0) return unparseable;
	const text = stripBoundaryControlTokens(cleanPolicyResponse(response));
	const opensAt = text.indexOf(OPERATIONS_OPEN);
	if (opensAt === -1) return unparseable;
	const listAt = opensAt + OPERATIONS_OPEN.length;
	const listEndsAt = operationsEndIndex(text, listAt);
	if (listEndsAt === -1) return unparseable;
	// The close tag is still required. A model that wrote no list at all never
	// reaches here, and one that wrote a list but no close tag did not produce
	// the envelope the prompt asks for.
	const closesAt = text.indexOf(OPERATIONS_CLOSE, listEndsAt);
	if (closesAt === -1) return unparseable;
	let rawOperations: unknown;
	try {
		rawOperations = JSON.parse(text.slice(listAt, listEndsAt)) as unknown;
	} catch {
		return unparseable;
	}
	const read = readOperations(rawOperations, reference, allowed);
	if (read === null) return unparseable;
	// Recovering nothing is not silence. A step whose every operation was invented
	// stays malformed so the operator can see the model answered in a shape the
	// bank could not use.
	if (read.operations.length === 0 && read.dropped > 0) {
		return { ok: false, reason: "all_operations_invalid", dropped: read.dropped };
	}
	const context = readContext(text.slice(closesAt + OPERATIONS_CLOSE.length), reference);
	return {
		ok: true,
		step: { operations: read.operations, context: context.context, contextRejection: context.rejection },
		dropped: read.dropped,
	};
}

/**
 * Phase two after the operation list. Explicit silence, a missing decision, and
 * an empty reminder all resolve to silence: the prompt's documented default is
 * `<no_intervention/>`, so an incomplete envelope must never manufacture an
 * intervention out of a model that simply stopped writing.
 */
function readContext(tail: string, reference: string): ReadContextResult {
	const none = { context: null, rejection: null };
	const contextAt = tail.indexOf(CONTEXT_OPEN);
	const silenceAt = tail.search(/<no_intervention\s*\/?>/u);
	if (contextAt === -1) return none;
	if (silenceAt !== -1 && silenceAt < contextAt) return none;
	const body = tail.slice(contextAt + CONTEXT_OPEN.length);
	// The first close tag ends the reminder. Text after it is whatever the model
	// kept writing, and a reminder with no close tag was cut off mid-thought.
	const closesAt = body.indexOf(CONTEXT_CLOSE);
	if (closesAt === -1) return { context: null, rejection: "no closing tag, so the completion was cut off" };
	const raw = body.slice(0, closesAt);
	const context = stripTagShapes(raw).replace(/\s+/gu, " ").trim();
	if (context.length === 0) return none;
	const rejection = rejectReminder(raw, context, reference);
	return rejection === null ? { context, rejection: null } : { context: null, rejection };
}

/**
 * Structural violations still reject the batch, because they say the model did
 * not produce an operation list at all. An unrecognized `op` says only that one
 * entry named a verb the bank does not have, and a small model handed a tool
 * trajectory routinely borrows that trajectory's shape for exactly one entry.
 * Dropping it costs one operation, which is the same trade `resolveOperations`
 * already makes for an invented entry id.
 */
function readOperations(
	value: unknown,
	reference: string,
	allowed: ReadonlySet<TaskMemoryOperation["op"]>,
): ReadOperationsResult | null {
	if (!Array.isArray(value) || value.length > TASK_MEMORY_POLICY_MAX_OPERATIONS) return null;
	const operations: TaskMemoryOperation[] = [];
	let dropped = 0;
	for (const raw of value) {
		if (!isRecord(raw) || typeof raw.op !== "string") return null;
		// A verb this pass was not offered is dropped before anything applies it,
		// exactly like a verb the bank has never had.
		if (!(allowed as ReadonlySet<string>).has(raw.op)) {
			dropped += 1;
			continue;
		}
		switch (raw.op) {
			case "update_status": {
				if (!hasExactKeys(raw, ["op", "content"])) return null;
				const content = boundedContent(raw.content);
				if (content === null) return null;
				if (rejectStoredContent(content, reference) !== null) {
					dropped += 1;
					break;
				}
				operations.push({ op: raw.op, content });
				break;
			}
			case "save_lesson": {
				const keys = [
					"op",
					"content",
					...(raw.id === undefined ? [] : ["id"]),
					...(raw.command === undefined ? [] : ["command"]),
					...(raw.source === undefined ? [] : ["source"]),
					...(raw.quote === undefined ? [] : ["quote"]),
				];
				if (!hasExactKeys(raw, keys)) return null;
				// A source citation is a path and the exact text quoted from it, together.
				if ((raw.source === undefined) !== (raw.quote === undefined)) return null;
				if (
					raw.source !== undefined &&
					(typeof raw.source !== "string" ||
						raw.source.length === 0 ||
						raw.source.length > 300 ||
						typeof raw.quote !== "string" ||
						raw.quote.trim().length < LESSON_QUOTE_MIN_CHARS ||
						raw.quote.length > 240)
				)
					return null;
				const content = boundedContent(raw.content);
				if (content === null) return null;
				if (raw.id !== undefined && !nonEmptyString(raw.id)) return null;
				if (raw.command !== undefined && (typeof raw.command !== "string" || raw.command.length > 600)) return null;
				if (rejectStoredContent(content, reference) !== null) {
					dropped += 1;
					break;
				}
				const operation: Extract<TaskMemoryOperation, { op: "save_lesson" }> = { op: raw.op, content };
				if (typeof raw.id === "string") operation.id = raw.id;
				// Kept byte for byte: the host compares it for equality with a command it ran.
				if (typeof raw.command === "string" && raw.command.trim().length > 0) operation.command = raw.command;
				if (typeof raw.source === "string" && typeof raw.quote === "string") {
					operation.source = raw.source;
					operation.quote = raw.quote;
				}
				operations.push(operation);
				break;
			}
			case "save_knowledge":
			case "save_procedural": {
				if (!hasExactKeys(raw, raw.id === undefined ? ["op", "content"] : ["op", "content", "id"])) return null;
				const content = boundedContent(raw.content);
				if (content === null) return null;
				if (raw.id !== undefined && !nonEmptyString(raw.id)) return null;
				if (rejectStoredContent(content, reference) !== null) {
					dropped += 1;
					break;
				}
				const operation: Extract<TaskMemoryOperation, { op: typeof raw.op }> = { op: raw.op, content };
				if (typeof raw.id === "string") operation.id = raw.id;
				operations.push(operation);
				break;
			}
			case "delete":
				if (!hasExactKeys(raw, ["op", "id"]) || !nonEmptyString(raw.id)) return null;
				operations.push({ op: raw.op, id: raw.id });
				break;
			default:
				dropped += 1;
				break;
		}
	}
	return { operations, dropped };
}

/**
 * Reconcile a model's operation list against the bank it actually has.
 *
 * Small local models routinely invent plausible-looking entry ids for content
 * they mean to record for the first time. Rejecting the whole batch over one
 * such id throws away the writes that were the point of the step, so an
 * unresolvable save id is treated as a new entry and an unresolvable delete is
 * dropped. Structural violations are still rejected wholesale, upstream in
 * `readOperations`; this stage only repairs identity.
 */
function resolveOperations(
	bank: TaskMemoryBank,
	operations: ReadonlyArray<TaskMemoryOperation>,
): TaskMemoryOperation[] {
	const snapshot = bank.snapshot();
	const classes = new Map<string, "status" | TaskMemoryRenderableClass>();
	if (snapshot.status !== null) classes.set(snapshot.status.id, "status");
	for (const entry of snapshot.knowledge) classes.set(entry.id, "knowledge");
	for (const entry of snapshot.procedural) classes.set(entry.id, "procedural");
	const resolved: TaskMemoryOperation[] = [];
	for (const operation of operations) {
		switch (operation.op) {
			case "update_status":
				resolved.push(operation);
				break;
			case "save_knowledge":
			case "save_lesson":
			case "save_procedural": {
				const expected = operation.op === "save_procedural" ? "procedural" : "knowledge";
				if (operation.id !== undefined && classes.get(operation.id) === expected) {
					resolved.push(operation);
					break;
				}
				// An id naming nothing, or an entry in the other class, is not an
				// update the bank can honor. The content still deserves a home.
				if (operation.op === "save_lesson") {
					// Drop only the unresolvable id; the evidence claims travel with the content.
					const { id: _id, ...lesson } = operation;
					resolved.push(lesson);
				} else resolved.push({ op: operation.op, content: operation.content });
				break;
			}
			case "delete":
				if (classes.delete(operation.id)) resolved.push(operation);
				break;
		}
	}
	return resolved;
}

function applyOperations(bank: TaskMemoryBank, operations: ReadonlyArray<TaskMemoryOperation>): void {
	for (const operation of operations) {
		switch (operation.op) {
			case "update_status":
				bank.updateStatus(operation.content);
				break;
			case "save_knowledge":
				bank.saveKnowledge(operation.content, operation.id === undefined ? {} : { id: operation.id });
				break;
			case "save_lesson":
				bank.saveKnowledge(operation.content, {
					durable: true,
					...(operation.id === undefined ? {} : { id: operation.id }),
					...(operation.command === undefined ? {} : { evidenceCommand: operation.command }),
					...(operation.source === undefined || operation.quote === undefined
						? {}
						: { evidenceSource: { path: operation.source, quote: operation.quote } }),
				});
				break;
			case "save_procedural":
				bank.saveProcedural(operation.content, operation.id === undefined ? {} : { id: operation.id });
				break;
			case "delete":
				bank.deleteEntry(operation.id);
				break;
		}
	}
}

function citedRenderableEntryIds(bank: TaskMemoryBank, reminder: string): string[] {
	const snapshot = bank.snapshot();
	return [...snapshot.knowledge, ...snapshot.procedural]
		.map((entry) => entry.id)
		.filter((id) => reminder.includes(`[${id}]`));
}

function hasFailureLesson(trajectory: TaskMemoryPolicyInput["trajectory"]): boolean {
	const episodes = new Map<string, TaskMemoryTrajectoryStep[]>();
	for (const step of trajectory) {
		// Guessed file paths are exploration, not operator lessons.
		if (step.toolName === "read" && /ENOENT|no such file|not found/iu.test(step.resultDigest)) continue;
		const steps = episodes.get(step.operationFingerprint) ?? [];
		steps.push(step);
		episodes.set(step.operationFingerprint, steps);
	}
	return [...episodes.values()].some((steps) => steps.length >= 2 && steps.some((step) => step.outcome === "error"));
}

function citesResolvedFailure(
	bank: TaskMemoryBank,
	citedIds: ReadonlyArray<string>,
	trajectory: TaskMemoryPolicyInput["trajectory"],
): boolean {
	const cited = new Set(citedIds);
	for (const entry of bank.snapshot().procedural) {
		if (!cited.has(entry.id)) continue;
		const latest = [...trajectory].reverse().find((step) => entry.content.startsWith(`${step.callDescription} failed`));
		if (latest?.outcome === "ok") return true;
	}
	return false;
}

/**
 * Check only recognizable file references. Natural language, commands and bank
 * citations are not paths. A missing reference drops the whole reminder: editing
 * model text could detach its citation from the claim it supported.
 */
function hasCurrentWorkspacePaths(reminder: string, workspaceRoot: string): boolean {
	const root = resolve(workspaceRoot);
	const references = reminder.matchAll(
		/(?:^|[\s([`"'=])((?:\/|\.{1,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,11})(?=$|[\s)\]`"',;:!?])/gu,
	);
	let checked = 0;
	for (const match of references) {
		const path = match[1];
		if (path === undefined) continue;
		if (++checked > 16 || path.length > 320) return false;
		const target = resolve(root, path);
		const within = relative(root, target);
		// References outside this workspace have no local freshness guarantee.
		if (within === ".." || within.startsWith("../") || isAbsolute(within)) continue;
		try {
			if (!existsSync(target)) return false;
		} catch {
			return false;
		}
	}
	return true;
}

function withMemoryPrefix(content: string, maxTokens: number): string {
	const prefixed = content.startsWith("Memory:") ? content : `Memory: ${content}`;
	const maxChars = Math.max(0, maxTokens) * 4;
	return prefixed.length <= maxChars ? prefixed : "";
}

function boundedContent(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.replace(/\s+/gu, " ").trim();
	return normalized.length > 0 && normalized.length <= TASK_MEMORY_CONTENT_MAX_CHARS ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: ReadonlyArray<string>): boolean {
	const keys = Object.keys(record).sort();
	return keys.length === expected.length && [...expected].sort().every((key, index) => keys[index] === key);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: number | undefined): number {
	return value !== undefined && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Whether a client failure was the deadline rather than the route.
 *
 * The engine surfaces an aborted or timed-out completion as a plain `Error`
 * carrying the provider's message, so the name and the text are all there is to
 * read. Both spellings appear: pi-ai raises `AbortError` when the policy's own
 * signal fires, and the completion wrapper raises `model completion aborted`
 * when its `timeoutMs` fires first.
 */
function isTimeoutError(error: unknown): boolean {
	const name = error instanceof Error ? error.name : "";
	if (name === "AbortError" || name === "TimeoutError") return true;
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return /\b(abort(ed)?|timed out|timeout)\b/iu.test(message);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message.length > 0 ? error.message : error.name;
	return typeof error === "string" && error.length > 0 ? error : "an unknown client failure";
}
