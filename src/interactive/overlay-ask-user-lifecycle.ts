import type { TUI } from "../engine/tui.js";
import {
	type AskUserAnswer,
	type AskUserHandler,
	type AskUserQuestion,
	cancelledAskUserResult,
	unavailableAskUserResult,
} from "../tools/ask-user.js";
import type { HarnessHold } from "../tools/registry.js";
import type { OverlayState } from "./overlay-key-routing.js";
import { type AskUserOverlaySession, openAskUserOverlay } from "./overlays/ask-user.js";

/**
 * How long a harness round ignores keys after it appears. Time rather than
 * "until the first navigation key": a fixed window drops the Enter of an
 * operator mid-sentence in the composer without making a deliberate Enter on
 * the safe default wait for an arrow press. Typing cadence puts the next
 * keystroke well inside it, and an operator reading the card is outside it.
 */
const HARNESS_INPUT_GUARD_MS = 400;

/** Stands in for the hold of a card that took none, so it too is noticed once. */
const UNHELD_CARD = {};

export interface OverlayAskUserLifecycleDeps {
	tui: TUI;
	getOverlayState(): OverlayState;
	setOverlayState(state: OverlayState): void;
	getOverlayHandle(): unknown;
	setOverlayHandle(handle: AskUserOverlaySession | null): void;
	/**
	 * A permission prompt on top of an interview restores that interview when it
	 * closes. A session that ended under it must not be restored, or the screen
	 * is left in ask-user with nothing behind it.
	 */
	replaceInterruptedOverlay?(from: AskUserOverlaySession, to: AskUserOverlaySession | null): void;
	/** A harness card could not be shown because another overlay owns the screen. Fired once per card. */
	onHarnessWaiting?(): void;
	renderContextIsland(): void;
	renderTaskIsland(): void;
	requestRender(): void;
	registerHandler?(handler: AskUserHandler): () => void;
	openAskUserOverlay?: typeof openAskUserOverlay;
	/**
	 * An ask_user request parked waiting for the operator. Fired when the
	 * overlay session opens, not per question, so one interview notifies once.
	 */
	onOperatorParked?(): void;
	/**
	 * A round the operator answered that no tool row states, for the transcript
	 * record. A round a tool call asked is stated by that call's own `? asked …
	 * → answer` row, so it is not fired for one; nor on cancel.
	 */
	onRoundAnswered?(questions: ReadonlyArray<AskUserQuestion>, answers: ReadonlyArray<AskUserAnswer>): void;
}

export interface OverlayAskUserLifecycle {
	handler: AskUserHandler;
	/** Harness-owned confirmations that must not become interview decisions. */
	transientHandler: AskUserHandler;
	close(): void;
	cancel(): void;
	cancelPending(): boolean;
	isWaiting(): boolean;
	resetCancellation(): void;
	dispose(): void;
}

