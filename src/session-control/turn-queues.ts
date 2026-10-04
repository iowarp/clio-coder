/**
 * The steering queue Clio owns, and its hand-over to the engine.
 *
 * A message submitted while a run is active waits here, in enqueue order,
 * where the operator can still reorder, relabel or remove it. The engine's own
 * queues receive a message only at a steering slot: the top of `finishTurn`
 * (after a tool batch, before the next model call), the end of
 * `prepareNextTurn` (so a message typed during compaction rides Pi's second
 * poll), or just before a fresh prompt when the queue is flushed. Pi drains
 * everything it was handed in one poll (`steeringMode = "all"`), so N messages
 * land as N user messages before one model call. The transcript renders a
 * message when Pi injects it (message_end), never at enqueue, so the chat
 * order matches what the model saw.
 */

import { randomUUID } from "node:crypto";
import type { createEngineAgent } from "../engine/agent.js";
import type { AgentMessage } from "../engine/types.js";
import type { ChatTurnState } from "./turn-state.js";

type EngineAgent = ReturnType<typeof createEngineAgent>["agent"];

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
	/** Session-local id; the navigator and the producers address an entry by it. */
	id: string;
	display?: { text: string; note?: string };
	text: string;
	kind: QueuedMessageKind;
	/** Epoch milliseconds the operator submitted it. */
	enqueuedAt: number;
	/** Advisory labels a steering producer attached (`relation`, `urgency`, `producer`). */
	labels?: Readonly<Record<string, string>>;
	/** True once the operator set the kind by hand; a producer never relabels a pinned entry. */
	pinned?: boolean;
	/**
	 * Who submitted this entry when it was not the operator, in words for the
	 * transcript (a peer Clio's pane). It is persisted on the user turn, so a
	 * replay still says the prompt was not typed here. An entry with an origin
	 * is pinned: no producer may turn its follow-up into a steer or an
	 * interrupt.
	 */
	origin?: string;
	/**
	 * Paths whose content the expansion inlined into `text`. Their information-flow
	 * labels are absorbed when the entry is queued, since the text reaches the
	 * model at the next slot without passing the fresh-prompt path again.
	 */
	referencedPaths?: ReadonlyArray<string>;
}

/** Why an entry left the queue without being delivered by the engine. */
export type QueueRemovalReason = "removed" | "sent-now" | "to-editor" | "restored" | "cancelled" | "resubmitted";

/** Where a delivered entry was handed to the engine. */
export type QueueDeliveryPoint = "finish-turn" | "prepare-next-turn" | "prompt";

/**
 * What became of a queued entry, for the dataset that joins it to the steer
 * site's reading by the entry id. `waitedMs` is the time it spent queued.
 */
export type QueueEvent =
	| { type: "delivered"; entry: QueuedChatMessage; point: QueueDeliveryPoint; waitedMs: number }
	| { type: "removed"; entry: QueuedChatMessage; reason: QueueRemovalReason; waitedMs: number }
	| { type: "relabeled"; entry: QueuedChatMessage; by: "operator" | "producer" };

export interface QueueEnqueueOptions {
	front?: boolean;
	/** Machine provenance; see {@link QueuedChatMessage.origin}. */
	origin?: string;
	referencedPaths?: ReadonlyArray<string>;
}

export interface QueuedMessagesSnapshot {
	steer: ReadonlyArray<string>;
	followUp: ReadonlyArray<string>;
}

export interface TurnQueuesDeps {
	state: ChatTurnState;
	emitQueueUpdateEvent: (messages: QueuedChatMessage[]) => void;
	/**
	 * Fired at injection time, when the engine drains a handed-over message into
	 * the run (or the stranded fallback resubmits it). The transcript renders
	 * the user turn from this event; enqueue time shows the text only in the
	 * queue panel, so the chat order matches what the model actually saw.
	 */
	emitQueuedUserTurn: (entry: QueuedChatMessage) => void;
	emitNotice: (text: string) => void;
	/** What became of an entry; recording only, never consulted. */
	onEvent?: (event: QueueEvent) => void;
	/** Late-bound `ChatLoop.submit`; wired by the loop after API construction. */
	submit: (
		text: string,
		options?: { requestContinuation?: boolean; workingContextPaths?: ReadonlyArray<string>; origin?: string },
	) => Promise<void>;
	now?: () => number;
}

