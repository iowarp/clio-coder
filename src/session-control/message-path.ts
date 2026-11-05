/**
 * The journal of what became of each operator message: submitted or queued, held, handed to the engine at which
 * slot, carried by which provider call, or removed and why. Recording only, and host-side only: the id never enters
 * a request, so a path cannot change what a provider caches, and no message text reaches a row.
 */

import { performance } from "node:perf_hooks";
import type { TelemetryContext } from "../core/telemetry/context.js";
import { mainAgent } from "../core/telemetry/context.js";
import type { JournalEmissionTiming } from "../core/telemetry/hub.js";
import { telemetryHub } from "../core/telemetry/hub.js";
import type { CallSettled, MessageStepped } from "../core/telemetry/schemas.js";
import type { QueuedChatMessage, QueueEvent } from "./turn-queues.js";

/** A first prompt can step before its session exists, and a host with no session never has one. */
const UNOWNED_ROW_LIMIT = 64;
/** Messages the run took and no sent request has carried yet; a run that dies keeps them for the next call. */
const WAITING_LIMIT = 256;

interface PathMessage {
	id: string;
	submittedAt: number;
}

type RowFacts = Omit<MessageStepped, "messageId" | "submittedAt">;

export interface MessagePathDeps {
	sessionId: () => string | null;
	turnId: () => string | null;
}

export interface MessagePath {
	submitted(message: PathMessage, facts: { chars: number; by: "operator" | "machine" } & JournalEmissionTiming): void;
	/** The prompt reached the engine. */
	prompted(message: PathMessage): void;
	neverStarted(message: PathMessage): void;
	queueEvent(event: QueueEvent): void;
	requestSent(call: { callId: string; attemptId: string; attempt: number; context: TelemetryContext }): void;
	callSettled(facts: CallSettled): void;
}

export function createMessagePath(deps: MessagePathDeps): MessagePath {
	const unowned: Array<{ row: MessageStepped; turnId: string | null; timing: JournalEmissionTiming }> = [];
	// The session a message first stepped in owns its whole path, whichever session is current when it ends.
	const owners = new Map<string, string>();
	const lanes = new Map<string, QueuedChatMessage["kind"]>();
	const waiting = new Map<string, PathMessage>();
	let riding: { callId: string; messages: Map<string, PathMessage> } | null = null;

	const contextFor = (sessionId: string, turnId: string | null): TelemetryContext => ({
		sessionId,
		agent: mainAgent(sessionId),
		...(turnId === null ? {} : { turnId }),
	});

	const write = (
		message: PathMessage,
		facts: RowFacts,
		timing?: JournalEmissionTiming,
		given?: TelemetryContext,
	): void => {
		const row: MessageStepped = { messageId: message.id, submittedAt: message.submittedAt, ...facts };
		const current = deps.sessionId();
		const sessionId = given?.sessionId ?? owners.get(message.id) ?? current;
		if (sessionId === null) {
			if (unowned.length < UNOWNED_ROW_LIMIT)
				unowned.push({
					row,
					turnId: deps.turnId(),
					timing: timing ?? { wallMs: Date.now(), mono: performance.now() },
				});
			return;
		}
		if (current !== null)
			for (const held of unowned.splice(0)) {
				owners.set(held.row.messageId, current);
				telemetryHub().emit("message.stepped", held.row, contextFor(current, held.turnId), held.timing);
			}
		owners.set(message.id, sessionId);
		// Recording never costs the turn it describes; the journal reports its own write gaps.
		telemetryHub().emit("message.stepped", row, given ?? contextFor(sessionId, deps.turnId()), timing);
	};

	const forget = (id: string): void => {
		owners.delete(id);
		lanes.delete(id);
		waiting.delete(id);
	};

	const awaitCarriage = (message: PathMessage): void => {
		waiting.set(message.id, message);
		if (waiting.size > WAITING_LIMIT) {
			const oldest = waiting.keys().next().value;
			if (oldest !== undefined) forget(oldest);
		}
	};

	const of = (entry: QueuedChatMessage): PathMessage => ({ id: entry.id, submittedAt: entry.enqueuedAt });

	return {
		submitted(message, { chars, by, wallMs, mono }) {
			write(message, { step: "submitted", lane: "prompt", chars, by }, { wallMs, mono });
		},
		prompted(message) {
			write(message, { step: "handed-over", slot: "prompt", lane: "prompt" });
			awaitCarriage(message);
		},
		neverStarted(message) {
			write(message, { step: "removed", reason: "not-started" });
			forget(message.id);
		},
		queueEvent(event) {
			const { entry } = event;
			const message = of(entry);
			switch (event.type) {
				case "queued":
					lanes.set(entry.id, entry.kind);
					write(message, {
						step: "queued",
						lane: entry.kind,
						chars: entry.text.length,
						by: entry.origin === undefined ? "operator" : "machine",
					});
					return;
				case "relabeled":
					// A producer's labels often leave the lane alone; only a change is a step of the path.
					if (lanes.get(entry.id) === entry.kind) return;
					lanes.set(entry.id, entry.kind);
					write(message, { step: "lane-changed", lane: entry.kind, changedBy: event.by });
					return;
				case "held":
					write(message, { step: "held", why: event.why });
					return;
				case "released":
					write(message, { step: "released" });
					return;
				case "delivered":
					write(message, { step: "handed-over", slot: event.point, lane: entry.kind });
					return;
				case "returned":
					write(message, { step: "returned", why: event.why });
					return;
				case "injected":
					awaitCarriage(message);
					return;
				case "removed":
					write(message, { step: "removed", reason: event.reason });
					// A send-now or a resubmit goes on as a prompt under the same id, in the same session.
					if (event.reason !== "sent-now" && event.reason !== "resubmitted") forget(entry.id);
					return;
			}
		},
		requestSent({ callId, attemptId, attempt, context }) {
			if (riding?.callId !== callId) riding = { callId, messages: riding?.messages ?? new Map() };
			for (const [id, message] of waiting) {
				waiting.delete(id);
				// History of another session went with that session; this request does not carry it.
				if (owners.get(id) === context.sessionId || !owners.has(id)) riding.messages.set(id, message);
				else forget(id);
			}
			for (const message of riding.messages.values())
				write(message, { step: "carried", callId, attemptId, attempt }, undefined, {
					...context,
					callId,
					attemptId,
				} as TelemetryContext);
		},
		callSettled({ callId, disposition, stop }) {
			if (riding?.callId !== callId) return;
			const { messages } = riding;
			riding = null;
			// A provider error also settles with a response; only a call that was answered ends the message's path.
			const answered = (disposition === "settled" || disposition === "settled_no_usage") && stop.failure === undefined;
			for (const [id, message] of messages) {
				if (answered) forget(id);
				// The message stays in the run's history, so the next request that leaves carries it again.
				else waiting.set(id, message);
			}
		},
	};
}
