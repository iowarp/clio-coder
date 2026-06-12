/**
 * Loop guard for the interactive orchestrator.
 *
 * Worker subprocesses are protected by `createWorkerLoopGuard` (checked in
 * worker-runtime.ts via pi-agent-core's beforeToolCall hook, on worker-local
 * loop state). The orchestrator had no equivalent; this guard closes that gap
 * at the registry's `runSpec` admission seam. It reuses the safety domain's
 * sliding-window loop detector through `SafetyContract.observeLoop` and the
 * worker guard's `hashToolCall` key building, so thresholds and fingerprints
 * stay identical across both paths.
 *
 * Operator visibility flows over the event bus only: every block emits a
 * `BusChannels.LoopBlocked` payload that the interactive layer renders as a
 * notice. Nothing here imports TUI code.
 */

import { BusChannels, type LoopBlockedPayload } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { SafetyContract } from "../domains/safety/contract.js";
import { createLoopState } from "../domains/safety/loop-detector.js";
import { hashToolCall } from "./worker-tools.js";

/** Loop blocks tolerated per user turn before the turn is interrupted. */
export const INTERACTIVE_LOOP_BLOCK_BUDGET = 3;

/** Bounded turn-id memory, matching the registry's dispatch-guard policy. */
const LOOP_GUARD_TURN_LIMIT = 32;

/** Bucket for calls arriving without a turn id (e.g. pre-session probes). */
const NO_TURN_BUCKET = "no-turn";

const LOOP_WINDOW_MS = createLoopState().windowMs;

export interface InteractiveLoopGuardDecision {
	block: boolean;
	reason?: string;
}

export interface InteractiveLoopGuard {
	/**
	 * Observe a pending tool call. Returns `{ block: true, reason }` when the
	 * detector flags verbatim repetition; the reason is written for the model
	 * so it can recover without operator help.
	 */
	check(tool: string, args: unknown, opts?: { turnId?: string; now?: number }): InteractiveLoopGuardDecision;
}

export interface CreateInteractiveLoopGuardOptions {
	safety: SafetyContract;
	/** Optional so contract tests can run the guard without a bus. */
	bus?: SafeEventBus;
}

export function createInteractiveLoopGuard(options: CreateInteractiveLoopGuardOptions): InteractiveLoopGuard {
	const blocksByTurn = new Map<string, number>();

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
		check(tool, args, opts) {
			const now = opts?.now ?? Date.now();
			const verdict = options.safety.observeLoop(hashToolCall(tool, args), now);
			if (!verdict.looping) return { block: false };
			const blocksThisTurn = bumpTurnBlocks(opts?.turnId ?? NO_TURN_BUCKET);
			const interrupted = blocksThisTurn >= INTERACTIVE_LOOP_BLOCK_BUDGET;
			const payload: LoopBlockedPayload = {
				tool,
				repeatCount: verdict.count,
				blocksThisTurn,
				budget: INTERACTIVE_LOOP_BLOCK_BUDGET,
				interrupted,
				at: now,
				...(opts?.turnId !== undefined ? { turnId: opts.turnId } : {}),
			};
			options.bus?.emit(BusChannels.LoopBlocked, payload);
			const windowSeconds = Math.round(LOOP_WINDOW_MS / 1000);
			const base =
				`loop detected: ${tool} was called ${verdict.count} times with identical arguments within ${windowSeconds}s. ` +
				`Repeating the exact call is blocked. Change strategy: vary the arguments, use a different tool, ` +
				`or explain what new information you expect before retrying.`;
			return {
				block: true,
				reason: interrupted
					? `${base} Loop budget exhausted (${blocksThisTurn} blocks this turn); the agent is being stopped.`
					: base,
			};
		},
	};
}
