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

import { BusChannels, type LoopBlockedPayload } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { MiddlewareHookRegistration } from "../domains/middleware/runtime.js";
import type { MiddlewareEffect } from "../domains/middleware/types.js";
import type { SafetyContract } from "../domains/safety/contract.js";
import { createLoopState } from "../domains/safety/loop-detector.js";

export const LOOP_GUARD_REGISTRATION_ID = "guard.loop";

/** Loop blocks tolerated per user turn before the turn is interrupted. */
export const INTERACTIVE_LOOP_BLOCK_BUDGET = 3;

/** Default per-run tool-call cap when the env var is unset or invalid. */
export const DEFAULT_MAX_TOOL_CALLS = 50;
/** Environment variable that overrides the per-run tool-call cap. */
export const MAX_TOOL_CALLS_ENV = "CLIO_MAX_TOOL_CALLS";

/** Bounded turn-id memory, matching the registry's dispatch-guard policy. */
const LOOP_GUARD_TURN_LIMIT = 32;

/** Bucket for calls arriving without a turn id (e.g. pre-session probes). */
const NO_TURN_BUCKET = "no-turn";

const LOOP_WINDOW_MS = createLoopState().windowMs;

export function readToolCallCap(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[MAX_TOOL_CALLS_ENV];
	if (raw === undefined || raw === "") return DEFAULT_MAX_TOOL_CALLS;
	const normalized = raw.trim();
	if (!/^[1-9]\d*$/.test(normalized)) return DEFAULT_MAX_TOOL_CALLS;
	const parsed = Number(normalized);
	if (!Number.isSafeInteger(parsed)) return DEFAULT_MAX_TOOL_CALLS;
	return parsed;
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
	now?: () => number;
}

export interface LoopGuardRegistration extends MiddlewareHookRegistration {
	/** Read-only attempt counter for tests and telemetry. */
	callCount(): number;
}

export function createLoopGuardRegistration(options: CreateLoopGuardRegistrationOptions): LoopGuardRegistration {
	const budget = options.turnBlockBudget ?? INTERACTIVE_LOOP_BLOCK_BUDGET;
	const cap = options.toolCallCap;
	const blocksByTurn = new Map<string, number>();
	let count = 0;

	const bumpTurnBlocks = (turnId: string): number => {
		if (!blocksByTurn.has(turnId)) {
			while (blocksByTurn.size >= LOOP_GUARD_TURN_LIMIT) {
				const oldest = blocksByTurn.keys().next().value;
				if (typeof oldest !== "string") break;
				blocksByTurn.delete(oldest);
			}
		}
		const next = (blocksByTurn.get(turnId) ?? 0) + 1;
		blocksByTurn.set(turnId, next);
		return next;
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
