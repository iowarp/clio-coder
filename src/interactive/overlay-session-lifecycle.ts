import { resolveSessionCwd } from "../domains/session/cwd-fallback.js";
import type { DecisionLedgerEntry } from "../domains/session/entries.js";
import {
	buildHandoffReadLedger,
	HANDOFF_NOTE_CUSTOM_TYPE,
	HANDOFF_SEED_CUSTOM_TYPE,
	type HandoffNoteData,
	type HandoffSeedData,
	mergeHandoffDecisions,
	parseHandoffExtraction,
	renderHandoffDocument,
	validateHandoffFiles,
	validateHandoffGoal,
} from "../domains/session/handoff.js";
import type { SessionContract, SessionEntry } from "../domains/session/index.js";
import type { TUI } from "../engine/tui.js";
import type { ChatLoop } from "./chat-loop.js";
import type { ChatPanel } from "./chat-panel.js";
import { rehydrateChatPanelFromTurns } from "./chat-renderer.js";
import { emitCommandNotice } from "./command-fallbacks.js";
import { editTextExternally, resolveExternalEditor } from "./external-editor.js";
import type { InteractiveNoticeLevel } from "./interactive-subscriptions.js";
import { buildModelReplayAgentMessagesFromTurns } from "./model-session-replay.js";
import type { OverlayTransitions } from "./overlay-transitions.js";
import { openCwdFallbackOverlay } from "./overlays/cwd-fallback.js";
import { openHandoffReviewOverlay } from "./overlays/handoff-review.js";
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
	chat: Pick<ChatLoop, "cancel" | "isStreaming" | "resetForSession" | "whenSettled" | "extractHandoff">;
	chatPanel: ChatPanel;
	/** The one transcript reset: the panel plus every view folded alongside it. */
	resetTranscript(): void;
	readStructuredEntries(sessionId: string): SessionEntry[];
	getSlashNotice(): SlashCommandContext["notice"];
	onResumeSession?(sessionId: string): void;
	onForkSession?(parentTurnId: string): void;
	/**
	 * Mint a fresh session, the same hook `/new` uses. `/handoff` needs the one
	 * session-creation path the orchestrator owns rather than a second one.
	 */
	onNewSession?(): void;
	/** The session's settled decision board, which wins over extracted decisions. */
	getDecisionBoard?(): ReadonlyArray<DecisionLedgerEntry>;
	/** Stop and restart the terminal around an external editor child process. */
	suspendTerminal?<T>(run: () => T): T;
	resolveEditor?: typeof resolveExternalEditor;
	editExternally?: typeof editTextExternally;
	openHandoffReviewOverlay?: typeof openHandoffReviewOverlay;
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
	/** Live terminal width, so the handoff review box tracks the window. */
	terminal?: { columns: number };
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
	/** `/handoff <goal>`: extract, review, and seed a successor session. */
	startHandoff(goal: string): void;
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
					const replayMessages = buildModelReplayAgentMessagesFromTurns(turns, replayOptions);
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
					const replayMessages = buildModelReplayAgentMessagesFromTurns(turns, { uptoTurnId: turnId });
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
			const leafTurnId = session.tree(forkedSessionId).leafId ?? parentTurnId;
			const replayMessages = buildModelReplayAgentMessagesFromTurns(
				turns,
				leafTurnId ? { activeLeafTurnId: leafTurnId } : {},
			);
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

	/**
	 * `/handoff <goal>`: carry this session's working state into a fresh one.
	 *
	 * A handoff is a session operation. It writes no memory promotion candidate,
	 * touches no memory record, and never calls the task-memory bank; the only
	 * things it writes are one seed entry plus replayed skill activations in the
	 * new session and one terminal note in the old one, and it writes none of
	 * them until the operator has accepted the document.
	 */
	function startHandoff(goal: string): void {
		if (deps.transitions.state !== "closed") return;
		const notice = deps.getSlashNotice();
		const verdict = validateHandoffGoal(goal);
		if (!verdict.ok) {
			emitCommandNotice(notice, "warn", "handoff", verdict.reason);
			return;
		}
		if (!deps.session) {
			emitCommandNotice(notice, "error", "handoff", "session contract unavailable");
			return;
		}
		if (!deps.onNewSession) {
			emitCommandNotice(notice, "error", "handoff", "no session-creation path is wired in this session");
			return;
		}
		// Refused, never queued. The document describes a session that has
		// stopped; a turn still in flight is about to change what it would say.
		if (deps.chat.isStreaming()) {
			emitCommandNotice(
				notice,
				"warn",
				"handoff",
				"a turn is in flight; /handoff cannot summarize a session that is still moving",
			);
			return;
		}
		const session = deps.session;
		const fromSessionId = session.current()?.id ?? null;
		if (fromSessionId === null) {
			emitCommandNotice(notice, "warn", "handoff", "no current session to hand off; start one with /new or /resume");
			return;
		}
		void runHandoffExtraction(session, fromSessionId, verdict.goal);
	}

	/** Characters of the second round's answer quoted in the terminal refusal. */
	const HANDOFF_REFUSAL_QUOTE_CHARS = 200;

	/**
	 * A refusal that says what was asked for and what came back, not only that no
	 * JSON object arrived. Both rounds are named, so an operator reading it knows
	 * two model calls were spent and on what.
	 */
	function terminalHandoffRefusal(firstReason: string, secondReason: string, secondText: string): string {
		const answered = secondText.replace(/\s+/g, " ").trim().slice(0, HANDOFF_REFUSAL_QUOTE_CHARS);
		return [
			"the extraction round could not produce a handoff record after one repair attempt.",
			`Asked for: one JSON object with decisions, facts, files, commands, and openQuestions.`,
			`Round 1: ${firstReason}.`,
			`Round 2: ${secondReason}.`,
			`Round 2 returned: ${answered.length > 0 ? answered : "(nothing)"}`,
		].join(" ");
	}

	/**
	 * Extract, then repair once.
	 *
	 * A local model that answers with prose around the object, or with nothing
	 * parseable, used to end `/handoff` outright: every downstream behavior (the
	 * dropped-path listing, the `e` editor, accept-mints-a-session) was
	 * unreachable and the operator had paid for the round either way (issue
	 * #223). Exactly one repair round follows, quoting what came back and what
	 * the parser objected to, and both rounds bill through the same out-of-turn
	 * usage store.
	 */
	async function extractWithOneRepair(
		goal: string,
	): Promise<
		| { ok: true; parsed: Extract<ReturnType<typeof parseHandoffExtraction>, { ok: true }> }
		| { ok: false; level: "error" | "warn"; reason: string }
	> {
		const first = await deps.chat.extractHandoff(goal);
		if (first.status !== "answered") {
			return {
				ok: false,
				level: first.status === "failed" ? "error" : "warn",
				reason: first.status === "aborted" ? "the extraction round was cancelled" : first.reason,
			};
		}
		const parsedFirst = parseHandoffExtraction(first.text);
		if (parsedFirst.ok) return { ok: true, parsed: parsedFirst };

		const second = await deps.chat.extractHandoff(goal, {
			repair: { complaint: parsedFirst.reason, previous: first.text },
		});
		if (second.status !== "answered") {
			return {
				ok: false,
				level: second.status === "failed" ? "error" : "warn",
				reason:
					second.status === "aborted"
						? "the repair round was cancelled"
						: `round 1 could not be read (${parsedFirst.reason}); the repair round then failed: ${second.reason}`,
			};
		}
		const parsedSecond = parseHandoffExtraction(second.text);
		if (parsedSecond.ok) return { ok: true, parsed: parsedSecond };
		return {
			ok: false,
			level: "error",
			reason: terminalHandoffRefusal(parsedFirst.reason, parsedSecond.reason, second.text),
		};
	}

	async function runHandoffExtraction(session: SessionContract, fromSessionId: string, goal: string): Promise<void> {
		const notice = deps.getSlashNotice();
		const extraction = await extractWithOneRepair(goal);
		if (!extraction.ok) {
			emitCommandNotice(notice, extraction.level, "handoff", extraction.reason);
			return;
		}
		const parsed = extraction.parsed;
		const meta = session.current();
		const cwd = typeof meta?.cwd === "string" && meta.cwd.length > 0 ? meta.cwd : null;
		const entries = deps.readStructuredEntries(fromSessionId);
		// The ledger is what this session's own tool calls touched, folded through
		// the active path so an abandoned `/tree` branch is not evidence.
		const ledger = buildHandoffReadLedger(entries, { cwd, leafTurnId: meta?.pinnedLeafTurnId ?? null });
		const files = validateHandoffFiles(parsed.result.extraction.files, ledger, cwd);
		const decisions = mergeHandoffDecisions(parsed.result.extraction.decisions, deps.getDecisionBoard?.() ?? []);
		const document = renderHandoffDocument({
			goal,
			fromSessionId,
			decisions,
			facts: parsed.result.extraction.facts,
			files: files.kept,
			droppedFiles: files.dropped,
			commands: parsed.result.extraction.commands,
			openQuestions: parsed.result.extraction.openQuestions,
			truncations: parsed.result.truncations,
		});
		openHandoffReview(session, fromSessionId, goal, document);
	}

	/** Hand the document to `$EDITOR`, or say why it could not go. */
	function editHandoffDocument(current: string): string | null {
		const resolve = deps.resolveEditor ?? resolveExternalEditor;
		const edit = deps.editExternally ?? editTextExternally;
		const command = resolve();
		if (!command) {
			deps.notify("warning", "handoff: no external editor configured; set VISUAL or EDITOR", "handoff:no-editor");
			return null;
		}
		const suspend = deps.suspendTerminal ?? (<T>(run: () => T): T => run());
		const result = suspend(() => edit(current, command));
		if (result.ok) return result.text ?? current;
		if (result.error) deps.notify("warning", `handoff: ${result.error}`, "handoff:editor-failed");
		return null;
	}

	function openHandoffReview(session: SessionContract, fromSessionId: string, goal: string, document: string): void {
		if (deps.transitions.state !== "closed") return;
		const openReview = deps.openHandoffReviewOverlay ?? openHandoffReviewOverlay;
		deps.transitions.state = "handoff-review";
		deps.transitions.handle = openReview(deps.tui, {
			document,
			goal,
			columns: deps.terminal?.columns ?? 80,
			onEdit: editHandoffDocument,
			onAccept: (reviewed) => {
				deps.transitions.close();
				const text = reviewed.trim();
				if (text.length === 0) {
					deps.notify("warning", "handoff: the reviewed document was empty; nothing was written", "handoff:empty");
					return;
				}
				seedHandoffSession(session, fromSessionId, goal, text);
			},
			// Esc. Nothing has been written yet, so cancel really is free. The
			// overlay settles itself on cancel and answers no further key, so the
			// transition has to close here or the review stays on screen inert.
			onCancel: () => {
				deps.transitions.close();
				deps.notify("info", "handoff cancelled; nothing was written", "handoff:cancelled");
			},
		});
		deps.requestRender();
	}

	/**
	 * Mint the successor session and open it on the reviewed document.
	 *
	 * Order matters. The old session's terminal note is appended while it is
	 * still current, because an append always lands in the current session. Then
	 * the new session is minted through the one creation path the orchestrator
	 * owns, the document goes in as bounded data labelled by its origin, and the
	 * old session's skill activations are replayed so loaded skills carry
	 * forward. The old session is otherwise untouched.
	 */
	function seedHandoffSession(session: SessionContract, fromSessionId: string, goal: string, document: string): void {
		const notice = deps.getSlashNotice();
		const activations = session.current()?.skillActivations ?? [];
		let toSessionId: string;
		try {
			deps.onNewSession?.();
			const minted = session.current()?.id ?? null;
			if (minted === null || minted === fromSessionId) throw new Error("the new session was not created");
			toSessionId = minted;
			session.appendEntry({
				kind: "custom",
				parentTurnId: null,
				customType: HANDOFF_SEED_CUSTOM_TYPE,
				display: true,
				data: { fromSessionId, goal, document } satisfies HandoffSeedData,
			});
			for (const activation of activations) session.recordSkillActivation(activation);
		} catch (error) {
			emitCommandNotice(
				notice,
				"error",
				"handoff",
				`could not seed the new session: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		// The note names the target, so it can only be written once the target
		// exists. Appends land in the current session, so the old session is made
		// current for exactly one append and then handed back. A failure here
		// costs the note and nothing else: the successor session is already
		// seeded and is where the operator continues.
		try {
			session.switchBranch(fromSessionId);
			session.appendEntry({
				kind: "custom",
				parentTurnId: null,
				customType: HANDOFF_NOTE_CUSTOM_TYPE,
				display: true,
				data: { toSessionId, goal } satisfies HandoffNoteData,
			});
		} catch (error) {
			deps.stderr(`[/handoff] handoff note failed: ${error instanceof Error ? error.message : String(error)}\n`);
		} finally {
			try {
				session.switchBranch(toSessionId);
			} catch (error) {
				deps.stderr(
					`[/handoff] could not return to the new session: ${error instanceof Error ? error.message : String(error)}\n`,
				);
			}
		}
		try {
			const turns = deps.readStructuredEntries(toSessionId);
			deps.resetTranscript();
			rehydrateChatPanelFromTurns(deps.chatPanel, turns);
			deps.chat.resetForSession(null, buildModelReplayAgentMessagesFromTurns(turns));
			rescopeToBranch(session, turns, null);
		} catch (error) {
			deps.stderr(`[/handoff] seeding replay failed: ${error instanceof Error ? error.message : String(error)}\n`);
			deps.chat.resetForSession(null);
		}
		emitCommandNotice(notice, "info", "handoff", `handed off to session ${toSessionId}`);
		deps.refreshFooter();
		deps.requestRender();
	}

	return { openResume, openTree, openMessagePicker: openMessagePickerState, startHandoff };
}
