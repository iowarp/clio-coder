/**
 * Shared loop-guard interrupt handling. The backend loop guard
 * (engine/loop-guard.ts) emits `LoopBlocked`/`ToolBudgetExceeded` over the bus;
 * when a turn is interrupted, the active turn must be stopped with a durable,
 * visible closing message rather than left to spin.
 *
 * The interactive TUI wires its own subscriber (it also renders the per-block
 * warn notices). Operatorless surfaces (headless `clio run`, ACP) have no such
 * subscriber, so a degenerate local model spins until an external timeout: the
 * `block_tool` effect blocks each call but nothing aborts the run. This module
 * is the single source of truth for the closing-message text and the
 * interrupt-to-stop subscriber both surfaces use, so messaging never drifts.
 */

import { BusChannels, type LoopBlockedPayload, type ToolBudgetExceededPayload } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { ChatCancelOptions } from "./chat-loop.js";

/** Minimal chat surface the loop-guard stop needs: only the cancel entry point. */
export interface LoopGuardStoppableChat {
	cancel(options?: ChatCancelOptions): void;
}

function isLoopBlockedInterrupt(payload: unknown): payload is LoopBlockedPayload {
	const evt = payload as LoopBlockedPayload | null | undefined;
	return (
		!!evt &&
		typeof evt === "object" &&
		evt.interrupted === true &&
		typeof evt.tool === "string" &&
		typeof evt.repeatCount === "number"
	);
}

function isToolBudgetInterrupt(payload: unknown): payload is ToolBudgetExceededPayload {
	const evt = payload as ToolBudgetExceededPayload | null | undefined;
	return (
		!!evt &&
		typeof evt === "object" &&
		evt.interrupted === true &&
		typeof evt.tool === "string" &&
		typeof evt.callsThisTurn === "number"
	);
}

/** Operator-facing closing message for an identical-call loop interrupt. */
export function loopBlockedStopReason(evt: LoopBlockedPayload): string {
	const blockWord = evt.blocksThisTurn === 1 ? "block" : "blocks";
	return (
		`[Clio Coder] loop guard stopped this turn: ${evt.tool} was called with identical arguments ` +
		`${evt.repeatCount} times without new results (${evt.blocksThisTurn} loop ${blockWord}). I likely ` +
		`already have enough to answer. Ask me to continue with a different approach, or narrow the request.`
	);
}

/** Operator-facing closing message for a per-turn tool-call ceiling interrupt. */
export function toolBudgetStopReason(evt: ToolBudgetExceededPayload): string {
	return (
		`[Clio Coder] loop guard stopped this turn: ${evt.callsThisTurn} tool calls reached the per-turn ceiling ` +
		`(${evt.hardCeiling}) without converging. Tell me a single concrete next step, or narrow the request.`
	);
}

/** Audit reason (short) for an identical-call loop interrupt. */
export function loopBlockedAuditReason(evt: LoopBlockedPayload): string {
	return `loop: ${evt.tool} repeated ${evt.repeatCount}x`;
}

/** Audit reason (short) for a tool-call ceiling interrupt. */
export function toolBudgetAuditReason(evt: ToolBudgetExceededPayload): string {
	return `tool-call ceiling: ${evt.callsThisTurn} calls`;
}

/**
 * Stop the active turn with a durable closing message when the loop guard
 * interrupts. Used by the operatorless surfaces (headless, ACP); the
 * interactive TUI wires the equivalent inline so it can also render the
 * per-block warn notices. Returns an unsubscribe handle.
 */
export function subscribeLoopGuardStop(bus: SafeEventBus, chat: LoopGuardStoppableChat): () => void {
	const unsubscribeLoopBlocked = bus.on(BusChannels.LoopBlocked, (payload) => {
		if (!isLoopBlockedInterrupt(payload)) return;
		chat.cancel({
			reason: loopBlockedStopReason(payload),
			source: "loop_guard",
			auditReason: loopBlockedAuditReason(payload),
		});
	});
	const unsubscribeToolBudget = bus.on(BusChannels.ToolBudgetExceeded, (payload) => {
		if (!isToolBudgetInterrupt(payload)) return;
		chat.cancel({
			reason: toolBudgetStopReason(payload),
			source: "loop_guard",
			auditReason: toolBudgetAuditReason(payload),
		});
	});
	return () => {
		unsubscribeLoopBlocked();
		unsubscribeToolBudget();
	};
}