export function createOverlayAskUserLifecycle(deps: OverlayAskUserLifecycleDeps): OverlayAskUserLifecycle {
	let pendingCancel: (() => void) | null = null;
	let session: AskUserOverlaySession | null = null;
	let cancelledForTurn = false;
	let unregisterHandler: (() => void) | null = null;
	/**
	 * Set while a harness round (a dispatch merge card) holds the overlay. The
	 * model's interview waits on it and the turn-level closers leave the session
	 * alone: the card is not the model's to cancel, close, or interleave with.
	 */
	let harnessHold: Promise<void> | null = null;
	let heldBy: HarnessHold | null = null;
	let releaseHold: () => void = () => {};
	/** The harness card's own session. The model's interview, when one is open, waits hidden beneath it. */
	let cardSession: AskUserOverlaySession | null = null;
	/** The model interview's Esc handler, put back when the card ends. */
	let savedCancel: (() => void) | null = null;
	/** A turn-level close the card swallowed; the interview it asked to close is closed once the card ends. */
	let closeRequested = false;
	/** The card the operator was last told is waiting behind another overlay, so a retry loop notices once. */
	let noticedFor: HarnessHold | object | null = null;
	const openSession = deps.openAskUserOverlay ?? openAskUserOverlay;

	const refresh = (): void => {
		deps.renderContextIsland();
		deps.renderTaskIsland();
		deps.requestRender();
	};

	const closeSession = (): void => {
		pendingCancel = null;
		const current = session;
		session = null;
		if (current) {
			current.close();
			if (deps.getOverlayHandle() === current) deps.setOverlayHandle(null);
			deps.replaceInterruptedOverlay?.(current, null);
		} else if (deps.getOverlayState() === "ask-user") {
			const handle = deps.getOverlayHandle() as { hide?: () => void } | null;
			handle?.hide?.();
			deps.setOverlayHandle(null);
		}
		if (deps.getOverlayState() === "ask-user") deps.setOverlayState("closed");
		refresh();
	};

	// Turn end, a streamed assistant delta, and an interview-closing tool result
	// all call this. None of them speaks for a harness card.
	const close = (): void => {
		if (harnessHold !== null) {
			closeRequested = true;
			return;
		}
		closeSession();
	};

	const ensureSession = (): AskUserOverlaySession | null => {
		if (deps.getOverlayState() !== "closed" && deps.getOverlayState() !== "ask-user") return null;
		if (session) return session;
		deps.setOverlayState("ask-user");
		session = openSession(deps.tui, { onCancel: () => pendingCancel?.() });
		deps.setOverlayHandle(session);
		deps.onOperatorParked?.();
		deps.requestRender();
		return session;
	};

	const cancel = (): void => {
		if (harnessHold !== null) {
			cardSession?.cancel();
			return;
		}
		cancelledForTurn = true;
		session?.cancel();
		closeSession();
	};

	/** Resolves true once no harness round holds the overlay, false if the caller's signal fires first. */
	const waitForHarness = async (signal: AbortSignal | undefined): Promise<boolean> => {
		while (harnessHold !== null) {
			if (signal?.aborted === true) return false;
			const aborted = new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
			await Promise.race([harnessHold, aborted]);
		}
		return signal?.aborted !== true;
	};

	/**
	 * Release the screen a harness card held: close its session, bring back the
	 * model's interview if one waited beneath it, and let a waiting model ask
	 * through. Idempotent, because an explicit hold ends it from the card's owner
	 * and a one-round card from the round's own `finally`.
	 */
	const endHarness = (): void => {
		if (harnessHold === null) return;
		harnessHold = null;
		heldBy = null;
		const release = releaseHold;
		releaseHold = () => {};
		const card = cardSession;
		cardSession = null;
		pendingCancel = null;
		if (card !== null) {
			card.close();
			deps.replaceInterruptedOverlay?.(card, session);
			if (deps.getOverlayHandle() === card) deps.setOverlayHandle(session);
		}
		if (closeRequested) {
			closeRequested = false;
			closeSession();
		} else if (session !== null) {
			// Resumed as it was left: nothing was cancelled, answered, or recorded.
			pendingCancel = savedCancel;
			session.setHidden(false);
			if (deps.getOverlayState() === "ask-user") session.focus();
			refresh();
		} else {
			if (deps.getOverlayState() === "ask-user") deps.setOverlayState("closed");
			refresh();
		}
		savedCancel = null;
		release();
	};

	const askAsHarness = async (
		questions: Parameters<AskUserHandler>[0],
		invokeOptions: Parameters<AskUserHandler>[1],
	): ReturnType<AskUserHandler> => {
		const signal = invokeOptions?.signal;
		const hold = invokeOptions?.harnessHold;
		// A card's later rounds (the discard confirm, and the card again after Back)
		// continue the reservation its first round took, so a model question cannot
		// take the screen between them.
		const continuing = hold !== undefined && heldBy === hold && cardSession !== null;
		if (!continuing) {
			// Another card is on screen, or the model is mid-round: the caller retries.
			if (harnessHold !== null || (session !== null && !session.isWaiting())) return unavailableAskUserResult();
			const state = deps.getOverlayState();
			if (state !== "closed" && state !== "ask-user") {
				// A dispatch board or settings overlay hides the card. Say so once, or
				// it times out unseen. A permission prompt is already asking.
				const card = hold ?? UNHELD_CARD;
				if (state !== "permission-confirm" && noticedFor !== card) {
					noticedFor = card;
					deps.onHarnessWaiting?.();
				}
				return unavailableAskUserResult();
			}
			// An interview with no round in flight yields the screen and resumes after
			// the card. Closing it would drop its ledger and cancel nothing it owns.
			savedCancel = pendingCancel;
			session?.setHidden(true);
			deps.setOverlayState("ask-user");
			const opened = openSession(deps.tui, { onCancel: () => pendingCancel?.() });
			cardSession = opened;
			deps.setOverlayHandle(opened);
			deps.onOperatorParked?.();
			deps.requestRender();
			harnessHold = new Promise<void>((resolve) => {
				releaseHold = resolve;
			});
			heldBy = hold ?? null;
			hold?.onRelease(endHarness);
		}
		const activeSession = cardSession;
		if (activeSession === null) return unavailableAskUserResult();
		// Esc on the card answers only the card. It never marks the turn's
		// interview cancelled.
		pendingCancel = () => activeSession.cancel();
		// An abort dismisses only this round: the session resolves it as cancelled
		// and the card's owner releases the screen.
		const onAbort = (): void => activeSession.cancel();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await activeSession.ask(questions, invokeOptions?.decisionPresentation, {
				inputGuardMs: HARNESS_INPUT_GUARD_MS,
			});
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (hold === undefined) endHarness();
		}
	};

	const ask = async (
		questions: Parameters<AskUserHandler>[0],
		invokeOptions: Parameters<AskUserHandler>[1],
		recordAnswer: boolean,
	): ReturnType<AskUserHandler> => {
		const toolBacked = Boolean(invokeOptions?.turnId || invokeOptions?.toolCallId);
		const signal = invokeOptions?.signal;
		if (signal?.aborted === true) return cancelledAskUserResult();
		// A round the harness asks on its own decision (a dispatch merge card)
		// is not part of the model's interview.
		if (invokeOptions?.origin === "harness") return askAsHarness(questions, invokeOptions);
		// A card on screen delays the model's question; it does not cancel it.
		if (!(await waitForHarness(signal))) return cancelledAskUserResult();
		if (toolBacked && cancelledForTurn) return cancelledAskUserResult();
		const activeSession = ensureSession();
		if (!activeSession) return unavailableAskUserResult();
		const previousCancel = pendingCancel;
		pendingCancel = cancel;
		const result = await activeSession.ask(questions, invokeOptions?.decisionPresentation);
		if (result.unavailable === true) {
			// A round already on screen kept its own cancel; this caller was not shown.
			pendingCancel = previousCancel;
			return result;
		}
		if (recordAnswer && !toolBacked && result.cancelled !== true && result.answers.length > 0)
			deps.onRoundAnswered?.(questions, result.answers);
		if (result.cancelled === true || !toolBacked) {
			if (result.cancelled === true) cancelledForTurn = true;
			close();
		} else {
			refresh();
		}
		return result;
	};
	const handler: AskUserHandler = (questions, invokeOptions) => ask(questions, invokeOptions, true);
	const transientHandler: AskUserHandler = (questions, invokeOptions) => ask(questions, invokeOptions, false);

	unregisterHandler = deps.registerHandler?.(handler) ?? null;
	return {
		handler,
		transientHandler,
		close,
		cancel,
		cancelPending: () => {
			if (!pendingCancel) return false;
			pendingCancel();
			return true;
		},
		isWaiting: () => harnessHold === null && (session?.isWaiting() ?? false),
		resetCancellation: () => {
			cancelledForTurn = false;
		},
		dispose: () => {
			unregisterHandler?.();
			unregisterHandler = null;
			pendingCancel?.();
		},
	};
}
