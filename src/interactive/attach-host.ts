/**
 * `/attach` in the terminal: the host end of an attached second terminal.
 *
 * Nothing listens until the operator runs `/attach observe|approve|pair`; the
 * word sets the highest role this session admits, and `/attach off` closes the
 * socket and drops every client. The ceiling lives in this process only: it is
 * not a setting and does not survive a session change, which closes attach.
 *
 * What each role reaches here is what the operator at this terminal already
 * has, through the same doors:
 *
 * - observer: the transcript of the active branch (replayed, then each block as
 *   the ledger records it), the agent's status phase, and the approval card on
 *   screen as its sanitized view.
 * - approver: answers that card by request id, exactly as Enter or Escape would,
 *   recorded with `decidedBy: attach:<client>` on the approval journal. A card
 *   that is not on screen cannot be answered, so a stale id changes nothing.
 * - pair: also speaks. While a run is going the text is a steer for the next
 *   slot; when idle it starts a turn; while a card is open it is refused. It is
 *   plain text and never a slash command, and it is shown with who sent it.
 */

import type { TelemetryHub } from "../core/telemetry/hub.js";
import type { AttachHost, AttachOperations, AttachSessionPort, AttachTransport } from "../domains/attach/host.js";
import { createAttachHost } from "../domains/attach/host.js";
import type { AttachBlock, AttachRole } from "../domains/attach/protocol.js";
import { attachApprovalView } from "../domains/attach/protocol.js";
import { createUnixSocketTransport } from "../domains/attach/socket.js";
import type { SessionContract } from "../domains/session/contract.js";
import { transcriptBlocks } from "../domains/session/transcript-export.js";
import type { ChatLoop } from "../session-control/chat-loop.js";
import type { OverlayPermissionLifecycle } from "./overlay-permission-lifecycle.js";

/** Backstop for blocks recorded between status changes; status changes are the fast path. */
const REFRESH_MS = 1_000;

export interface AttachControllerDeps {
	bus: Pick<TelemetryHub, "subscribe">;
	chat: Pick<ChatLoop, "submit" | "steer" | "isStreaming" | "turnPreparation" | "getSessionId" | "onSessionReset">;
	session?: Pick<SessionContract, "readEntries" | "leafId" | "current">;
	/** The approval card seam; read at each use, since the overlay controller is built after this. */
	cards(): Pick<OverlayPermissionLifecycle, "cardOnScreen" | "answerOnScreen" | "onCardShown">;
	notice(level: "info" | "warn", text: string): void;
	/** Paint a pair message that started a turn, with who sent it. */
	showTurn(text: string, origin: string): void;
	transport?: (sessionId: string) => AttachTransport;
}

export interface AttachController extends AttachOperations {
	dispose(): void;
}

interface Open {
	sessionId: string;
	host: AttachHost;
	address: string;
	close(): void;
	timer: ReturnType<typeof setInterval>;
	unsubscribeCards: () => void;
}

const ROLE_WORD: Readonly<Record<AttachRole, string>> = { observer: "observe", approver: "approve", pair: "pair" };

