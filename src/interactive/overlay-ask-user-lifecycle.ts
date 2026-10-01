import type { TUI } from "../engine/tui.js";
import {
	type AskUserAnswer,
	type AskUserHandler,
	type AskUserQuestion,
	cancelledAskUserResult,
	unavailableAskUserResult,
} from "../tools/ask-user.js";
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
		if (harnessHold !== null) return;
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
			session?.cancel();
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

	const askAsHarness = async (
		questions: Parameters<AskUserHandler>[0],
		invokeOptions: Parameters<AskUserHandler>[1],
	): ReturnType<AskUserHandler> => {
		const signal = invokeOptions?.signal;
		// The model's interview keeps the overlay open between rounds, and another
		// card may be on screen. A card never takes over or closes a session it
		// did not open; the caller retries once the screen is free.
		if (session !== null || harnessHold !== null) return unavailableAskUserResult();
		const activeSession = ensureSession();
		if (!activeSession) return unavailableAskUserResult();
		let release: () => void = () => {};
		harnessHold = new Promise<void>((resolve) => {
			release = resolve;
		});
		// Esc on the card answers only the card. It never marks the turn's
		// interview cancelled.
		pendingCancel = () => activeSession.cancel();
		// An abort dismisses only this round: the session resolves it as cancelled
		// and the close below takes the overlay down.
		const onAbort = (): void => activeSession.cancel();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await activeSession.ask(questions, invokeOptions?.decisionPresentation, {
				inputGuardMs: HARNESS_INPUT_GUARD_MS,
			});
		} finally {
			signal?.removeEventListener("abort", onAbort);
			harnessHold = null;
			closeSession();
			release();
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
