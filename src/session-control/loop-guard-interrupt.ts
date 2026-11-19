/**
 * Shared loop-guard interrupt handling. The backend loop guard
 * (engine/loop-guard.ts) emits `LoopBlocked`/`ToolBudgetExceeded` over the bus;
 * when a turn is interrupted, the active turn must be stopped with a durable,
 * visible closing message rather than left to spin.
 *
 * The interactive TUI wires its own subscriber (it also renders the per-block
 * warn notices). Operatorless surfaces (headless `clio-coder run`, ACP) have no such
 * subscriber, so a degenerate local model spins until an external timeout: the
 * `block_tool` effect blocks each call but nothing aborts the run. This module
 * is the single source of truth for the closing-message text and the
 * interrupt-to-stop subscriber both surfaces use, so messaging never drifts.
 */

import type { TelemetryHub } from "../core/telemetry/hub.js";
import type { LoopBlockedPayload, ToolBudgetExceededPayload } from "../core/telemetry/live-events.js";
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

/**
 * Operator-facing closing message for an identical-call loop interrupt. The
 * harness stopped the turn, so the notice speaks as the harness: the fact and
 * the operator's options, never a claim in Clio's voice about what it knows.
 */
export function loopBlockedStopReason(evt: LoopBlockedPayload): string {
	const blockWord = evt.blocksThisTurn === 1 ? "block" : "blocks";
	return (
		`[CLIO Coder] loop guard stopped this turn: ${evt.tool} was called with identical arguments ` +
		`${evt.repeatCount} times (${evt.blocksThisTurn} loop ${blockWord}). Send a new message ` +
		`to continue with a different approach, or narrow the request.`
	);
}

/** Operator-facing closing message for a per-turn tool-call ceiling interrupt. */
export function toolBudgetStopReason(evt: ToolBudgetExceededPayload): string {
	return (
		`[CLIO Coder] loop guard stopped this turn: ${evt.callsThisTurn} tool-call attempts passed the per-turn ceiling ` +
		`(${evt.hardCeiling}) without converging. Send one concrete next step, or narrow the request.`
	);
}

/**
 * What a continuation after a turn-wide tool block must say first. The budget
 * block tells the model every further call this turn is blocked, and a
 * continuation that said only "continue from where it stopped" left the model
 * reporting read and write unavailable though the new turn admitted both
 * (F-C14). The locks are per turn, so the new turn says so plainly.
 */
export const TOOL_LOCK_RESET_DETAIL =
	"This is a new turn; the tool budget is reset and every tool the turn held is available again.";

/**
 * What a continuation after a loop stop must change. The continuation used to
 * say only "continue from where it stopped" over the same context, and a
 * model that had diagnosed its own malformed call in its closing message sent
 * the identical call twice more (WTF-P campaign). The failure the guard quoted
 * goes first, then the instruction to change the call before retrying it.
 */
export function loopGuardContinuationDetail(guard: { tool: string; failure: string }): string {
	return [
		`The loop guard stopped repeats of a ${guard.tool} call that kept failing with:`,
		guard.failure,
		`An identical ${guard.tool} call will be blocked again. Before retrying it, change the arguments so they fix what that error names; if your last message already diagnosed the fault, apply that diagnosis to the call. If the call cannot be fixed, report the blocker instead of retrying.`,
	].join("\n");
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
export function subscribeLoopGuardStop(bus: TelemetryHub, chat: LoopGuardStoppableChat): () => void {
	const unsubscribeLoopBlocked = bus.subscribe("safety.loop_blocked", (payload) => {
		if (!isLoopBlockedInterrupt(payload)) return;
		chat.cancel({
			reason: loopBlockedStopReason(payload),
			source: "loop_guard",
			auditReason: loopBlockedAuditReason(payload),
		});
	});
	const unsubscribeToolBudget = bus.subscribe("safety.tool_budget_exceeded", (payload) => {
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
