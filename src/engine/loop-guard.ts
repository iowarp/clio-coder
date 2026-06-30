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

import { BusChannels, type LoopBlockedPayload, type ToolBudgetExceededPayload } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
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

/** Default per-run tool-call cap when the env var is unset or invalid. */
export const DEFAULT_MAX_TOOL_CALLS = 50;
/** Environment variable that overrides the per-run tool-call cap. */
export const MAX_TOOL_CALLS_ENV = "CLIO_MAX_TOOL_CALLS";

/**
 * Default soft per-turn tool-call budget for the interactive orchestrator.
 * Crossing it injects a re-plan directive; the orchestrator is otherwise
 * uncapped on the premise that an operator can intervene, which fails for weak
 * local models that spray distinct commands the identical-call detector never
 * sees.
 */
export const DEFAULT_ORCH_TURN_TOOL_CALL_BUDGET = 25;
/**
 * Hard ceiling sits this many calls above the soft budget. Reaching it
 * interrupts the turn outright instead of merely nudging, bounding a model
 * that ignores the directive to a small number of blocked retries.
 */
export const ORCH_TURN_TOOL_CALL_HARD_MARGIN = 15;
/** Environment variable that overrides the soft per-turn tool-call budget. */
export const ORCH_MAX_TOOL_CALLS_ENV = "CLIO_ORCH_MAX_TOOL_CALLS";

/** Bounded turn-id memory, matching the registry's dispatch-guard policy. */
const LOOP_GUARD_TURN_LIMIT = 32;

/** Bucket for calls arriving without a turn id (e.g. pre-session probes). */
const NO_TURN_BUCKET = "no-turn";

const LOOP_WINDOW_MS = createLoopState().windowMs;

function readPositiveIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const normalized = raw.trim();
	if (!/^[1-9]\d*$/.test(normalized)) return fallback;
	const parsed = Number(normalized);
	if (!Number.isSafeInteger(parsed)) return fallback;
	return parsed;
}

export function readToolCallCap(env: NodeJS.ProcessEnv = process.env): number {
	return readPositiveIntEnv(env, MAX_TOOL_CALLS_ENV, DEFAULT_MAX_TOOL_CALLS);
}

/** Soft/hard per-turn tool-call budget for the interactive orchestrator. */
export interface OrchTurnToolCallBudget {
	/** Distinct calls in a turn that trigger the re-plan nudge. */
	soft: number;
	/** Distinct calls in a turn that interrupt the turn. */
	hard: number;
}

export function readOrchTurnToolCallBudget(env: NodeJS.ProcessEnv = process.env): OrchTurnToolCallBudget {
	const soft = readPositiveIntEnv(env, ORCH_MAX_TOOL_CALLS_ENV, DEFAULT_ORCH_TURN_TOOL_CALL_BUDGET);
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
	 * Orchestrator only: soft/hard per-turn tool-call budget. The soft budget
	 * injects a re-plan directive (block this attempt with house-style guidance);
	 * the hard ceiling additionally interrupts the turn over the bus. Absent for
	 * workers, which rely on the lifetime {@link toolCallCap} instead.
	 */
	turnToolCallBudget?: OrchTurnToolCallBudget;
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
	const blocksByTurn = new Map<string, number>();
	const callsByTurn = new Map<string, number>();
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
			// Soft budget: block this attempt and hand the model a re-plan
			// directive. The operator sees one warn notice per turn (the first
			// crossing); the model keeps getting the directive on every further
			// over-budget attempt so it cannot quietly resume spraying calls.
			if (callsThisTurn === turnBudget.soft) emitBudgetEvent(input, callsThisTurn, false, now);
			return [
				{
					kind: "block_tool",
					reason:
						`tool-call budget: you have made ${callsThisTurn} tool calls in this turn (soft budget ${turnBudget.soft}). ` +
						`Stop exploring. Summarize what you have found so far, narrow to a single concrete next step, or ask the ` +
						`operator a clarifying question before calling more tools.`,
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
			const budgetEffects = evaluateTurnBudget(input, now);
			if (budgetEffects !== null) return budgetEffects;
			const fingerprint = input.metadata?.callFingerprint;
			if (typeof fingerprint !== "string" || fingerprint.length === 0) return [];
			const verdict = options.safety.observeLoop(fingerprint, now);
			if (!verdict.looping) return [];
			const tool = input.toolName ?? "unknown";
			const blocksThisTurn = bumpTurnBlocks(input.turnId ?? NO_TURN_BUCKET);
			const interrupted = blocksThisTurn >= budget;
			const payload: LoopBlockedPayload = {
				tool,
				repeatCount: verdict.count,
				blocksThisTurn,
				budget,
				interrupted,
				at: now,
				...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
			};
			options.bus?.emit(BusChannels.LoopBlocked, payload);
			const windowSeconds = Math.round(LOOP_WINDOW_MS / 1000);
			const base =
				`loop detected: ${tool} was called ${verdict.count} times with identical arguments within ${windowSeconds}s. ` +
				`Repeating the exact call is blocked. Change strategy: vary the arguments, use a different tool, ` +
				`or explain what new information you expect before retrying.`;
			const reason = interrupted
				? `${base} Loop budget exhausted (${blocksThisTurn} blocks this turn); the agent is being stopped.`
				: base;
			return [{ kind: "block_tool", reason, severity: "hard-block" }];
		},
	};
}
