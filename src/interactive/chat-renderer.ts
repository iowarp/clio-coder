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
