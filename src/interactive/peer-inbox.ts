/**
 * The receiving end of the peer prompt inbox (src/domains/mux/peer-inbox.ts).
 *
 * A prompt that arrives here becomes a user turn through the same two doors
 * the operator's own text uses: `chat.submit` when nothing is running, the
 * follow-up queue when a run is. It is never typed, so no key handler and no
 * dialog can receive it. It is not run through the composer either, so it is
 * never parsed as a slash command and never reaches egg discovery, which only
 * the operator's live adapters call. What it asks the model to do is still
 * subject to the same permissions as any other turn in this session.
 *
 * A receipt is written only once the prompt is on one of those two paths, so
 * the sender's "accepted" means the peer has it, not that a file was written.
 *
 * An inbox belongs to one conversation. Every time the session under this
 * process is replaced or reopened (`/new`, `/resume`, a fork, a branch switch)
 * the inbox is retired and a new id advertised, and a request is judged
 * against the inbox it was written to, never against whichever one is current
 * by the time it is read. A prompt meant for one conversation therefore cannot
 * be delivered into another, including the one it came from after a round
 * trip away and back.
 */

import type { FSWatcher } from "node:fs";
import { readdirSync, watch } from "node:fs";
import { join } from "node:path";
import type { AgentStatusChangedPayload } from "../core/bus-events.js";
import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { MuxContract } from "../domains/mux/index.js";
import type { PeerReceipt, PeerRefusal } from "../domains/mux/peer-inbox.js";
import {
	claimPeerRequest,
	closePeerInbox,
	openPeerInbox,
	PEER_INBOX_TOKEN,
	parsePeerPromptRequest,
	sweepDeadPeerInboxes,
	writePeerReceipt,
} from "../domains/mux/peer-inbox.js";
import type { MuxLog } from "../domains/mux/types.js";
import type { ChatLoop } from "../session-control/chat-loop.js";

/** Backstop for filesystems that deliver no change events; the watcher is the fast path. */
const INBOX_POLL_MS = 250;
const REQUEST_NAME = /^[0-9a-f-]{36}$/u;

export interface PeerInboxDeps {
	bus: SafeEventBus;
	mux: MuxContract;
	chat: Pick<
		ChatLoop,
		"submit" | "queueFollowUp" | "isStreaming" | "turnPreparation" | "getSessionId" | "onSessionReset"
	>;
	/**
	 * Paint a prompt that starts a fresh turn into the transcript, with where
	 * it came from. A queued prompt is painted by the chat panel when the
	 * engine takes it; a fresh one is the caller's to show, as it is for the
	 * composer. It is called only once the turn is admitted, so a prompt the
	 * session declined never appears as if it had been asked.
	 */
	showTurn: (text: string, origin: string) => void;
	stateDir: string;
	log?: MuxLog;
}

export interface PeerInbox {
	dispose(): void;
}

/** What this session is doing, as a prompt's admission needs to know it. */
type ReceiverState = "idle" | "busy" | "blocked" | "unknown";

/** One advertised inbox. `live` turns false, for good, when the conversation it was opened for is left. */
interface Generation {
	id: string;
	dir: string;
	live: boolean;
	watcher: FSWatcher | null;
}

