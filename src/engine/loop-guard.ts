/**
 * Unified loop guard, packaged as a middleware hook registration.
 *
 * Both the orchestrator and worker registries register this single module on
 * `before_tool`, so there is exactly one observation seam and no double-count
 * hazard from separate interactive and worker guards. The registry feeds it
 * every tool-call attempt, including safety-blocked ones, via
 * `metadata.callFingerprint`.
 *
 * Parameterization covers both deployments: the orchestrator passes a bus
 * (LoopBlocked visibility) and the per-turn block budget; workers pass the
 * hard tool-call cap so a degenerate model cannot burn through a run by
 * spamming distinct calls. Operator visibility flows over the event bus only;
 * nothing here imports TUI code.
 */

import {
	BusChannels,
	type LoopBlockedDisposition,
	type LoopBlockedPayload,
	type ToolBudgetExceededPayload,
} from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import {
	GUARDRAIL_DEFAULTS,
	resolveGuardrail,
	workerSynthesisReserveBlockReason,
	workerSynthesisReserveDirective,
	workerToolCallCapExceededReason,
	workerToolCallCapSynthesisReason,
} from "../core/guardrails.js";
import { ToolNames } from "../core/tool-names.js";
import type { AgentProduct } from "../domains/agents/spec.js";
import type { MiddlewareHookRegistration } from "../domains/middleware/runtime.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "../domains/middleware/types.js";
import type { SafetyContract } from "../domains/safety/contract.js";
import { hashToolCall } from "../domains/safety/loop-detector.js";
import type { AgentMessage } from "./types.js";

export const LOOP_GUARD_REGISTRATION_ID = "guard.loop";

/**
 * Loop blocks tolerated per user turn before the turn is interrupted. Combined
 * with the detector's identical-call threshold, a runaway turn is bounded to a
 * few verbatim repeats (threshold-1 free calls plus this many blocked retries)
 * rather than spinning for tens of seconds before the stop lands.
 */
export const INTERACTIVE_LOOP_BLOCK_BUDGET = 2;

/** One loop block tolerated per this many admitted calls in a worker run. */
const WORKER_LOOP_BLOCK_CALLS_PER_BLOCK = 10;

/**
 * Loop blocks a worker run tolerates before it is locked to synthesis.
 *
 * A worker has no turns: it never sets a turnId, so every block it collects
 * lands in one bucket that lives for the whole run. Measuring that run-long
 * count against the interactive per-turn budget made the second verbatim
 * spiral anywhere in a ninety-call editing pass end the run, which is a
 * verdict about run length rather than about degeneracy. The detector still
 * blocks each spiral on the spot; this is the separate judgment that the run
 * as a whole is not converging, so it scales with how long the run is allowed
 * to be. The interactive budget stays the floor, so a short worker keeps
 * exactly the bound it has today.
 */
export function workerLoopBlockBudget(toolCalls: number): number {
	if (!Number.isSafeInteger(toolCalls) || toolCalls <= 0) return INTERACTIVE_LOOP_BLOCK_BUDGET;
	return Math.max(INTERACTIVE_LOOP_BLOCK_BUDGET, Math.ceil(toolCalls / WORKER_LOOP_BLOCK_CALLS_PER_BLOCK));
}

/**
 * Post-lockout tool calls tolerated before the synthesis lockout falls back to
 * a hard turn stop. Once a turn reaches its loop-block budget the guard locks
 * tools for the rest of the turn and tells the model to answer from what it
 * gathered; a model that keeps calling tools instead of answering is stopped
 * after this many further denials so a degenerate model cannot spin forever.
 */
export const LOOP_SYNTHESIS_BACKSTOP_DENIALS = 2;

/**
 * Floor for the run-level denial budget, sized to cover one wide parallel
 * batch. The budget is otherwise the run's own tool-call cap, and a run whose
 * cap is tiny must still be able to steer a full batch of siblings rather than
 * die on it: the per-round bounds exist precisely so a wide batch gets one
 * synthesis round instead of a kill.
 */
export const WIDE_BATCH_DENIAL_FLOOR = 32;

/**
 * Default lifetime tool-call cap for a worker run. Value and env override live
 * in core/guardrails.ts (`CLIO_CODER_WORKER_TOOL_CALL_CAP`); re-exported here for
 * tests and callers that reason about the guard's tuning in one place.
 */
export const DEFAULT_WORKER_TOOL_CALL_CAP = GUARDRAIL_DEFAULTS.workerToolCallCap;

/**
 * Default soft per-turn tool-call budget for the interactive orchestrator.
 * Crossing it blocks every further call this turn with a stop-and-summarize
 * directive; the orchestrator is otherwise uncapped on the premise that an
 * operator can intervene, which fails for weak local models that spray
 * distinct commands the identical-call detector never sees.
 *
 * Sized as a backstop, not a routine ceiling: verbatim retry spirals are the
 * identical-call detector's job, so this only has to catch a model spraying
 * DISTINCT unproductive calls. Legitimate deep work (a repo-wide audit runs
 * 25+ productive calls in one turn) must not be decapitated by it; mainstream
 * harnesses run 100+ calls per turn with no ceiling at all. Value and env
 * override (`CLIO_CODER_TURN_TOOL_CALL_BUDGET`) live in core/guardrails.ts.
 */
export const DEFAULT_ORCH_TURN_TOOL_CALL_BUDGET = GUARDRAIL_DEFAULTS.turnToolCallBudget;
/**
 * Hard ceiling sits this many calls above the soft budget. Reaching it
 * interrupts the turn outright instead of merely nudging, bounding a model
 * that ignores the directive to a small number of blocked retries.
 */
export const ORCH_TURN_TOOL_CALL_HARD_MARGIN = 15;

/** Bounded turn-id memory, matching the registry's dispatch-guard policy. */
const LOOP_GUARD_TURN_LIMIT = 32;

/** Bounded per-fingerprint success memory for the block-reason evidence anchor. */
const SUCCEEDED_FINGERPRINT_LIMIT = 128;

/** Bucket for calls arriving without a turn id (e.g. pre-session probes). */
const NO_TURN_BUCKET = "no-turn";

/**
 * Arguments that only change how much of the same answer comes back, never
 * which answer it is. Stripped from the stagnation fingerprint so a model
 * cycling limit/offset escalations on an otherwise identical call is caught,
 * while genuinely different queries (new pattern, new path) reset the streak.
 */
