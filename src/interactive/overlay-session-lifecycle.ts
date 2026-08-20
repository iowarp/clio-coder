import { resolveSessionCwd } from "../domains/session/cwd-fallback.js";
import type { SessionContract, SessionEntry } from "../domains/session/index.js";
import type { TUI } from "../engine/tui.js";
import type { ChatLoop } from "./chat-loop.js";
import type { ChatPanel } from "./chat-panel.js";
import { buildReplayAgentMessagesFromTurns, rehydrateChatPanelFromTurns } from "./chat-renderer.js";
import { emitCommandNotice } from "./command-fallbacks.js";
import type { InteractiveNoticeLevel } from "./interactive-subscriptions.js";
import type { OverlayTransitions } from "./overlay-transitions.js";
import { openCwdFallbackOverlay } from "./overlays/cwd-fallback.js";
import { openMessagePickerOverlay } from "./overlays/message-picker.js";
import { openSessionOverlay } from "./overlays/session-selector.js";
import { openTreeOverlay } from "./overlays/tree-selector.js";
import { lastTurnSummaryFromLedger } from "./session-last-turn.js";
import { settleChatBeforeSessionSwitch } from "./session-switch-settlement.js";
import { reseedSessionUsageFromLedger, type SessionUsageSink } from "./session-usage-reseed.js";
import type { SlashCommandContext } from "./slash-commands.js";
import type { TurnSummary } from "./status/index.js";

export interface OverlaySessionLifecycleDeps {
	tui: TUI;
	transitions: OverlayTransitions;
	session?: SessionContract;
	chat: Pick<ChatLoop, "cancel" | "isStreaming" | "resetForSession" | "whenSettled">;
	chatPanel: ChatPanel;
	/** The one transcript reset: the panel plus every view folded alongside it. */
	resetTranscript(): void;
	readStructuredEntries(sessionId: string): SessionEntry[];
	getSlashNotice(): SlashCommandContext["notice"];
	onResumeSession?(sessionId: string): void;
	onForkSession?(parentTurnId: string): void;
	announceTaskMemorySeedOffer(): void;
	/**
	 * Running usage totals, reseeded whenever the session under them changes.
	 * Without this a resumed session renders the previous session's numbers
	 * under the resumed session's id.
	 */
	sessionUsage?: SessionUsageSink;
	/**
	 * The footer's last-turn line, rescoped alongside those totals. Without it a
	 * `/tree` switch left the line describing a turn on the branch the reader had
	 * just left, beside a Σ total that had already moved.
	 */
	setLastTurnSummary?(summary: TurnSummary | null): void;
	refreshFooter(): void;
	requestRender(): void;
	stderr(text: string): void;
	notify(level: InteractiveNoticeLevel, text: string, key?: string): void;
	openSessionOverlay?: typeof openSessionOverlay;
	openTreeOverlay?: typeof openTreeOverlay;
	openMessagePickerOverlay?: typeof openMessagePickerOverlay;
	openCwdFallbackOverlay?: typeof openCwdFallbackOverlay;
}

export interface OverlaySessionLifecycle {
	openResume(): void;
	openTree(): void;
	openMessagePicker(): void;
}

/**
 * The target and model a session started under, so reseeded calls land in the
 * same `/cost` bucket the live path writes to. Without it a single target read
 * as two providers, one under the target id and one under the runtime name.
 */
function sessionUsageDefaults(session: SessionContract): { target?: string | null; model?: string | null } {
	const meta = session.current() as { target?: string | null; model?: string | null } | null | undefined;
	return { target: meta?.target ?? null, model: meta?.model ?? null };
}