export function createPeerInbox(deps: PeerInboxDeps): PeerInbox | null {
	const log = deps.log ?? ((): void => undefined);
	const detection = deps.mux.detection();
	const paneId = detection.self.paneId;
	const socketPath = detection.socketPath;
	// Only a Clio that is a guest in a pane has a pane to advertise an inbox on.
	if (deps.mux.mode !== "guest" || paneId === null || socketPath === null) return null;

	let disposed = false;
	let lastPhase: AgentStatusChangedPayload["phase"] | null = null;
	let current: Generation | null = null;
	// Herdr publishes metadata asynchronously; an older request must finish
	// before the next generation (or disposal) can replace its advertisement.
	let publication: Promise<void> | null = null;
	const advertise = (value: string | null): void => {
		const publish = async (): Promise<void> => {
			await deps.mux.advertiseSelfToken(PEER_INBOX_TOKEN, value);
		};
		publication = (publication === null ? publish() : publication.then(publish)).catch((error: unknown) => {
			log("debug", `peer inbox advertisement failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	};
	/** Every generation this process opened, so each can be removed at quit and a late refusal still be read until then. */
	const generations: Generation[] = [];
	/**
	 * Answers whose receipt could not be written. The claim file on disk is what
	 * stops a second admission; this only lets a resend be told what happened.
	 */
	const unreceipted = new Map<string, PeerReceipt>();

	const state = (): ReceiverState => {
		if (disposed) return "unknown";
		// The status machine parks here while a tool call waits on the operator.
		if (lastPhase === "tool_blocked") return "blocked";
		if (deps.chat.isStreaming() || deps.chat.turnPreparation().phase !== "idle") return "busy";
		// No run and no preparation: the only phases that agree with that are the
		// resting ones. Anything else is a disagreement between two sources of
		// truth, and a prompt is not admitted on a guess.
		return lastPhase === null || lastPhase === "idle" || lastPhase === "ended" ? "idle" : "unknown";
	};

	const answer = (gen: Generation, receipt: PeerReceipt): void => {
		try {
			writePeerReceipt(gen.dir, receipt);
			unreceipted.delete(receipt.id);
		} catch (error) {
			// For an accepted prompt this leaves the sender at "unconfirmed", which
			// is the truth, and never at "not delivered".
			unreceipted.set(receipt.id, receipt);
			log("debug", `peer inbox could not write a receipt: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	const refuse = (gen: Generation, id: string, reason: PeerRefusal, detail: string): void =>
		answer(gen, { version: 1, id, status: "refused", reason, detail });
	const accept = (gen: Generation, id: string, via: "turn" | "queue"): void =>
		answer(gen, { version: 1, id, status: "accepted", via, sessionId: deps.chat.getSessionId() });

	const handle = (gen: Generation, id: string): void => {
		const claim = claimPeerRequest(gen.dir, id);
		if (claim === "gone") return;
		if (claim === "duplicate") {
			// This id was taken before, at any point in this inbox's life. It is
			// never admitted again; the most a resend gets is the earlier answer.
			const earlier = unreceipted.get(id);
			if (earlier) answer(gen, earlier);
			return;
		}
		// Judged against the inbox the request was written to. One retired while
		// this batch was being read is refused here, not carried into whatever
		// conversation replaced it.
		if (!gen.live) {
			refuse(gen, id, "stale-session", "this Clio left the conversation that inbox was advertised for");
			return;
		}
		const request = parsePeerPromptRequest(join(gen.dir, "claimed", id));
		if (request === null || request.id !== id) {
			refuse(gen, id, "invalid", "the request is not a well-formed prompt of at most 8192 bytes");
			return;
		}
		const now = state();
		if (now === "blocked") {
			refuse(gen, id, "blocked", "this Clio is waiting on its operator for an approval or an answer");
			return;
		}
		if (now === "unknown") {
			refuse(gen, id, "unknown-state", "this Clio cannot say what it is doing right now");
			return;
		}
		const origin = `machine prompt from Clio in pane ${request.fromPaneId || "unknown"}`;
		const display = { text: request.text, note: origin };
		if (now === "busy") {
			// A run is active: the prompt waits for the current turn to finish. It
			// is never a steer and never an interrupt, and once queued it stays an
			// ordinary follow-up whatever dialog opens before it is delivered.
			if (deps.chat.queueFollowUp(request.text, display, origin)) accept(gen, id, "queue");
			else refuse(gen, id, "busy", "a run is active and its follow-up queue did not take the prompt");
			return;
		}
		let admitted = false;
		let settled = false;
		const declined = (why: string): void => {
			if (!admitted && !settled) {
				settled = true;
				if (!gen.live || disposed) refuse(gen, id, "stale-session", "this Clio left the conversation before admission");
				else refuse(gen, id, "not-admitted", why);
			}
		};
		deps.chat
			.submit(request.text, {
				display,
				origin,
				isAdmissionCurrent: () => gen.live && !disposed,
				onAdmitted: () => {
					if (settled || admitted) return;
					if (!gen.live || disposed) {
						refuse(gen, id, "stale-session", "this Clio left the conversation before admission");
						settled = true;
						return;
					}
					admitted = true;
					deps.showTurn(request.text, origin);
					accept(gen, id, "turn");
				},
			})
			// A submit that settles without ever owning the turn was declined by the
			// session's own admission (a failed preflight, a refused target). That
			// is an answer, and the sender gets it instead of waiting on nothing.
			.then(
				() => declined("this Clio's admission declined the turn"),
				(error: unknown) =>
					declined(`the turn was not admitted: ${error instanceof Error ? error.message : String(error)}`),
			);
	};

	const drain = (gen: Generation): void => {
		if (disposed) return;
		try {
			// A sender's atomic write stages a temp file beside the request; only
			// the renamed, final name is a request.
			for (const name of readdirSync(join(gen.dir, "requests"))) {
				if (REQUEST_NAME.test(name)) handle(gen, name);
			}
		} catch (error) {
			// Runs inside a watcher callback and a timer: nothing thrown here may
			// reach the event loop. A missing directory is an inbox closed under us.
			log("debug", `peer inbox drain failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const open = (): void => {
		try {
			sweepDeadPeerInboxes(deps.stateDir, readdirSync(join(deps.stateDir, "peer-inbox")));
		} catch {
			// No inbox directory yet; there is nothing to sweep.
		}
		const opened = openPeerInbox(deps.stateDir, { paneId, socketPath, pid: process.pid });
		const gen: Generation = { ...opened, live: true, watcher: null };
		try {
			gen.watcher = watch(join(gen.dir, "requests"), () => drain(gen));
			gen.watcher.on("error", () => undefined);
		} catch {
			// The poll below still delivers; the watcher only makes it prompt.
		}
		generations.push(gen);
		current = gen;
		advertise(gen.id);
	};

	/** The conversation changed: nothing more is admitted through the old inbox, and a new one is advertised. */
	const rotate = (): void => {
		if (disposed) return;
		const old = current;
		if (old !== null) {
			old.live = false;
			old.watcher?.close();
			old.watcher = null;
			// Whatever a sender wrote before it could learn of the change is
			// claimed and refused now, against the inbox it was written to.
			drain(old);
		}
		try {
			open();
		} catch (error) {
			current = null;
			advertise(null);
			log("warning", `peer inbox unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const unsubscribeReset = deps.chat.onSessionReset?.(rotate);
	const unsubscribers = [
		deps.bus.on(BusChannels.AgentStatusChanged, (payload) => {
			lastPhase = payload.phase;
		}),
		// Park/resume invalidate during a switch, before replay finishes. The
		// shared reset barrier also covers /new before any session exists and
		// branch navigation, without invalidating ordinary first-turn creation.
		deps.bus.on(BusChannels.SessionParked, rotate),
		deps.bus.on(BusChannels.SessionResumed, rotate),
		...(unsubscribeReset ? [unsubscribeReset] : []),
	];

	try {
		open();
	} catch (error) {
		log("warning", `peer inbox unavailable: ${error instanceof Error ? error.message : String(error)}`);
		for (const unsubscribe of unsubscribers) unsubscribe();
		return null;
	}
	const interval = setInterval(() => {
		if (current !== null) drain(current);
	}, INBOX_POLL_MS);
	interval.unref?.();
	// A crash skips dispose; the exit event still removes the directories, and
	// a dead owner is refused by every sender and swept by the next Clio.
	const removeAll = (): void => {
		for (const gen of generations.splice(0)) {
			gen.live = false;
			gen.watcher?.close();
			closePeerInbox(gen.dir);
		}
	};
	process.once("exit", removeAll);

	return {
		dispose(): void {
			if (disposed) return;
			disposed = true;
			clearInterval(interval);
			for (const unsubscribe of unsubscribers) unsubscribe();
			process.off("exit", removeAll);
			advertise(null);
			current = null;
			removeAll();
		},
	};
}