export function createAttachController(deps: AttachControllerDeps): AttachController {
	let ceiling: AttachRole | null = null;
	const consentListeners = new Set<() => void>();
	let open: Open | null = null;
	let opening = false;
	let disposed = false;
	let lastPhase = "idle";
	/** Transcript blocks every attached client already has. */
	let sent = 0;
	/** Cards published as open and not yet published as closed. */
	const openCards = new Set<string>();

	const sessionId = (): string | null => deps.chat.getSessionId() ?? deps.session?.current()?.id ?? null;
	const readBlocks = (): AttachBlock[] => {
		const id = sessionId();
		if (id === null || deps.session === undefined) return [];
		return transcriptBlocks({
			sessionId: id,
			exportedAt: "",
			entries: deps.session.readEntries(),
			leafTurnId: deps.session.leafId(),
		}).blocks;
	};
	/** Publish what the ledger recorded since the last look, and return the whole branch. */
	const refresh = (): AttachBlock[] => {
		const blocks = readBlocks();
		if (open !== null && blocks.length > sent) {
			for (const block of blocks.slice(sent)) open.host.publish({ v: 1, type: "block", block });
		}
		// A compaction or branch move shortens the branch; what follows it is new from there.
		sent = blocks.length;
		return blocks;
	};

	const port: AttachSessionPort = {
		sessionId,
		transcript: refresh,
		status: () => ({ phase: lastPhase }),
		pendingApprovals: () => {
			const card = deps.cards().cardOnScreen();
			return card === null ? [] : [attachApprovalView(card)];
		},
		resolveApproval: (requestId, decision, by) =>
			deps.cards().answerOnScreen(requestId, decision, `attach:${by.clientId}`)
				? { status: "resolved" }
				: { status: "stale" },
		say: (text, by) => {
			const origin = `attach pair ${by.clientId}${by.label !== undefined ? ` (${by.label})` : ""}`;
			if (deps.cards().cardOnScreen() !== null || lastPhase === "tool_blocked")
				return { status: "refused", detail: "an approval card is open on the host; it is answered first" };
			if (deps.chat.isStreaming() || deps.chat.turnPreparation().phase !== "idle") {
				return deps.chat.steer(text, { text, note: origin })
					? { status: "accepted", via: "steer" }
					: { status: "refused", detail: "the session is between runs; send it again in a moment" };
			}
			const at = open;
			return new Promise((resolve) => {
				let settled = false;
				const settle = (outcome: { status: "accepted"; via: string } | { status: "refused"; detail: string }) => {
					if (settled) return;
					settled = true;
					resolve(outcome);
				};
				deps.chat
					.submit(text, {
						display: { text, note: origin },
						origin,
						isAdmissionCurrent: () => open === at && !disposed,
						onAdmitted: () => {
							if (settled) return;
							deps.showTurn(text, origin);
							settle({ status: "accepted", via: "turn" });
						},
					})
					.then(
						() => settle({ status: "refused", detail: "the session's admission declined the turn" }),
						(error: unknown) =>
							settle({
								status: "refused",
								detail: `the turn was not admitted: ${error instanceof Error ? error.message : String(error)}`,
							}),
					);
			});
		},
	};

	const stop = (reason: string): void => {
		const current = open;
		if (current === null) return;
		open = null;
		clearInterval(current.timer);
		current.unsubscribeCards();
		current.host.close(reason);
		current.close();
		openCards.clear();
	};

	const unsubscribers = [
		deps.bus.subscribe("agent.status_changed", (payload) => {
			lastPhase = payload.phase;
			if (open === null) return;
			refresh();
			open.host.publish({ v: 1, type: "status", status: { phase: lastPhase } });
			if (lastPhase !== "idle" && lastPhase !== "ended") return;
			// A run that ended took its parked calls with it; a card it left behind is gone.
			const onScreen = deps.cards().cardOnScreen()?.requestId;
			for (const requestId of [...openCards]) {
				if (requestId === onScreen) continue;
				openCards.delete(requestId);
				open.host.publish({ v: 1, type: "approval.closed", requestId, status: "expired" });
			}
		}),
		deps.bus.subscribe("approval.resolved", (payload) => {
			if (open === null || typeof payload.requestId !== "string" || !openCards.delete(payload.requestId)) return;
			open.host.publish({
				v: 1,
				type: "approval.closed",
				requestId: payload.requestId,
				status: payload.status,
				...(payload.decidedBy !== undefined ? { decidedBy: payload.decidedBy } : {}),
			});
		}),
	];
	const sessionLeft = (): void => {
		if (open === null) return;
		ceiling = null;
		stop("the host left this session");
		deps.notice("info", "attach closed: this terminal left the session it was open for; run /attach again to reopen");
	};
	unsubscribers.push(deps.bus.subscribe("session.parked", sessionLeft));
	unsubscribers.push(deps.bus.subscribe("session.reattached", sessionLeft));
	const unsubscribeReset = deps.chat.onSessionReset?.(sessionLeft);
	if (unsubscribeReset) unsubscribers.push(unsubscribeReset);

	const command = (id: string, role: AttachRole): string =>
		`clio-coder session attach ${id}${role === "observer" ? "" : ` --role ${role}`}`;

	return {
		async admit(role) {
			if (disposed) return { level: "error", text: "attach is unavailable while the terminal shuts down" };
			if (role === null) {
				ceiling = null;
				if (open === null) return { level: "info", text: "attach is already off" };
				stop("the host stopped admitting attach clients");
				return { level: "info", text: "attach off: the socket is closed and every client was dropped" };
			}
			const id = sessionId();
			if (id === null) return { level: "warn", text: "no session yet: send a first message, then run /attach" };
			if (opening) return { level: "warn", text: "attach is still opening; run /attach again in a moment" };
			ceiling = role;
			if (open !== null) {
				for (const listener of consentListeners) listener();
				return {
					level: "info",
					text: `attach now admits up to ${role}; ${open.host.presence().length} attached. Join with: ${command(id, role)}`,
				};
			}
			opening = true;
			const host = createAttachHost({
				session: port,
				consent: {
					ceiling: () => ceiling,
					subscribe: (listener) => {
						consentListeners.add(listener);
						return () => consentListeners.delete(listener);
					},
				},
				notice: deps.notice,
			});
			try {
				const transport = (deps.transport ?? createUnixSocketTransport)(id);
				const listener = await transport.listen((connection) => host.connect(connection));
				if (disposed || ceiling === null) {
					host.close("the host stopped admitting attach clients");
					listener.close();
					return { level: "info", text: "attach off" };
				}
				sent = readBlocks().length;
				const timer = setInterval(() => {
					if (open !== null && open.host.presence().length > 0) refresh();
				}, REFRESH_MS);
				timer.unref?.();
				const unsubscribeCards = deps.cards().onCardShown((view) => {
					if (open === null) return;
					openCards.add(view.requestId);
					open.host.publish({ v: 1, type: "approval.open", request: attachApprovalView(view) });
				});
				open = { sessionId: id, host, address: listener.address, close: listener.close, timer, unsubscribeCards };
				return {
					level: role === "observer" ? "info" : "warn",
					text: `attach open, up to ${role}, at ${listener.address}. Join from another terminal on this host or over ssh: ${command(id, role)}. /attach off closes it`,
				};
			} catch (error) {
				host.close("the host could not open attach");
				ceiling = null;
				return {
					level: "error",
					text: `attach could not open: ${error instanceof Error ? error.message : String(error)}`,
				};
			} finally {
				opening = false;
			}
		},
		status() {
			if (open === null || ceiling === null)
				return "attach is off. /attach observe, /attach approve or /attach pair opens it for this session";
			const clients = open.host.presence();
			const listing =
				clients.length === 0
					? "nobody attached"
					: clients
							.map((client) => `${client.clientId}${client.label !== undefined ? ` (${client.label})` : ""} ${client.role}`)
							.join(", ");
			return `attach open (/attach ${ROLE_WORD[ceiling]}) at ${open.address}: ${listing}. Join with: ${command(open.sessionId, ceiling)}`;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			stop("the host terminal is exiting");
			for (const unsubscribe of unsubscribers) unsubscribe();
			consentListeners.clear();
		},
	};
}