const SIZE_ONLY_ARG_KEYS = new Set(["limit", "offset", "max_bytes", "context"]);

/**
 * Same-shape calls with byte-identical results tolerated before the next one
 * is blocked. Two identical results already prove the size knobs are not
 * adding information; the third attempt is never productive. Verbatim repeats
 * trip the identical-call detector first; this catches the escalation cycle
 * (limit: 10000 -> 20000 -> 50000 -> ...) that varies args enough to evade it.
 */
export const RESULT_STAGNATION_THRESHOLD = 3;
const CROSS_ARGUMENT_RESULT_MIN_BYTES = 64;

function stagnationFingerprint(tool: string, args: Record<string, unknown> | undefined): string {
	const reduced: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args ?? {})) {
		if (!SIZE_ONLY_ARG_KEYS.has(key)) reduced[key] = value;
	}
	return hashToolCall(tool, reduced);
}

function stagnationBlockReason(tool: string, identicalResults: number): string {
	return (
		`loop detected: the last ${identicalResults} ${tool} calls returned byte-identical results even though ` +
		`size arguments (limit/offset) changed. Raising them is not producing new information. ` +
		`Re-read the result above, change the query or tool, or answer from what you have.`
	);
}

function crossArgumentResultMessage(tool: string, distinctArguments: number): string {
	return (
		`loop guard: ${distinctArguments} distinct ${tool} arguments returned the same substantial result this turn. ` +
		"The tool may be ignoring an argument; re-read the result, change tools, or answer from what you have."
	);
}

/**
 * Base block reason: names the loop and asks for a strategy change (block #1).
 * When the same call already returned a successful result earlier this run, the
 * reason says so and points the model at that result — for a weak local model
 * "you already have this answer" is the strongest available anchor, stronger
 * than a generic "change strategy".
 */
function loopBlockBaseReason(tool: string, repeatCount: number, priorSuccesses: number): string {
	const evidence =
		priorSuccesses > 0
			? `This exact call already succeeded ${priorSuccesses} ${priorSuccesses === 1 ? "time" : "times"} this run; ` +
				`its result is already in the conversation above — re-read that result before calling tools again. `
			: "";
	return (
		`loop detected: ${tool} was called ${repeatCount} times with identical arguments among this turn's recent ` +
		`tool calls. Repeating the exact call is blocked. ${evidence}Change strategy: vary the arguments, use a ` +
		`different tool, or explain what new information you expect before retrying.`
	);
}

/**
 * Directive returned when a turn is locked to synthesis: tool use is over, so
 * the model must answer from what it already gathered. Fed back to the model as
 * the blocked call's result; the agent loop ends naturally on the first round
 * that emits text without a tool call.
 */
function synthesisLockoutDirective(): string {
	return (
		"loop guard: this turn reached its tool-call limit after repeated identical calls, so tool calls are now " +
		"disabled for the rest of this turn. Everything you retrieved is already in the conversation above. Answer " +
		"the operator now, in plain prose, from what you have gathered. Do not write tool-call markup such as " +
		"<tool_call> blocks; tool calls are disabled and will not run."
	);
}

/** Blocked-call result text for the backstop stop (the operator sees loopBlockedStopReason). */
function synthesisBackstopReason(tool: string): string {
	return (
		`loop guard: tool calls stayed disabled and ${tool} was called again instead of answering, so the turn is ` +
		"being stopped. Summarize what you found for the operator."
	);
}

/** Scout/read-only exploration phase transition; deliberately not a hard-cap machine reason. */
function workerExplorationSynthesisDirective(limit: number): string {
	return (
		`worker exploration budget reached (${limit}); exploration tools are now disabled for this run. ` +
		"Answer in plain prose from the evidence already gathered, with live path:line citations. Do not retry or " +
		"substitute another tool call."
	);
}

function disallowedToolsText(deliveryTools: ReadonlyArray<string>): string {
	const candidates = ["code_nav", "ls", "grep", "find", "context", "git", "shell commands"];
	const excluded = candidates.filter((tool) => !deliveryTools.includes(tool));
	return excluded.join(", ");
}

function workerLiveReadReserveDirective(remaining: number, deliveryTools: ReadonlyArray<string>): string {
	const admitted = deliveryTools.length > 0 ? `read and ${deliveryTools.join("/")}` : "the read tool";
	const finish =
		deliveryTools.length > 0
			? `Finish the work: re-read what you will cite and write it with ${deliveryTools.join(" or ")}.`
			: "Read a specific live file needed for the handoff.";
	return (
		`worker live-read reserve: broad orientation is complete and ${remaining} ${remaining === 1 ? "call remains" : "calls remain"}. ` +
		`Only ${admitted} ${deliveryTools.length > 0 ? "are" : "is"} admitted now. ${finish} Do not substitute ${disallowedToolsText(deliveryTools)}.`
	);
}

/**
 * Directive for a delivery-capable agent that has spent its declared soft
 * budget. Discovery is over for the rest of the run; delivery continues under
 * the lifetime cap, which is the bound that exists for it. Deliberately distinct
 * from the reserve directive, which counts down remaining calls inside a window
 * that has an end: past the soft limit there is no countdown to report, only the
 * cap.
 */
function workerDeliveryOnlyDirective(limit: number, deliveryTools: ReadonlyArray<string>): string {
	return (
		`worker discovery budget reached (${limit}); exploration tools are disabled for the rest of this run. ` +
		`Only read and ${deliveryTools.join("/")} are admitted now. Write what you have with ` +
		`${deliveryTools.join(" or ")} and finish. Do not substitute ${disallowedToolsText(deliveryTools)}.`
	);
}

/**
 * Dead tool-call markup a model can emit as plain text once tool_choice is
 * forced to none: the chat template's call syntax arrives as prose because the
 * runtime no longer parses it into a structured call. Measured on a local model
 * target, roughly one locked turn in three answered the forced text-only round
 * this way. Complete blocks are stripped wherever they appear; unterminated
 * trailing blocks (a length stop mid-markup) are stripped only when followed
 * by a call body (`<function=` or a JSON opener), so prose that merely quotes
 * the "<tool_call>" phrase survives.
 */
