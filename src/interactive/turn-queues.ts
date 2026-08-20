/**
 * Steer/follow-up queue mirror and stranded-steer resubmission.
 *
 * The engine owns the real steering and follow-up queues; this module keeps
 * the UI mirror in enqueue order, tracks user texts the loop already
 * persisted itself (so message_end echoes are not double-appended), and
 * resubmits steers the engine never drained once a run settles.
 */

import type { AgentMessage } from "../engine/types.js";
import type { ChatTurnState } from "./turn-state.js";

/** Which engine queue a queued message rides: the steering queue or the follow-up queue. */
export type QueuedMessageKind = "steer" | "follow-up";

/**
 * Operator-chosen delivery point for a message submitted while a run is
 * active. `next-slot` rides the steering queue and lands between tool batches,
 * mid-run. `end-of-turn` rides the follow-up queue and lands when the whole run
 * settles and the agent would hand control back. `interrupt` cancels the
 * in-flight work and delivers now; it never enters a queue.
 */
export type SteeringMode = "interrupt" | "next-slot" | "end-of-turn";

export const DEFAULT_STEERING_MODE: SteeringMode = "next-slot";

export interface QueuedChatMessage {
	text: string;
	kind: QueuedMessageKind;
}

export interface QueuedMessagesSnapshot {
	steer: ReadonlyArray<string>;
	followUp: ReadonlyArray<string>;
}

export interface TurnQueuesDeps {
	state: ChatTurnState;
	emitQueueUpdateEvent: (messages: QueuedChatMessage[]) => void;
	/**
	 * Fired at injection time, when the engine drains a queued message into the
	 * run (or the stranded-steer fallback resubmits it). The transcript renders
	 * the user turn from this event; enqueue time shows the text only in the
	 * queue panel, so the chat order matches what the model actually saw.
	 */
	emitQueuedUserTurn: (entry: QueuedChatMessage) => void;
	emitNotice: (text: string) => void;
	/** Late-bound `ChatLoop.submit`; wired by the loop after API construction. */
	submit: (text: string, options?: { requestContinuation?: boolean }) => Promise<void>;
}

export interface TurnQueues {
	steer(text: string): boolean;
	queueFollowUp(text: string): boolean;
	queuedMessages(): QueuedMessagesSnapshot;
	/** Drain the mirror and both engine queues; returns the drained entries. */
	clearQueuedMirror(): QueuedChatMessage[];
	removeQueuedMirrorEntry(text: string): void;
	/** True (and consumed) when the loop already persisted this exact user text. */
	consumePersistedEcho(text: string): boolean;
	markPersistedUserEcho(text: string, prompt: () => Promise<void>): Promise<void>;
	/** Resubmit undrained steers as a fresh prompt; true when one was sent. */
	resubmitStrandedSteers(): Promise<boolean>;
	resubmitRequestContinuation(): Promise<void>;
	reset(): void;
}

export function createTurnQueues(deps: TurnQueuesDeps): TurnQueues {
	const { state } = deps;
	// UI mirror of both engine queues, in enqueue order. Entries leave when
	// the engine injects them into the transcript (message_end →
	// appendQueuedUserTurn), when alt+up restores them to the editor, or when
	// a cancel clears the run.
	const queuedMirror: QueuedChatMessage[] = [];
	const persistedUserEchoes: string[] = [];

	const emitQueueUpdate = (): void => {
		deps.emitQueueUpdateEvent(queuedMirror.map((entry) => ({ ...entry })));
	};

	// Enqueue is silent in the transcript: the queue panel is the one signal
	// that a message is pending, exactly as pi-coding-agent's pending container
	// works. The former per-steer transcript notice duplicated the panel and
	// left a permanent line for a transient state.
	const enqueue = (text: string, kind: QueuedMessageKind): boolean => {
		const trimmed = text.trim();
		if (trimmed.length === 0 || !state.streaming || !state.runtime) return false;
		const message = {
			role: "user",
			content: trimmed,
			timestamp: Date.now(),
		} as AgentMessage;
		queuedMirror.push({ text: trimmed, kind });
		if (kind === "steer") {
			state.runtime.agent.steer(message);
		} else {
			state.runtime.agent.followUp(message);
		}
		emitQueueUpdate();
		return true;
	};

	return {
		steer: (text) => enqueue(text, "steer"),
		queueFollowUp: (text) => enqueue(text, "follow-up"),
		queuedMessages(): QueuedMessagesSnapshot {
			return {
				steer: queuedMirror.filter((entry) => entry.kind === "steer").map((entry) => entry.text),
				followUp: queuedMirror.filter((entry) => entry.kind === "follow-up").map((entry) => entry.text),
			};
		},
		clearQueuedMirror(): QueuedChatMessage[] {
			const drained = queuedMirror.splice(0, queuedMirror.length);
			if (state.runtime) {
				state.runtime.agent.clearAllQueues();
			}
			if (drained.length > 0) emitQueueUpdate();
			return drained;
		},
		removeQueuedMirrorEntry(text: string): void {
			const idx = queuedMirror.findIndex((entry) => entry.text === text);
			if (idx < 0) return;
			const [entry] = queuedMirror.splice(idx, 1);
			emitQueueUpdate();
			// The engine just injected this message into the run: this is the
			// moment it moves from the queue panel into the transcript.
			if (entry) deps.emitQueuedUserTurn({ ...entry });
		},
		consumePersistedEcho(text: string): boolean {
			const idx = persistedUserEchoes.indexOf(text);
			if (idx < 0) return false;
			persistedUserEchoes.splice(idx, 1);
			return true;
		},
		async markPersistedUserEcho(text: string, prompt: () => Promise<void>): Promise<void> {
			persistedUserEchoes.push(text);
			try {
				await prompt();
			} finally {
				const idx = persistedUserEchoes.indexOf(text);
				if (idx >= 0) persistedUserEchoes.splice(idx, 1);
			}
		},
		/**
		 * Stranded-steer fallback. The engine inner loop drains steering messages
		 * after every tool batch, but the outer loop polls only follow-ups before
		 * `agent_end`, so a steer enqueued in the run's final moments (or during
		 * an error stop) is never injected. When the run settles with unconsumed
		 * steer mirror entries, clear them and resubmit the texts as a fresh
		 * prompt: exactly today's end-of-run delivery. Esc cancel clears both
		 * queues first, so a cancelled run never resubmits.
		 */
		async resubmitStrandedSteers(): Promise<boolean> {
			const stranded = queuedMirror.filter((entry) => entry.kind === "steer");
			if (stranded.length === 0) return false;
			for (const entry of stranded) {
				const idx = queuedMirror.indexOf(entry);
				if (idx >= 0) queuedMirror.splice(idx, 1);
			}
			state.pendingRequestContinuation = false;
			state.runtime?.agent.clearSteeringQueue();
			emitQueueUpdate();
			deps.emitNotice("[Clio Coder] steering arrived as the run ended; resubmitting as a fresh prompt.");
			// The resubmit's own user echo is suppressed (markPersistedUserEcho), so
			// this is the only place the stranded texts can enter the transcript.
			for (const entry of stranded) deps.emitQueuedUserTurn({ ...entry });
			await deps.submit(stranded.map((entry) => entry.text).join("\n\n"));
			return true;
		},
		async resubmitRequestContinuation(): Promise<void> {
			if (!state.pendingRequestContinuation) return;
			state.pendingRequestContinuation = false;
			await deps.submit("", { requestContinuation: true });
		},
		reset(): void {
			queuedMirror.length = 0;
			persistedUserEchoes.length = 0;
			emitQueueUpdate();
		},
	};
}
