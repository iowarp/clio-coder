/**
 * Coalescing wrapper around chat events (slice 12.5d).
 *
 * Streaming responses fire `text_delta` / `thinking_delta` events at very
 * high frequency. The TUI's per-event `requestRender()` call rebuilt the
 * entire transcript on every delta, which scaled linearly with response
 * length and made long answers visibly lag. This wrapper applies every
 * event to the panel synchronously (so internal state stays consistent)
 * but defers `requestRender()` for delta events to a single coalesced
 * timer (~16ms = one frame at 60fps). Non-delta events render
 * synchronously so finalizers like `message_end` are never deferred.
 */

import type { ClioTurnRecord } from "../engine/session.js";
import type { AgentMessage } from "../engine/types.js";
import type { ChatLoopEvent } from "./chat-loop.js";
import type { ChatPanel } from "./chat-panel.js";

const DEFAULT_COALESCE_MS = 16;

/**
 * Event kinds whose render is deferred into a coalesce window. All other
 * `ChatLoopEvent` kinds render synchronously and cancel any pending timer.
 */
const DELTA_TYPES: ReadonlySet<ChatLoopEvent["type"]> = new Set(["text_delta", "thinking_delta"]);

export interface CreateCoalescingChatRendererDeps {
	chatPanel: ChatPanel;
	requestRender: () => void;
	/** Coalesce window in ms. Defaults to 16 (one frame at 60fps). */
	coalesceMs?: number;
	/** Override for tests. Mirrors the setTimeout signature. */
	setTimer?: (cb: () => void, ms: number) => unknown;
	/** Override for tests. Mirrors the clearTimeout signature. */
	clearTimer?: (id: unknown) => void;
}

export interface CoalescingChatRenderer {
	applyEvent(event: ChatLoopEvent): void;
	/** Cancel the pending coalesce timer (if any) and request one synchronous render. */
	flush(): void;
}

export function createCoalescingChatRenderer(deps: CreateCoalescingChatRendererDeps): CoalescingChatRenderer {
	const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
	const clearTimer =
		deps.clearTimer ??
		((id) => {
			clearTimeout(id as ReturnType<typeof setTimeout>);
		});
	const coalesceMs = deps.coalesceMs ?? DEFAULT_COALESCE_MS;

	let pendingTimer: unknown = null;

	const fireCoalesced = (): void => {
		pendingTimer = null;
		deps.requestRender();
	};

	const cancelPending = (): boolean => {
		if (pendingTimer === null) return false;
		clearTimer(pendingTimer);
		pendingTimer = null;
		return true;
	};

	return {
		applyEvent(event) {
			deps.chatPanel.applyEvent(event);
			if (DELTA_TYPES.has(event.type)) {
				if (pendingTimer !== null) return;
				pendingTimer = setTimer(fireCoalesced, coalesceMs);
				return;
			}
			cancelPending();
			deps.requestRender();
		},
		flush() {
			const wasPending = cancelPending();
			if (!wasPending) return;
			deps.requestRender();
		},
	};
}

/**
 * Options for the rehydrate helper used by /resume and /fork.
 */
export interface RehydrateChatPanelOptions {
	/**
	 * Stop replay after the matching turn id (inclusive). /fork passes the
	 * selected parent turn id so the new branch's chat panel shows only the
	 * pre-fork transcript. Unset (default) replays the entire list.
	 */
	uptoTurnId?: string;
}

function extractTurnText(payload: unknown): string {
	if (typeof payload === "string") return payload;
	if (!payload || typeof payload !== "object") return "";
	const p = payload as Record<string, unknown>;
	if (typeof p.text === "string") return p.text;
	if (Array.isArray(p.content)) {
		for (const block of p.content) {
			if (!block || typeof block !== "object") continue;
			const b = block as Record<string, unknown>;
			if (b.type === "text" && typeof b.text === "string") return b.text;
		}
	}
	return "";
}

/**
 * Rehydrate a chat panel from a persisted session's turn list. The
 * interactive layer calls this after /resume or /fork so the user sees the
 * prior transcript instead of a blank pane; without it, swapping the
 * session contract updated meta but left the visible chat untouched
 * (Row 51 and Row 52 on the Phase 12 ledger).
 *
 * Replays user and assistant message turns in file order. tool_call,
 * tool_result, system, and checkpoint turns are skipped in this pass: the
 * tool segments that chat-panel's `segments[]` model renders need the
 * paired start/update/end args+result stream that ClioTurnRecord does
 * not carry on its own. A later slice can thread richer replay once
 * SessionEntry storage captures tool-execution deltas.
 *
 * Pure except for the chat-panel calls: no I/O, no chat-loop events
 * wired. Callers read turns via `openSession(id).turns()` and pass them
 * in explicitly.
 */
export function rehydrateChatPanelFromTurns(
	chatPanel: ChatPanel,
	turns: ReadonlyArray<ClioTurnRecord>,
	options: RehydrateChatPanelOptions = {},
): void {
	const stopAt = options.uptoTurnId;
	for (const turn of turns) {
		if (turn.kind === "user") {
			const text = extractTurnText(turn.payload);
			if (text.length > 0) chatPanel.appendUser(text);
		} else if (turn.kind === "assistant") {
			const text = extractTurnText(turn.payload);
			if (text.length > 0) {
				const timestamp = Number.isNaN(Date.parse(turn.at)) ? 0 : Date.parse(turn.at);
				const message = {
					role: "assistant",
					content: [{ type: "text", text }],
					stopReason: "stop",
					timestamp,
				} as AgentMessage;
				chatPanel.applyEvent({ type: "message_end", message });
				chatPanel.applyEvent({ type: "agent_end", messages: [message] });
			}
		}
		if (stopAt !== undefined && turn.id === stopAt) break;
	}
}