const DEAD_TOOL_CALL_MARKUP_PATTERNS: ReadonlyArray<RegExp> = [
	/<tool_call>[\s\S]*?<\/tool_call>/gi,
	/<function=[\w.-]+>[\s\S]*?<\/function>/gi,
	/<tool_call>\s*(?:<function=|[{[])[\s\S]*$/i,
	/<function=[\w.-]+>[\s\S]*$/i,
];

/** Strip dead tool-call markup from locked-turn text; trims only when something was stripped. */
function stripDeadToolCallMarkup(text: string): string {
	let out = text;
	for (const pattern of DEAD_TOOL_CALL_MARKUP_PATTERNS) {
		out = out.replace(pattern, "");
	}
	return out === text ? text : out.trim();
}

/**
 * Final-answer replacement when a locked turn's reply was nothing but dead
 * tool-call markup. Rendered as the assistant turn (TUI, headless result,
 * session ledger), so it explains the stop the way the loop-guard closing
 * messages do.
 */
export function lockedSynthesisFallbackText(): string {
	return (
		"[Clio Coder] loop guard: tool calls were disabled for the rest of this turn, but the reply contained only " +
		"tool-call markup, which cannot run and was removed. Ask me to continue with a different approach, or " +
		"narrow the request."
	);
}

/**
 * Sanitize the assistant message a synthesis-locked turn produced: strip dead
 * tool-call markup from its text blocks and fall back to
 * {@link lockedSynthesisFallbackText} when nothing remains. Mutates the message
 * in place; pi stores the same object in agent state before listeners run, so
 * one mutation at the subscribe seam covers the emitted event, the session
 * ledger, receipts, and the next round's provider payload without any surface
 * re-implementing the rule. Returns whether the message changed.
 *
 * Deliberately narrow: only assistant messages that finished ("stop", or
 * "length" for a mid-markup cutoff) with no structured tool call are touched.
 * Aborted and error messages keep their text (their flows carry their own
 * closing messages), and callers gate on the lockout being active so ordinary
 * turns and user text are never sanitized.
 */
export function sanitizeLockedSynthesisMessage(message: AgentMessage | undefined): boolean {
	if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") return false;
	const record = message as { content?: unknown; stopReason?: unknown };
	const stopReason = record.stopReason;
	if (stopReason !== undefined && stopReason !== "stop" && stopReason !== "length") return false;
	if (!Array.isArray(record.content)) return false;
	const blocks = record.content as Array<{ type?: unknown; text?: unknown }>;
	if (blocks.some((block) => block?.type === "toolCall")) return false;
	let changed = false;
	for (const block of blocks) {
		if (block?.type !== "text" || typeof block.text !== "string") continue;
		const stripped = stripDeadToolCallMarkup(block.text);
		if (stripped !== block.text) {
			block.text = stripped;
			changed = true;
		}
	}
	if (!changed) return false;
	const remaining = blocks
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("")
		.trim();
	if (remaining.length === 0) {
		const firstText = blocks.find(
			(block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string",
		);
		if (firstText) firstText.text = lockedSynthesisFallbackText();
		else blocks.push({ type: "text", text: lockedSynthesisFallbackText() });
	}
	return true;
}

/**
 * Recognizes the synthesis-backstop stop reason on surfaces without a bus.
 * Workers watch blocked tool-finish events for this reason (the same seam as
 * the lifetime cap) and abort the run: without it, the "stop" disposition is
 * bus-only and a worker that ignores the lockout would keep burning calls
 * until the lifetime cap. Measured on a live 35B coder worker: one identical
 * code_nav loop consumed the full 50-call cap (46 blocked calls, ~345k
 * tokens) before this abort path existed.
 */
export function isLoopGuardSynthesisBackstopReason(reason: string): boolean {
	return /^loop guard: tool calls stayed disabled and .+ was called again instead of answering/.test(reason);
}

/** Worker lifetime tool-call cap: env > settings guardrails > default. */
export function readWorkerToolCallCap(env: NodeJS.ProcessEnv = process.env): number {
	return resolveGuardrail("workerToolCallCap", env);
}

/** Soft/hard per-turn tool-call budget for the interactive orchestrator. */
export interface OrchTurnToolCallBudget {
	/** Distinct calls in a turn that trigger the re-plan nudge. */
	soft: number;
	/** Distinct calls in a turn that interrupt the turn. */
	hard: number;
}

export function readOrchTurnToolCallBudget(env: NodeJS.ProcessEnv = process.env): OrchTurnToolCallBudget {
	const soft = resolveGuardrail("turnToolCallBudget", env);
	return { soft, hard: soft + ORCH_TURN_TOOL_CALL_HARD_MARGIN };
}

export interface CreateLoopGuardRegistrationOptions {
	safety: SafetyContract;
	/** Orchestrator only: LoopBlocked events for the interactive layer. */
	bus?: SafeEventBus;
	/** Loop blocks tolerated per turn before the block reason announces a stop. */
	turnBlockBudget?: number;
	/**
	 * Worker only: hard cap on observed tool-call attempts for the lifetime of
	 * this registration. Absent means uncapped (the orchestrator has an
	 * operator who can intervene; workers do not).
	 */
	toolCallCap?: number;
	/**
	 * Worker only: successful exploration attempts allowed before a graceful,
	 * text-only synthesis phase. Unlike {@link toolCallCap}, crossing this soft
	 * boundary does not make an otherwise successful synthesized run fail.
	 */
	toolCallSoftLimit?: number;
	/**
	 * Worker only: tail of {@link toolCallSoftLimit} reserved for live source
	 * reads. Once the pre-reserve allowance is consumed, discovery attempts are
	 * blocked without spending the read allowance and the next provider round
	 * can be forced to `read` through {@link onSoftReadReserve}.
	 */
	toolCallSoftReadReserve?: number;
	/**
	 * Worker only: tools that carry this agent's deliverable rather than its
	 * exploration, admitted inside a reserve window alongside `read`. The
	 * reserve exists to end broad discovery, not to stop an agent from
	 * finishing: for an agent whose product is a report the tail is reads and
	 * prose, but for one whose product is files the tail is reads and writes,
	 * and blocking those made the last calls of every editing run bounce. Empty
	 * for read-only agents, which keeps the reserve read-only exactly as before.
	 */
	deliveryTools?: ReadonlyArray<string>;
	/**
	 * Worker only: calls held back from the tail of {@link toolCallCap} for
	 * verification reads and synthesis. Entering the window annotates one tool
	 * result with a one-shot reserve directive and blocks further non-read
	 * calls; reads still flow through the repetition and stagnation detectors.
	 * Inactive when absent, zero, or not smaller than the cap, so existing
	 * small-cap deployments and tests keep their exact behavior.
	 */
	toolCallReserve?: number;
	/**
	 * Orchestrator only: soft/hard per-turn tool-call budget. Crossing the soft
	 * budget blocks this and every further call in the turn with a
	 * stop-and-summarize directive; the hard ceiling additionally interrupts
	 * the turn over the bus. Absent for workers, which rely on the lifetime
	 * {@link toolCallCap} instead.
	 */
	turnToolCallBudget?: OrchTurnToolCallBudget;
	/**
	 * When the per-turn loop-block budget is exhausted, lock tool use for the
	 * rest of the turn instead of cancelling it outright. Every further call is
	 * denied with a synthesize-now directive so the model produces a final
	 * answer from what it already gathered; only a bounded backstop of extra
	 * denials ({@link LOOP_SYNTHESIS_BACKSTOP_DENIALS}) falls back to the hard
	 * stop. The orchestrator's stop rides the bus (LoopBlocked "stop" drives
	 * chat.cancel); workers have no bus and instead watch blocked tool-finish
	 * events for {@link isLoopGuardSynthesisBackstopReason} and abort the run,
	 * so a looping worker returns a synthesized report after a bounded number
	 * of denials rather than burning the lifetime {@link toolCallCap}.
	 */
	turnSynthesisLockout?: boolean;
	/**
	 * Invoked when a turn enters the synthesis lockout. Surfaces without a bus
	 * (workers) use it to flip their request-level tool-choice lock so the next
	 * model round is text-only; the orchestrator gets the same signal from the
	 * LoopBlocked "lockout" bus event instead.
	 */
	onSynthesisLockout?: () => void;
	/**
	 * Worker only: invoked when the final call allowed by the soft agent budget
	 * is admitted. The callback identifies the call whose completed tool-result
	 * message forms the post-execution boundary for a synthesis-disabled run.
	 * The guard locks later (including parallel sibling) calls before invoking
	 * this callback; callers must not stop the active call from this hook.
	 */
	onSoftLimitFinalCallAdmitted?: (toolCallId: string | undefined) => void;
	/** Invoked once when the soft-limit live-read reserve opens. */
	onSoftReadReserve?: () => void;
	now?: () => number;
}

export interface LoopGuardRegistration extends MiddlewareHookRegistration {
	/** Read-only attempt counter for tests and telemetry. */
	callCount(): number;
}

export function createLoopGuardRegistration(options: CreateLoopGuardRegistrationOptions): LoopGuardRegistration {
	const budget = options.turnBlockBudget ?? INTERACTIVE_LOOP_BLOCK_BUDGET;
	const cap = options.toolCallCap;
	const softLimit =
		options.toolCallSoftLimit !== undefined &&
		Number.isSafeInteger(options.toolCallSoftLimit) &&
		options.toolCallSoftLimit > 0 &&
		(cap === undefined || options.toolCallSoftLimit <= cap)
			? options.toolCallSoftLimit
			: undefined;
	const turnBudget = options.turnToolCallBudget;
	const synthesisLockout = options.turnSynthesisLockout === true;
	const softReadReserve = options.toolCallSoftReadReserve ?? 0;
	const softReadReserveThreshold =
		softLimit !== undefined && softReadReserve > 0 && softLimit > softReadReserve ? softLimit - softReadReserve : null;
	const deliveryTools = [...new Set(options.deliveryTools ?? [])];
	const reserveAdmits = (tool: string | undefined): boolean => isReserveAdmittedTool(tool, deliveryTools);
	let softAdmittedCount = 0;
	let softReadReserveEntered = false;
	/**
	 * Per-round non-compliance inside a reserve window. A reserve block is
	 * steering rather than a runaway signal, so it never spends the lifetime
	 * cap; this is what still bounds it. Reset by every admitted call, so the
	 * total is bounded by the reserve's own remaining calls.
	 */
	let reserveDenials: { denials: number; correlationId?: string } = { denials: 0 };
	/**
	 * Run-level bound on refused attempts, counted per call and blind to
	 * correlation. Every other bound here is per model round, which is correct
	 * for steering a model that keeps answering with tool calls but assumes a
	 * round is a handful of them. A degenerate local model emits one response
	 * whose parsed tool calls number in the hundreds, and every one of those
	 * siblings shares a correlation id, so the per-round bounds see a single
	 * denial while the batch drains. Charging refusals to the lifetime cap used
	 * to stop that by accident, at the cost of killing runs for obeying the
	 * guard. This is the same bound stated directly: a run may be refused as
	 * many calls as it was allowed to execute, and past that it is degenerate
	 * and ends on the backstop the worker already aborts on. The orchestrator
	 * has no cap and no bound here; it has an operator instead.
	 */
	let deniedAttempts = 0;
	const denialBudget = cap === undefined ? undefined : Math.max(cap, WIDE_BATCH_DENIAL_FLOOR);
	const boundRunDenials = (
		effects: ReadonlyArray<MiddlewareEffect>,
		input: MiddlewareHookInput,
	): ReadonlyArray<MiddlewareEffect> => {
		if (denialBudget === undefined || !effects.some((effect) => effect.kind === "block_tool")) return effects;
		deniedAttempts += 1;
		if (deniedAttempts <= denialBudget) return effects;
		return [{ kind: "block_tool", reason: synthesisBackstopReason(input.toolName ?? "unknown"), severity: "hard-block" }];
	};
	// Reserve window bounds. Active only when a cap exists and is strictly
	// larger than the reserve; a call is inside the window when its attempt
	// ordinal exceeds this threshold but has not passed the cap itself.
	const reserve = options.toolCallReserve ?? 0;
	const reserveThreshold = cap !== undefined && reserve > 0 && cap > reserve ? cap - reserve : null;
	let reserveDirectiveEmitted = false;
	const blocksByTurn = new Map<string, number>();
	const callsByTurn = new Map<string, number>();
	/**
	 * Turns whose tool use is locked to synthesis after reaching the block
	 * budget. Key present means locked; the value carries the block that tripped
	 * the lockout (so the backstop's stop message names the looping tool) plus a
	 * running count of denials since the lockout for the backstop threshold.
	 */
	const lockoutByTurn = new Map<
		string,
		{ tool: string; repeatCount: number; blocksThisTurn: number; denials: number; correlationId?: string }
	>();
	/**
	 * Lifetime-cap synthesis lockout (workers). Entered exactly once when the
	 * observed attempt count crosses the cap while the synthesis lockout is
	 * wired, however many parallel calls cross it in the same batch; further
	 * attempts count denials toward the same bounded backstop the loop lockout
	 * uses. Null until the cap is crossed; without the lockout the cap keeps
	 * its original immediate-abort reason.
	 */
	let capLockout: { denials: number; correlationId?: string } | null = null;
	/** Graceful worker exploration-phase lockout, separate from hard-cap failure. */
	let softLockout: { denials: number; correlationId?: string } | null = null;
	/**
	 * Per-fingerprint count of successful executions this run, for the evidence
	 * anchor: when a looped call already returned a result, the block reason
	 * points the model at that result instead of only asking for a new strategy.
	 * Bounded LRU (larger than the turn maps because a turn can retrieve from
	 * many distinct calls before it starts repeating one).
	 */
	const succeededFingerprints = new Map<string, number>();
	/**
	 * Per-turn streak of consecutive same-shape calls (size args ignored) whose
	 * outputs hashed identically. Only the latest streak per turn is tracked:
	 * stagnation is a consecutive-call property, so any differently shaped or
	 * differently answered call resets it.
	 */
	const stagnationByTurn = new Map<string, { reducedFingerprint: string; resultFingerprint: string; streak: number }>();
	const crossArgumentResultsByTurn = new Map<
		string,
		{ tool: string; resultFingerprint: string; argumentFingerprints: Set<string>; warned: boolean }
	>();
	let count = 0;

	const enterSoftReadReserve = (): void => {
		if (softReadReserveEntered) return;
		softReadReserveEntered = true;
		options.onSoftReadReserve?.();
	};

	const bumpBoundedCounter = (store: Map<string, number>, key: string, limit = LOOP_GUARD_TURN_LIMIT): number => {
		if (!store.has(key)) {
			while (store.size >= limit) {
				const oldest = store.keys().next().value;
				if (typeof oldest !== "string") break;
				store.delete(oldest);
			}
		}
		const next = (store.get(key) ?? 0) + 1;
		store.set(key, next);
		return next;
	};

	// A result whose observation envelope shows a truncated body with zero
	// items is a cap stub or a budget-exhausted notice: the call technically
	// returned "ok" but the model saw none of the payload. Counting it as a
	// success would make the block reason claim "this exact call already
	// succeeded; re-read that result" about a result that holds nothing.
	const resultCarriesEvidence = (details: MiddlewareHookInput["toolResultDetails"]): boolean => {
		const observation = details?.observation;
		if (observation === null || typeof observation !== "object" || Array.isArray(observation)) return true;
		const record = observation as { truncated?: unknown; shownCount?: unknown };
		return !(record.truncated === true && record.shownCount === 0);
	};

	// after_tool touchpoint: a successful call (result kind "ok") records a
	// success for its canonical fingerprint. Blocked calls never reach here
	// (admission returns before execution), so only real results anchor.
	const recordSuccessfulResult = (input: MiddlewareHookInput): void => {
		if (input.metadata?.resultKind !== "ok") return;
		if (!resultCarriesEvidence(input.toolResultDetails)) return;
		const tool = input.toolName;
		if (typeof tool !== "string" || tool.length === 0) return;
		bumpBoundedCounter(succeededFingerprints, hashToolCall(tool, input.toolArgs ?? {}), SUCCEEDED_FINGERPRINT_LIMIT);
	};

	// after_tool touchpoint: extend or reset the per-turn stagnation streak. A
	// result without a fingerprint (errors, non-string outputs) breaks the
	// streak rather than extending it.
	const recordResultForStagnation = (input: MiddlewareHookInput): void => {
		const turnKey = input.turnId ?? NO_TURN_BUCKET;
		const tool = input.toolName;
		const resultFingerprint = input.metadata?.resultFingerprint;
		if (
			typeof tool !== "string" ||
			tool.length === 0 ||
			input.metadata?.resultKind !== "ok" ||
			typeof resultFingerprint !== "string"
		) {
			stagnationByTurn.delete(turnKey);
			return;
		}
		const reducedFingerprint = stagnationFingerprint(tool, input.toolArgs);
		const previous = stagnationByTurn.get(turnKey);
		if (
			previous !== undefined &&
			previous.reducedFingerprint === reducedFingerprint &&
			previous.resultFingerprint === resultFingerprint
		) {
			previous.streak += 1;
			return;
		}
		if (!stagnationByTurn.has(turnKey)) {
			while (stagnationByTurn.size >= LOOP_GUARD_TURN_LIMIT) {
				const oldest = stagnationByTurn.keys().next().value;
				if (typeof oldest !== "string") break;
				stagnationByTurn.delete(oldest);
			}
		}
		stagnationByTurn.set(turnKey, { reducedFingerprint, resultFingerprint, streak: 1 });
	};

	// Diagnostic-only coverage for tools that accept a substantive argument but
	// ignore it. Track one consecutive same-tool/result streak per turn and
	// annotate the third distinct argument shape. Short generic outputs and
	// zero-item cap stubs are deliberately excluded; this path never blocks.
	const crossArgumentResultEffects = (input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> => {
		const turnKey = input.turnId ?? NO_TURN_BUCKET;
		const tool = input.toolName;
		const resultFingerprint = input.metadata?.resultFingerprint;
		const resultBytes = input.metadata?.resultBytes;
		if (
			typeof tool !== "string" ||
			tool.length === 0 ||
			input.metadata?.actionClass !== "read" ||
			input.metadata?.resultKind !== "ok" ||
			typeof resultFingerprint !== "string" ||
			typeof resultBytes !== "number" ||
			resultBytes < CROSS_ARGUMENT_RESULT_MIN_BYTES ||
			!resultCarriesEvidence(input.toolResultDetails)
		) {
			crossArgumentResultsByTurn.delete(turnKey);
			return [];
		}
		const argumentFingerprint = stagnationFingerprint(tool, input.toolArgs);
		const previous = crossArgumentResultsByTurn.get(turnKey);
		if (previous?.tool === tool && previous.resultFingerprint === resultFingerprint) {
			if (previous.warned) return [];
			previous.argumentFingerprints.add(argumentFingerprint);
			if (previous.argumentFingerprints.size >= RESULT_STAGNATION_THRESHOLD) {
				previous.warned = true;
				return [
					{
						kind: "annotate_tool_result",
						message: crossArgumentResultMessage(tool, previous.argumentFingerprints.size),
						severity: "warn",
					},
				];
			}
			return [];
		}
		if (!crossArgumentResultsByTurn.has(turnKey)) {
			while (crossArgumentResultsByTurn.size >= LOOP_GUARD_TURN_LIMIT) {
				const oldest = crossArgumentResultsByTurn.keys().next().value;
				if (typeof oldest !== "string") break;
				crossArgumentResultsByTurn.delete(oldest);
			}
		}
		crossArgumentResultsByTurn.set(turnKey, {
			tool,
			resultFingerprint,
			argumentFingerprints: new Set([argumentFingerprint]),
			warned: false,
		});
		return [];
	};

	const bumpTurnBlocks = (turnId: string): number => bumpBoundedCounter(blocksByTurn, turnId);

	const enterLockout = (
		input: MiddlewareHookInput,
		turnKey: string,
		state: { tool: string; repeatCount: number; blocksThisTurn: number },
	): void => {
		if (!lockoutByTurn.has(turnKey)) {
			while (lockoutByTurn.size >= LOOP_GUARD_TURN_LIMIT) {
				const oldest = lockoutByTurn.keys().next().value;
				if (typeof oldest !== "string") break;
				lockoutByTurn.delete(oldest);
			}
		}
		lockoutByTurn.set(turnKey, {
			...state,
			denials: 0,
			...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
		});
	};

	/**
	 * Count non-compliance by provider/model round, not by sibling tool call.
	 * Parallel calls share correlationId; only the first call from a new round
	 * spends one denial. Calls without correlation retain legacy per-call bounds.
	 */
	const reachesLockoutBackstop = (
		state: { denials: number; correlationId?: string },
		input: MiddlewareHookInput,
	): boolean => {
		if (input.correlationId !== undefined && state.correlationId === input.correlationId) return false;
		state.denials += 1;
		if (input.correlationId !== undefined) state.correlationId = input.correlationId;
		else delete state.correlationId;
		return state.denials > LOOP_SYNTHESIS_BACKSTOP_DENIALS;
	};

	const emitLoopBlocked = (
		input: MiddlewareHookInput,
		info: { tool: string; repeatCount: number; blocksThisTurn: number; disposition: LoopBlockedDisposition },
		at: number,
	): void => {
		const payload: LoopBlockedPayload = {
			tool: info.tool,
			repeatCount: info.repeatCount,
			blocksThisTurn: info.blocksThisTurn,
			budget,
			interrupted: info.disposition === "stop",
			disposition: info.disposition,
			at,
			...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
		};
		options.bus?.emit(BusChannels.LoopBlocked, payload);
	};

	const emitBudgetEvent = (
		input: MiddlewareHookInput,
		callsThisTurn: number,
		interrupted: boolean,
		at: number,
	): void => {
		if (turnBudget === undefined) return;
		const payload: ToolBudgetExceededPayload = {
			tool: input.toolName ?? "unknown",
			callsThisTurn,
			softBudget: turnBudget.soft,
			hardCeiling: turnBudget.hard,
			interrupted,
			at,
			...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
		};
		options.bus?.emit(BusChannels.ToolBudgetExceeded, payload);
	};

	const evaluateTurnBudget = (input: MiddlewareHookInput, now: number): ReadonlyArray<MiddlewareEffect> | null => {
		if (turnBudget === undefined) return null;
		const turnKey = input.turnId ?? NO_TURN_BUCKET;
		const callsThisTurn = bumpBoundedCounter(callsByTurn, turnKey);
		if (callsThisTurn >= turnBudget.hard) {
			// Hard ceiling: interrupt the turn the same way the block budget does.
			// The bus event drives chat.cancel() in the interactive layer; the
			// block effect makes the in-flight attempt fail with the same reason.
			if (callsThisTurn === turnBudget.hard) emitBudgetEvent(input, callsThisTurn, true, now);
			return [
				{
					kind: "block_tool",
					reason:
						`tool-call budget exhausted: ${callsThisTurn} tool calls in this turn reached the hard ceiling ` +
						`(${turnBudget.hard}); the turn is being stopped. Summarize what you found and wait for the operator.`,
					severity: "hard-block",
				},
			];
		}
		if (callsThisTurn >= turnBudget.soft) {
			// Soft budget: block this attempt and every further one this turn.
			// The directive must say so plainly — an earlier wording implied a
			// narrower call could still succeed, which sent even compliant
			// models into a retry spiral because no call after the crossing can
			// ever run. The operator sees one warn notice per turn (the first
			// crossing); the model keeps getting the directive on every further
			// over-budget attempt so it cannot quietly resume spraying calls.
			if (callsThisTurn === turnBudget.soft) emitBudgetEvent(input, callsThisTurn, false, now);
			return [
				{
					kind: "block_tool",
					reason:
						`tool-call budget: you have made ${callsThisTurn} tool calls in this turn (soft budget ${turnBudget.soft}). ` +
						`Every further tool call this turn will be blocked, so do not retry this call and do not substitute ` +
						`another one. Summarize what you have found so far in plain text, state the single next step you ` +
						`propose, and wait for the operator.`,
					severity: "hard-block",
				},
			];
		}
		return null;
	};

	// Shared loop-block machinery for both detectors: bump the turn's block
	// count, enter the synthesis lockout at the budget, and emit visibility.
	const blockAsLoop = (
		input: MiddlewareHookInput,
		turnKey: string,
		tool: string,
		repeatCount: number,
		baseReason: string,
		now: number,
	): ReadonlyArray<MiddlewareEffect> => {
		const blocksThisTurn = bumpTurnBlocks(turnKey);
		const reachedBudget = blocksThisTurn >= budget;
		// Budget reached with the synthesis lockout wired: enter the lockout
		// instead of stopping the turn. The block reason becomes the
		// synthesize-now directive; the LoopBlocked event carries "lockout"
		// (not "stop") so no surface cancels — the model gets its one bounded
		// chance to answer from what it gathered.
		if (synthesisLockout && reachedBudget) {
			enterLockout(input, turnKey, { tool, repeatCount, blocksThisTurn });
			options.onSynthesisLockout?.();
			emitLoopBlocked(input, { tool, repeatCount, blocksThisTurn, disposition: "lockout" }, now);
			return [{ kind: "block_tool", reason: synthesisLockoutDirective(), severity: "hard-block" }];
		}
		// Below budget, or a surface without the lockout (workers): the
		// existing per-block behavior. Reaching the budget without a lockout
		// still stops the turn with the "being stopped" reason.
		emitLoopBlocked(input, { tool, repeatCount, blocksThisTurn, disposition: reachedBudget ? "stop" : "block" }, now);
		const reason = reachedBudget
			? `${baseReason} Loop budget exhausted (${blocksThisTurn} blocks this turn); the agent is being stopped.`
			: baseReason;
		return [{ kind: "block_tool", reason, severity: "hard-block" }];
	};

	return {
		id: LOOP_GUARD_REGISTRATION_ID,
		description:
			"blocks repeated tool calls, enforces tool-call caps, and annotates substantial identical read results across distinct arguments",
		hooks: ["before_tool", "after_tool"],
		callCount: () => count,
		evaluate(input): ReadonlyArray<MiddlewareEffect> {
			if (input.hook === "after_tool") {
				recordSuccessfulResult(input);
				recordResultForStagnation(input);
				const effects = [...crossArgumentResultEffects(input)];
				if (
					softReadReserveEntered &&
					softLockout === null &&
					deliveryTools.length === 0 &&
					input.toolName === ToolNames.Read
				) {
					effects.push({ kind: "require_tool", toolName: ToolNames.Read });
				}
				// One-shot reserve directive: the first executed call inside the
				// reserve window carries the steering annotation, so the model is
				// told about the reserve without a blocked call spending budget.
				if (
					reserveThreshold !== null &&
					cap !== undefined &&
					!reserveDirectiveEmitted &&
					count > reserveThreshold &&
					count <= cap
				) {
					reserveDirectiveEmitted = true;
					effects.push({
						kind: "annotate_tool_result",
						message: workerSynthesisReserveDirective(Math.max(0, cap - count), cap),
						severity: "warn",
					});
				}
				return effects;
			}
			const now = options.now?.() ?? Date.now();
			const turnKey = input.turnId ?? NO_TURN_BUCKET;
			const decide = (): ReadonlyArray<MiddlewareEffect> => {
				// Once a synthesis phase begins, sibling calls from the already-emitted
				// parallel batch are denied without consuming the lifetime cap or the
				// per-round non-compliance backstop.
				if (capLockout !== null && cap !== undefined) {
					if (reachesLockoutBackstop(capLockout, input)) {
						return [
							{ kind: "block_tool", reason: synthesisBackstopReason(input.toolName ?? "unknown"), severity: "hard-block" },
						];
					}
					return [{ kind: "block_tool", reason: workerToolCallCapSynthesisReason(cap), severity: "hard-block" }];
				}
				if (softLockout !== null && softLimit !== undefined) {
					if (reachesLockoutBackstop(softLockout, input)) {
						return [
							{ kind: "block_tool", reason: synthesisBackstopReason(input.toolName ?? "unknown"), severity: "hard-block" },
						];
					}
					return [{ kind: "block_tool", reason: workerExplorationSynthesisDirective(softLimit), severity: "hard-block" }];
				}

				// Synthesis lockout after repeated calls. Check before counting the
				// attempt so a wide parallel batch cannot turn a graceful lock into a
				// lifetime-cap failure before the model gets its synthesis round.
				const lockout = synthesisLockout ? lockoutByTurn.get(turnKey) : undefined;
				if (lockout !== undefined) {
					if (reachesLockoutBackstop(lockout, input)) {
						emitLoopBlocked(
							input,
							{
								tool: lockout.tool,
								repeatCount: lockout.repeatCount,
								blocksThisTurn: lockout.blocksThisTurn,
								disposition: "stop",
							},
							now,
						);
						return [{ kind: "block_tool", reason: synthesisBackstopReason(lockout.tool), severity: "hard-block" }];
					}
					return [{ kind: "block_tool", reason: synthesisLockoutDirective(), severity: "hard-block" }];
				}

				// Soft agent budget and its reserve window, resolved before the call is
				// counted: every refusal below is steering the harness authored, and a
				// call the harness refused never ran. Counting those spent the lifetime
				// cap on the guard's own denials, which is how a worker that obeyed the
				// reserve by writing instead of grepping got killed by it. The bound on
				// refusals is reserveDenials and the synthesis backstop, both per model
				// round; the cap bounds executed work.
				if (softLimit !== undefined) {
					const spentSoftLimit = softAdmittedCount >= softLimit;
					// The soft budget ends discovery, not the run's own product. An agent
					// with no delivery tools has nothing left to do with a tool call, so
					// the budget locks it to synthesis exactly as before. An agent that
					// was granted mutation tools is still holding the files it was
					// dispatched to write, and its bound is the lifetime cap, which sits
					// above this limit for that reason. Refusing delivery here named the
					// refusal after exploration and told a writer its writes were
					// disabled: measured on the wiki documenter, ten of one pass's twelve
					// write attempts were refused with "exploration tools are now
					// disabled" and the pass landed no successful write at all.
					if (spentSoftLimit && deliveryTools.length === 0) {
						softLockout = {
							denials: 0,
							...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
						};
						options.onSynthesisLockout?.();
						return [{ kind: "block_tool", reason: workerExplorationSynthesisDirective(softLimit), severity: "hard-block" }];
					}
					const inReserve = softReadReserveThreshold !== null && softAdmittedCount >= softReadReserveThreshold;
					if (spentSoftLimit || inReserve) {
						enterSoftReadReserve();
						if (!reserveAdmits(input.toolName)) {
							// A model that keeps calling discovery tools inside the reserve
							// is not going to finish; after a bounded number of model rounds
							// it gets the same graceful synthesis lockout the soft budget
							// ends in, rather than an unbounded bounce.
							if (reachesLockoutBackstop(reserveDenials, input)) {
								softLockout = {
									denials: 0,
									...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
								};
								options.onSynthesisLockout?.();
								return [{ kind: "block_tool", reason: workerExplorationSynthesisDirective(softLimit), severity: "hard-block" }];
							}
							return [
								{
									kind: "block_tool",
									reason: spentSoftLimit
										? workerDeliveryOnlyDirective(softLimit, deliveryTools)
										: workerLiveReadReserveDirective(softLimit - softAdmittedCount, deliveryTools),
									severity: "hard-block",
								},
							];
						}
					}
				}

				// Synthesis reserve (workers): the tail of the lifetime cap is held for
				// verification reads and delivery. Discovery calls bounce with a
				// steering reason that never carries the cap's machine prefix, so cap
				// telemetry, worker aborts, and A2's cap-exhaustion notice stay
				// untouched; reads and this agent's delivery tools keep flowing through
				// the repetition and stagnation detectors below.
				if (reserveThreshold !== null && cap !== undefined && count >= reserveThreshold && !reserveAdmits(input.toolName)) {
					if (reachesLockoutBackstop(reserveDenials, input)) {
						if (synthesisLockout) {
							capLockout = {
								denials: 0,
								...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
							};
							options.onSynthesisLockout?.();
						}
						return [{ kind: "block_tool", reason: workerToolCallCapSynthesisReason(cap), severity: "hard-block" }];
					}
					return [
						{
							kind: "block_tool",
							reason: workerSynthesisReserveBlockReason(input.toolName ?? "unknown", Math.max(1, cap - count), cap),
							severity: "hard-block",
						},
					];
				}

				count += 1;
				reserveDenials = { denials: 0 };
				if (softLimit !== undefined) {
					softAdmittedCount += 1;
					if (softReadReserveThreshold !== null && softAdmittedCount >= softReadReserveThreshold) enterSoftReadReserve();
					if (softAdmittedCount >= softLimit) {
						// Arming the lockout here is what actually ends the work phase: the
						// softLockout branch above refuses every later call. A delivery-
						// capable agent must not be armed, or it would be locked out on the
						// call after the one that reached its budget and never deliver.
						// Its ending is the lifetime cap. `onSoftLimitFinalCallAdmitted` is
						// the separate synthesis:false runtime stop and still fires: an
						// agent that declared no synthesis phase ends where it said it did.
						if (deliveryTools.length === 0) {
							softLockout = {
								denials: 0,
								...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
							};
							options.onSynthesisLockout?.();
						}
						options.onSoftLimitFinalCallAdmitted?.(input.toolCallId);
					}
				}
				if (cap !== undefined && count > cap) {
					// No tool body executes past the cap. With the synthesis lockout
					// wired the run is not aborted on the spot: the first crossing flips
					// the request-level tool lock (onSynthesisLockout) and directs the
					// model to answer from what it gathered; a model that keeps emitting
					// tool calls anyway reaches the bounded backstop, whose reason the
					// worker runtime recognizes and aborts on. Parallel calls crossing
					// the cap in one batch enter the lockout exactly once.
					if (!synthesisLockout) {
						return [{ kind: "block_tool", reason: workerToolCallCapExceededReason(cap), severity: "hard-block" }];
					}
					capLockout = {
						denials: 0,
						...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
					};
					options.onSynthesisLockout?.();
					return [{ kind: "block_tool", reason: workerToolCallCapSynthesisReason(cap), severity: "hard-block" }];
				}

				// Identical-repeat detection runs BEFORE the volume budget so verbatim
				// retries of budget-blocked calls still reach the detector. Its tighter
				// interrupt (a couple of blocks per turn) is what ends the retry spiral
				// a weak model falls into once the budget starts rejecting calls;
				// checking the budget first starved the detector and let that spiral
				// churn all the way to the hard ceiling.
				const fingerprint = input.metadata?.callFingerprint;
				if (typeof fingerprint !== "string" || fingerprint.length === 0) {
					return evaluateTurnBudget(input, now) ?? [];
				}
				// The detector key is turn-scoped: its state lives for the whole
				// session, and the detector now retains the most recent attempts
				// regardless of age, so an unscoped key would let one identical call
				// per user turn (rerunning a build across turns) accumulate into a
				// false loop.
				const verdict = options.safety.observeLoop(`${turnKey}|${fingerprint}`, now);
				if (verdict.looping) {
					const tool = input.toolName ?? "unknown";
					const priorSuccesses = succeededFingerprints.get(fingerprint) ?? 0;
					return blockAsLoop(
						input,
						turnKey,
						tool,
						verdict.count,
						loopBlockBaseReason(tool, verdict.count, priorSuccesses),
						now,
					);
				}

				// Stagnation detection: the incoming call has the same shape (size
				// args ignored) as a streak of calls whose results hashed identical.
				// The escalation cycle (limit: 10k -> 20k -> 50k -> 10k ...) varies
				// arguments enough to evade the verbatim detector while never
				// producing new information; block the attempt the streak proves
				// futile.
				const toolName = input.toolName;
				if (typeof toolName === "string" && toolName.length > 0) {
					const entry = stagnationByTurn.get(turnKey);
					if (
						entry !== undefined &&
						entry.streak >= RESULT_STAGNATION_THRESHOLD - 1 &&
						entry.reducedFingerprint === stagnationFingerprint(toolName, input.toolArgs)
					) {
						return blockAsLoop(
							input,
							turnKey,
							toolName,
							entry.streak + 1,
							stagnationBlockReason(toolName, entry.streak),
							now,
						);
					}
				}
				return evaluateTurnBudget(input, now) ?? [];
			};
			return boundRunDenials(decide(), input);
		},
	};
}

export function isReserveAdmittedTool(tool: string | undefined, deliveryTools: ReadonlyArray<string>): boolean {
	return tool === ToolNames.Read || (tool !== undefined && deliveryTools.includes(tool));
}

export function resolveDeliveryTools(
	allowedTools: ReadonlyArray<string> | ReadonlySet<string>,
	product?: AgentProduct,
): string[] {
	const candidates: string[] =
		product === "orientation" ? [ToolNames.Write, ToolNames.Edit, ToolNames.CodeNav] : [ToolNames.Write, ToolNames.Edit];
	if (allowedTools instanceof Set) {
		return candidates.filter((tool) => allowedTools.has(tool));
	}
	return candidates.filter((tool) => (allowedTools as ReadonlyArray<string>).includes(tool));
}