export interface TurnQueues {
	/** `front` puts the entry at the head of the queue: a send-now the operator chose to wait with. Null when nothing is running. */
	steer(text: string, display?: QueuedChatMessage["display"], options?: QueueEnqueueOptions): QueuedChatMessage | null;
	queueFollowUp(
		text: string,
		display?: QueuedChatMessage["display"],
		options?: QueueEnqueueOptions,
	): QueuedChatMessage | null;
	queuedMessages(): QueuedMessagesSnapshot;
	/** Copies of the entries still in Clio's hands, in delivery order. */
	entries(): QueuedChatMessage[];
	/** True while a next-slot message is queued or handed over but not yet injected. */
	hasPendingSteer(): boolean;
	removeEntry(id: string, reason?: QueueRemovalReason): QueuedChatMessage | null;
	/** Move one entry up (-1) or down (+1); false when it cannot move. */
	moveEntry(id: string, delta: -1 | 1): boolean;
	/** The operator's own choice of slot; pins the entry against producers. */
	setEntryKind(id: string, kind: QueuedMessageKind): boolean;
	/** A producer's advisory labels, and a new kind unless the operator pinned the entry. */
	relabel(id: string, labels: Readonly<Record<string, string>>, kind?: QueuedMessageKind): boolean;
	/** Drain Clio's queue, the in-flight list and both engine queues; returns the drained entries. */
	clearQueuedMirror(): QueuedChatMessage[];
	/**
	 * Hand next-slot entries to the engine after a tool batch, before Pi polls.
	 * At the run's final turn with nothing left to steer, end-of-turn entries
	 * go to the follow-up queue instead, so Pi carries the run on with them.
	 */
	handOverAtFinishTurn(final: boolean): void;
	/** Hand next-slot entries typed during a long preparation to Pi's second poll. */
	handOverAfterPrepareNextTurn(): void;
	/** Just before `agent.prompt`: a flush hands everything over so it lands with the first model call. */
	handOverBeforePrompt(agent: EngineAgent): void;
	/** Arm the next prompt to carry the whole queue (Alt+S with an empty draft; the stranded fallback). */
	flushOnNextPrompt(): void;
	/**
	 * The run was cancelled. Messages the engine was handed but never injected
	 * come back to the head of the queue. An interrupt holds the queue for the
	 * prompt that follows; any other cancel drops it, exactly as before, so a
	 * cancelled run never delivers or resubmits queued messages on its own.
	 */
	onRunCancelled(options: { hold: boolean }): void;
	/** True (and consumed) when the loop already persisted this exact user text. */
	consumePersistedEcho(text: string): boolean;
	markPersistedUserEcho(text: string, prompt: () => Promise<void>): Promise<void>;
	/** The engine injected this text: it leaves the queue panel and enters the transcript. Returns the entry it was. */
	acknowledgeInjected(text: string): QueuedChatMessage | null;
	/** Resubmit entries the run never took as a fresh prompt; true when one was sent. */
	resubmitStranded(): Promise<boolean>;
	resubmitRequestContinuation(): Promise<void>;
	reset(): void;
}

