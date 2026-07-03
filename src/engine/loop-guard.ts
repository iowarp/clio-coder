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
import { GUARDRAIL_DEFAULTS, resolveGuardrail } from "../core/guardrails.js";
import type { MiddlewareHookRegistration } from "../domains/middleware/runtime.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "../domains/middleware/types.js";
import type { SafetyContract } from "../domains/safety/contract.js";
import { createLoopState } from "../domains/safety/loop-detector.js";

export const LOOP_GUARD_REGISTRATION_ID = "guard.loop";

/**
 * Loop blocks tolerated per user turn before the turn is interrupted. Combined
 * with the detector's identical-call threshold, a runaway turn is bounded to a
 * few verbatim repeats (threshold-1 free calls plus this many blocked retries)
 * rather than spinning for tens of seconds before the stop lands.
 */
export const INTERACTIVE_LOOP_BLOCK_BUDGET = 2;

/**
 * Post-lockout tool calls tolerated before the synthesis lockout falls back to
 * a hard turn stop. Once a turn reaches its loop-block budget the guard locks
 * tools for the rest of the turn and tells the model to answer from what it
 * gathered; a model that keeps calling tools instead of answering is stopped
 * after this many further denials so a degenerate model cannot spin forever.
 */
export const LOOP_SYNTHESIS_BACKSTOP_DENIALS = 2;

/**
 * Default lifetime tool-call cap for a worker run. Value and env override live
 * in core/guardrails.ts (`CLIO_WORKER_TOOL_CALL_CAP`); re-exported here for
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
 * override (`CLIO_TURN_TOOL_CALL_BUDGET`) live in core/guardrails.ts.
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

/** Bucket for calls arriving without a turn id (e.g. pre-session probes). */
const NO_TURN_BUCKET = "no-turn";

const LOOP_WINDOW_MS = createLoopState().windowMs;

/** Base block reason: names the loop and asks for a strategy change (block #1). */
function loopBlockBaseReason(tool: string, repeatCount: number): string {
	const windowSeconds = Math.round(LOOP_WINDOW_MS / 1000);
	return (
		`loop detected: ${tool} was called ${repeatCount} times with identical arguments within ${windowSeconds}s. ` +
		`Repeating the exact call is blocked. Change strategy: vary the arguments, use a different tool, ` +
		`or explain what new information you expect before retrying.`
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
		"the operator now, in plain text, from what you have gathered — do not call any more tools."
	);
}

/** Blocked-call result text for the backstop stop (the operator sees loopBlockedStopReason). */
function synthesisBackstopReason(tool: string): string {
	return (
		`loop guard: tool calls stayed disabled and ${tool} was called again instead of answering, so the turn is ` +
		"being stopped. Summarize what you found for the operator."
	);
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
	 * Orchestrator only: soft/hard per-turn tool-call budget. Crossing the soft
	 * budget blocks this and every further call in the turn with a
	 * stop-and-summarize directive; the hard ceiling additionally interrupts
	 * the turn over the bus. Absent for workers, which rely on the lifetime
	 * {@link toolCallCap} instead.
	 */
	turnToolCallBudget?: OrchTurnToolCallBudget;
	/**
	 * Orchestrator only: when the per-turn loop-block budget is exhausted, lock
	 * tool use for the rest of the turn instead of cancelling it outright. Every
	 * further call is denied with a synthesize-now directive so the model
	 * produces a final answer from what it already gathered; only a bounded
	 * backstop of extra denials ({@link LOOP_SYNTHESIS_BACKSTOP_DENIALS}) falls
	 * back to the hard stop. Absent for workers, which have no interactive turn
	 * boundary and rely on the lifetime {@link toolCallCap}; leaving it off
	 * preserves the immediate at-budget stop those surfaces expect.
	 */
	turnSynthesisLockout?: boolean;
	now?: () => number;
}

export interface LoopGuardRegistration extends MiddlewareHookRegistration {
	/** Read-only attempt counter for tests and telemetry. */
	callCount(): number;
}