function restorePriorSessionOrReopen(
	preResumeSessionId: string | null,
	deps: { session: SessionContract; reopen: () => void; onWarning: (message: string) => void },
): void {
	const currentId = deps.session.current()?.id ?? null;
	if (preResumeSessionId && preResumeSessionId !== currentId) {
		try {
			deps.session.switchBranch(preResumeSessionId);
		} catch (error) {
			deps.onWarning(
				`[cwd-fallback] could not restore prior session: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
		return;
	}
	deps.reopen();
}

export function createOverlaySessionLifecycle(deps: OverlaySessionLifecycleDeps): OverlaySessionLifecycle {
	/**
	 * Point every running number the footer and `/cost` show at one branch. The
	 * session total and the last-turn line are read off the same lineage in the
	 * same call, so a switch cannot move one and leave the other behind.
	 */
	function rescopeToBranch(session: SessionContract, turns: SessionEntry[], leafTurnId: string | null): void {
		const defaults = sessionUsageDefaults(session);
		if (deps.sessionUsage) reseedSessionUsageFromLedger(deps.sessionUsage, turns, defaults, leafTurnId);
		deps.setLastTurnSummary?.(lastTurnSummaryFromLedger(turns, defaults, leafTurnId));
	}

	const openResumeOverlay = deps.openSessionOverlay ?? openSessionOverlay;
	const openTreeSelector = deps.openTreeOverlay ?? openTreeOverlay;
	const openMessagePicker = deps.openMessagePickerOverlay ?? openMessagePickerOverlay;
	const openCwdFallback = deps.openCwdFallbackOverlay ?? openCwdFallbackOverlay;

	function openResume(): void {
		if (deps.transitions.state !== "closed") return;
		if (!deps.session) {
			emitCommandNotice(deps.getSlashNotice(), "error", "resume", "session contract unavailable");
			return;
		}
		const session = deps.session;
		const preResumeSessionId = session.current()?.id ?? null;
		deps.transitions.state = "resume";
		deps.transitions.handle = openResumeOverlay(deps.tui, {
			session,
			onResume: async (sessionId) => {
				const settlement = settleChatBeforeSessionSwitch(deps.chat);
				if (settlement) await settlement;
				deps.onResumeSession?.(sessionId);
				// onResumeSession (wired to session.resume) catches and stderr-logs
				// its own failure rather than throwing here, so this is the only
				// signal available: a successful switch always leaves session.current()
				// pointing at the requested id. Without this check, a failed switch
				// still replayed the target's transcript and moved the chat leaf to
				// it while session.current() stayed on the session the operator
				// started on (issue #93), so the next message was appended with a
				// parent turn from a session that was never actually opened.
				if (session.current()?.id !== sessionId) {
					emitCommandNotice(
						deps.getSlashNotice(),
						"error",
						"resume",
						`could not switch to that session; staying on ${preResumeSessionId ?? "no session"}`,
					);
					deps.refreshFooter();
					deps.requestRender();
					return;
				}
				try {
					const turns = deps.readStructuredEntries(sessionId);
					// The leaf is read before the transcript is rebuilt because it is
					// what the rebuild has to follow. resolveLeafOnOpen prefers a
					// persisted `/tree` pin over the newest turn, so a session resumed
					// on a pin extends from the pinned turn while the file still holds
					// the abandoned branch after it. Replaying the file unfiltered
					// rendered those abandoned turns as ordinary history above the
					// prompt, disagreeing with the branch the next message parents onto
					// and with the tip `/tree` marks (issue #107). The `/tree` switch
					// path below has always scoped its replay to the selected turn;
					// this is the same active-path filter, rooted at the leaf resume
					// actually landed on.
					const leafTurnId = session.tree(sessionId).leafId;
					// activeLeafTurnId, not uptoTurnId: this is a live branch about to
					// be extended, so sidecars anchored to a path turn but written
					// after it (a compaction summary covering the leaf, above all)
					// still belong on screen. uptoTurnId is the historical-truncation
					// variant `/tree` uses.
					const replayOptions = leafTurnId ? { activeLeafTurnId: leafTurnId } : {};
					deps.resetTranscript();
					rehydrateChatPanelFromTurns(deps.chatPanel, turns, replayOptions);
					const replayMessages = buildReplayAgentMessagesFromTurns(turns, replayOptions);
					deps.chat.resetForSession(leafTurnId, replayMessages);
					rescopeToBranch(session, turns, leafTurnId);
				} catch (error) {
					deps.stderr(`[/resume] transcript replay failed: ${error instanceof Error ? error.message : String(error)}\n`);
				}
				if (sessionId !== preResumeSessionId) {
					deps.announceTaskMemorySeedOffer();
				}
				deps.refreshFooter();
				deps.requestRender();
			},
			onClose: () => {
				deps.transitions.close();
				queueMicrotask(() => {
					const current = session.current();
					if (!current || current.id === preResumeSessionId) return;
					const probe = resolveSessionCwd(current);
					if (probe.ok) return;
					openCwdFallbackState({
						sessionCwd: typeof current.cwd === "string" ? current.cwd : "",
						reason: probe.reason,
						preResumeSessionId,
					});
				});
			},
		});
		deps.requestRender();
	}

	function openTree(): void {
		if (deps.transitions.state !== "closed") return;
		if (!deps.session) {
			deps.notify("error", "tree unavailable: session contract is not wired", "tree:unavailable");
			return;
		}
		const session = deps.session;
		deps.transitions.state = "tree";
		deps.transitions.handle = openTreeSelector(deps.tui, {
			session,
			onSwitchTurn: async (turnId) => {
				const settlement = settleChatBeforeSessionSwitch(deps.chat);
				if (settlement) await settlement;
				try {
					session.switchTurn(turnId);
					const sessionId = session.current()?.id ?? null;
					if (!sessionId) throw new Error("no current session after turn switch");
					const turns = deps.readStructuredEntries(sessionId);
					deps.resetTranscript();
					rehydrateChatPanelFromTurns(deps.chatPanel, turns, { uptoTurnId: turnId });
					const replayMessages = buildReplayAgentMessagesFromTurns(turns, { uptoTurnId: turnId });
					deps.chat.resetForSession(turnId, replayMessages);
					// The same branch the transcript above was just scoped to. Without the
					// leaf, /cost, the footer Σ, and the last-turn line kept reporting the
					// abandoned turns.
					rescopeToBranch(session, turns, turnId);
				} catch (error) {
					deps.notify(
						"error",
						`tree switch failed: ${error instanceof Error ? error.message : String(error)}`,
						"tree:switch-failed",
					);
				}
				deps.refreshFooter();
			},
			onClose: deps.transitions.close,
		});
		deps.requestRender();
	}

	function openMessagePickerState(): void {
		if (deps.transitions.state !== "closed") return;
		if (!deps.session) {
			emitCommandNotice(deps.getSlashNotice(), "error", "fork", "session contract unavailable");
			return;
		}
		const session = deps.session;
		const preForkSessionId = session.current()?.id ?? null;
		if (preForkSessionId === null) {
			emitCommandNotice(
				deps.getSlashNotice(),
				"warn",
				"fork",
				"no current session to fork from; start one with /new or /resume first",
			);
			return;
		}
		deps.transitions.state = "message-picker";
		deps.transitions.handle = openMessagePicker(deps.tui, {
			session,
			onFork: async (parentTurnId) => {
				const settlement = settleChatBeforeSessionSwitch(deps.chat);
				if (settlement) await settlement;
				try {
					if (deps.onForkSession) deps.onForkSession(parentTurnId);
					else session.fork(parentTurnId);
					const forkedSessionId = session.current()?.id ?? null;
					// A successful fork always creates a fresh session id; landing back
					// on the id fork started from means the fork threw and
					// onForkSession swallowed it (orchestrator.ts stderr-logs there).
					// Do not replay: session.current() did not move (issue #93's
					// extension.ts/fork.ts ordering fix keeps it on the session the
					// operator started on instead of orphaning it), so there is
					// nothing new to replay and doing so anyway just re-renders the
					// same transcript while hiding that the fork failed.
					if (forkedSessionId === null || forkedSessionId === preForkSessionId) {
						emitCommandNotice(deps.getSlashNotice(), "error", "fork", `fork failed; staying on ${preForkSessionId}`);
						deps.refreshFooter();
						deps.requestRender();
						return;
					}
					deps.resetTranscript();
					replayFork(forkedSessionId, parentTurnId, session);
				} catch (error) {
					deps.stderr(`[/fork] fork failed: ${error instanceof Error ? error.message : String(error)}\n`);
				}
				deps.refreshFooter();
				deps.requestRender();
			},
			onClose: deps.transitions.close,
		});
		deps.requestRender();
	}

	function replayFork(forkedSessionId: string, parentTurnId: string, session: SessionContract): void {
		try {
			const turns = deps.readStructuredEntries(forkedSessionId);
			rehydrateChatPanelFromTurns(deps.chatPanel, turns);
			const replayMessages = buildReplayAgentMessagesFromTurns(turns);
			const leafTurnId = session.tree(forkedSessionId).leafId ?? parentTurnId;
			deps.chat.resetForSession(leafTurnId, replayMessages);
			rescopeToBranch(session, turns, leafTurnId);
		} catch (error) {
			deps.stderr(`[/fork] transcript replay failed: ${error instanceof Error ? error.message : String(error)}\n`);
			deps.chat.resetForSession(null);
		}
	}

	function openCwdFallbackState(args: {
		sessionCwd: string;
		reason: "no-cwd" | "missing" | "not-a-directory";
		preResumeSessionId: string | null;
	}): void {
		if (deps.transitions.state !== "closed" || !deps.session) return;
		const session = deps.session;
		deps.transitions.state = "cwd-fallback";
		deps.transitions.handle = openCwdFallback(deps.tui, {
			sessionCwd: args.sessionCwd,
			currentCwd: process.cwd(),
			reason: args.reason,
			onContinue: deps.refreshFooter,
			onCancel: () => {
				restorePriorSessionOrReopen(args.preResumeSessionId, {
					session,
					reopen: () => queueMicrotask(openResume),
					onWarning: deps.stderr,
				});
				deps.refreshFooter();
			},
			onClose: deps.transitions.close,
		});
		deps.requestRender();
	}

	return { openResume, openTree, openMessagePicker: openMessagePickerState };
}