export function createTurnQueues(deps: TurnQueuesDeps): TurnQueues {
	const { state } = deps;
	const now = deps.now ?? (() => Date.now());
	// Entries still in Clio's hands, in delivery order.
	const queue: QueuedChatMessage[] = [];
	// Entries handed to the engine and not yet injected. Pi polls right after
	// each hand-over, so this is normally empty between slots; a cancel between
	// the two puts them back.
	const inFlight: QueuedChatMessage[] = [];
	const persistedUserEchoes: string[] = [];
	let sequence = 0;
	// Set by an interrupt: the queue waits for the fresh prompt instead of
	// being resubmitted by the cancelled run's settle.
	let held = false;
	let flushNext = false;

	const emitQueueUpdate = (): void => {
		deps.emitQueueUpdateEvent(queue.map((entry) => ({ ...entry })));
	};

	const toAgentMessage = (entry: QueuedChatMessage): AgentMessage =>
		({ role: "user", content: entry.text, timestamp: now() }) as AgentMessage;

	// Enqueue is silent in the transcript: the queue panel is the one signal
	// that a message is pending, exactly as pi-coding-agent's pending container
	// works. The former per-steer transcript notice duplicated the panel and
	// left a permanent line for a transient state.
	const enqueue = (
		text: string,
		kind: QueuedMessageKind,
		display?: QueuedChatMessage["display"],
		options?: QueueEnqueueOptions,
	): QueuedChatMessage | null => {
		// The payload crosses to the model exactly as it was submitted; only the
		// emptiness test reads a trimmed copy. A queued turn that shortened its own
		// text here would land in the ledger disagreeing with the expansion that
		// produced it, which is the same defect the persisted echo had (issue #244).
		if (text.trim().length === 0 || !state.streaming || !state.runtime) return null;
		sequence += 1;
		const paths = options?.referencedPaths ?? [];
		// Unique across sessions: the id is the join key between the steer site's
		// reading of this entry and the outcome rows written when it leaves.
		const entry: QueuedChatMessage = {
			id: `steer_${randomUUID().slice(0, 8)}_${sequence}`,
			text,
			kind,
			enqueuedAt: now(),
			...(display ? { display } : {}),
			...(paths.length > 0 ? { referencedPaths: [...paths] } : {}),
			...(options?.origin !== undefined ? { origin: options.origin, pinned: true } : {}),
		};
		if (options?.front === true) queue.unshift(entry);
		else queue.push(entry);
		emitQueueUpdate();
		return { ...entry };
	};

	const report = (event: QueueEvent): void => {
		try {
			deps.onEvent?.(event);
		} catch {
			// Recording never costs the queue operation it describes.
		}
	};
	const waited = (entry: QueuedChatMessage): number => Math.max(0, now() - entry.enqueuedAt);
	const removed = (entries: ReadonlyArray<QueuedChatMessage>, reason: QueueRemovalReason): void => {
		for (const entry of entries) report({ type: "removed", entry: { ...entry }, reason, waitedMs: waited(entry) });
	};

	const find = (id: string): number => queue.findIndex((entry) => entry.id === id);

	/** Hand every entry of `kind` to the engine; returns how many went. */
	const handOver = (agent: EngineAgent, kind: QueuedMessageKind, point: QueueDeliveryPoint): number => {
		const due = queue.filter((entry) => entry.kind === kind);
		if (due.length === 0) return 0;
		for (const entry of due) {
			queue.splice(queue.indexOf(entry), 1);
			inFlight.push(entry);
			if (kind === "steer") agent.steer(toAgentMessage(entry));
			else agent.followUp(toAgentMessage(entry));
			report({ type: "delivered", entry: { ...entry }, point, waitedMs: waited(entry) });
		}
		emitQueueUpdate();
		return due.length;
	};

	return {
		steer: (text, display, options) => enqueue(text, "steer", display, options),
		queueFollowUp: (text, display, options) => enqueue(text, "follow-up", display, options),
		queuedMessages(): QueuedMessagesSnapshot {
			return {
				steer: queue.filter((entry) => entry.kind === "steer").map((entry) => entry.text),
				followUp: queue.filter((entry) => entry.kind === "follow-up").map((entry) => entry.text),
			};
		},
		entries: () => queue.map((entry) => ({ ...entry })),
		hasPendingSteer: () =>
			queue.some((entry) => entry.kind === "steer") || inFlight.some((entry) => entry.kind === "steer"),
		removeEntry(id, reason = "removed") {
			const idx = find(id);
			if (idx < 0) return null;
			const [entry] = queue.splice(idx, 1);
			emitQueueUpdate();
			if (entry) removed([entry], reason);
			return entry ?? null;
		},
		moveEntry(id, delta) {
			const idx = find(id);
			const target = idx + delta;
			if (idx < 0 || target < 0 || target >= queue.length) return false;
			const [entry] = queue.splice(idx, 1);
			if (!entry) return false;
			queue.splice(target, 0, entry);
			emitQueueUpdate();
			return true;
		},
		setEntryKind(id, kind) {
			const entry = queue[find(id)];
			if (!entry) return false;
			entry.kind = kind;
			entry.pinned = true;
			emitQueueUpdate();
			report({ type: "relabeled", entry: { ...entry }, by: "operator" });
			return true;
		},
		relabel(id, labels, kind) {
			const entry = queue[find(id)];
			if (!entry) return false;
			entry.labels = { ...entry.labels, ...labels };
			if (kind !== undefined && entry.pinned !== true) entry.kind = kind;
			emitQueueUpdate();
			report({ type: "relabeled", entry: { ...entry }, by: "producer" });
			return true;
		},
		clearQueuedMirror(): QueuedChatMessage[] {
			const drained = [...inFlight.splice(0, inFlight.length), ...queue.splice(0, queue.length)];
			held = false;
			flushNext = false;
			if (state.runtime) {
				state.runtime.agent.clearAllQueues();
			}
			if (drained.length > 0) emitQueueUpdate();
			removed(drained, "restored");
			return drained;
		},
		handOverAtFinishTurn(final) {
			const agent = state.runtime?.agent;
			if (!agent || held) return;
			const steered = handOver(agent, "steer", "finish-turn");
			if (final && steered === 0) handOver(agent, "follow-up", "finish-turn");
		},
		handOverAfterPrepareNextTurn() {
			const agent = state.runtime?.agent;
			if (!agent || held) return;
			handOver(agent, "steer", "prepare-next-turn");
		},
		handOverBeforePrompt(agent) {
			held = false;
			if (!flushNext) return;
			flushNext = false;
			handOver(agent, "steer", "prompt");
			handOver(agent, "follow-up", "prompt");
		},
		flushOnNextPrompt() {
			flushNext = true;
		},
		onRunCancelled({ hold }) {
			const changed = inFlight.length > 0 || queue.length > 0;
			queue.unshift(...inFlight.splice(0, inFlight.length));
			if (!hold) removed(queue.splice(0, queue.length), "cancelled");
			held = hold && queue.length > 0;
			state.runtime?.agent.clearAllQueues();
			if (changed) emitQueueUpdate();
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
		acknowledgeInjected(text: string): QueuedChatMessage | null {
			let idx = inFlight.findIndex((entry) => entry.text === text);
			let entry: QueuedChatMessage | undefined;
			if (idx >= 0) {
				[entry] = inFlight.splice(idx, 1);
			} else {
				// Defensive: a text the engine produced from the queue without a
				// hand-over this module saw still leaves the panel.
				idx = queue.findIndex((candidate) => candidate.text === text);
				if (idx < 0) return null;
				[entry] = queue.splice(idx, 1);
				emitQueueUpdate();
			}
			// The engine just injected this message into the run: this is the
			// moment it moves from the queue panel into the transcript.
			if (entry) deps.emitQueuedUserTurn({ ...entry });
			return entry ?? null;
		},
		/**
		 * Stranded fallback. Hand-over happens at `finishTurn`, so a message can
		 * still be left behind only when it arrived after the run's final turn
		 * settled or when that turn ended in an error or an abort, where nothing
		 * is handed over. The entries become one fresh prompt: the first is the
		 * prompt text, the rest are handed to the engine just before it starts,
		 * so Pi's opening poll lands them with the same first model call, each as
		 * its own user message. A held queue (an interrupt is about to prompt)
		 * waits for that prompt instead.
		 */
		async resubmitStranded(): Promise<boolean> {
			if (held || queue.length === 0) return false;
			const first = queue.shift();
			if (!first) return false;
			state.pendingRequestContinuation = false;
			state.runtime?.agent.clearAllQueues();
			flushNext = queue.length > 0;
			emitQueueUpdate();
			deps.emitNotice("[Clio Coder] steering arrived as the run ended; resubmitting as a fresh prompt.");
			// The resubmit's own user echo is suppressed (markPersistedUserEcho), so
			// this is the only place the first text can enter the transcript; the
			// rest arrive through message_end like any handed-over message.
			deps.emitQueuedUserTurn({ ...first });
			removed([first], "resubmitted");
			await deps.submit(first.text, {
				...(first.referencedPaths && first.referencedPaths.length > 0
					? { workingContextPaths: first.referencedPaths }
					: {}),
				...(first.origin !== undefined ? { origin: first.origin } : {}),
			});
			return true;
		},
		async resubmitRequestContinuation(): Promise<void> {
			if (!state.pendingRequestContinuation) return;
			state.pendingRequestContinuation = false;
			await deps.submit("", { requestContinuation: true });
		},
		reset(): void {
			queue.length = 0;
			inFlight.length = 0;
			persistedUserEchoes.length = 0;
			held = false;
			flushNext = false;
			emitQueueUpdate();
		},
	};
}