export function createLoopGuardRegistration(options: CreateLoopGuardRegistrationOptions): LoopGuardRegistration {
	const budget = options.turnBlockBudget ?? INTERACTIVE_LOOP_BLOCK_BUDGET;
	const cap = options.toolCallCap;
	const turnBudget = options.turnToolCallBudget;
	const synthesisLockout = options.turnSynthesisLockout === true;
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
		{ tool: string; repeatCount: number; blocksThisTurn: number; denials: number }
	>();
	let count = 0;

	const bumpBoundedCounter = (store: Map<string, number>, turnId: string): number => {
		if (!store.has(turnId)) {
			while (store.size >= LOOP_GUARD_TURN_LIMIT) {
				const oldest = store.keys().next().value;
				if (typeof oldest !== "string") break;
				store.delete(oldest);
			}
		}
		const next = (store.get(turnId) ?? 0) + 1;
		store.set(turnId, next);
		return next;
	};

	const bumpTurnBlocks = (turnId: string): number => bumpBoundedCounter(blocksByTurn, turnId);

	const enterLockout = (turnKey: string, state: { tool: string; repeatCount: number; blocksThisTurn: number }): void => {
		if (!lockoutByTurn.has(turnKey)) {
			while (lockoutByTurn.size >= LOOP_GUARD_TURN_LIMIT) {
				const oldest = lockoutByTurn.keys().next().value;
				if (typeof oldest !== "string") break;
				lockoutByTurn.delete(oldest);
			}
		}
		lockoutByTurn.set(turnKey, { ...state, denials: 0 });
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

	return {
		id: LOOP_GUARD_REGISTRATION_ID,
		description: "blocks verbatim-repeated tool calls and enforces the per-run tool-call cap",
		hooks: ["before_tool"],
		callCount: () => count,
		evaluate(input): ReadonlyArray<MiddlewareEffect> {
			const now = options.now?.() ?? Date.now();
			count += 1;
			if (cap !== undefined && count > cap) {
				return [{ kind: "block_tool", reason: `tool-call cap reached (${cap}); abort turn`, severity: "hard-block" }];
			}
			const turnKey = input.turnId ?? NO_TURN_BUCKET;

			// Synthesis lockout (orchestrator only). Once a turn has exhausted its
			// loop-block budget, tool use is over: every further call is denied
			// with a synthesize-now directive so the model answers from what it
			// already gathered, and only a bounded backstop of extra denials falls
			// back to the hard stop. This replaces the immediate turn-cancel that
			// used to fire at the budget, which threw away turns already holding
			// the answer. The check runs before the fingerprint so a locked turn
			// denies distinct calls too: the model must answer, not pivot tools.
			const lockout = synthesisLockout ? lockoutByTurn.get(turnKey) : undefined;
			if (lockout !== undefined) {
				lockout.denials += 1;
				if (lockout.denials > LOOP_SYNTHESIS_BACKSTOP_DENIALS) {
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
			const verdict = options.safety.observeLoop(fingerprint, now);
			if (!verdict.looping) return evaluateTurnBudget(input, now) ?? [];
			const tool = input.toolName ?? "unknown";
			const blocksThisTurn = bumpTurnBlocks(turnKey);
			const reachedBudget = blocksThisTurn >= budget;
			const base = loopBlockBaseReason(tool, verdict.count);

			// Budget reached with the synthesis lockout wired: enter the lockout
			// instead of stopping the turn. The block reason becomes the
			// synthesize-now directive; the LoopBlocked event carries "lockout"
			// (not "stop") so no surface cancels — the model gets its one bounded
			// chance to answer from what it gathered.
			if (synthesisLockout && reachedBudget) {
				enterLockout(turnKey, { tool, repeatCount: verdict.count, blocksThisTurn });
				emitLoopBlocked(input, { tool, repeatCount: verdict.count, blocksThisTurn, disposition: "lockout" }, now);
				return [{ kind: "block_tool", reason: synthesisLockoutDirective(), severity: "hard-block" }];
			}

			// Below budget, or a surface without the lockout (workers): the
			// existing per-block behavior. Reaching the budget without a lockout
			// still stops the turn with the "being stopped" reason.
			emitLoopBlocked(
				input,
				{ tool, repeatCount: verdict.count, blocksThisTurn, disposition: reachedBudget ? "stop" : "block" },
				now,
			);
			const reason = reachedBudget
				? `${base} Loop budget exhausted (${blocksThisTurn} blocks this turn); the agent is being stopped.`
				: base;
			return [{ kind: "block_tool", reason, severity: "hard-block" }];
		},
	};
}
