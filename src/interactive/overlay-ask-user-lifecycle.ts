import type { TUI } from "../engine/tui.js";
import { type AskUserHandler, cancelledAskUserResult } from "../tools/ask-user.js";
import type { OverlayState } from "./overlay-key-routing.js";
import { type AskUserOverlaySession, openAskUserOverlay } from "./overlays/ask-user.js";

export interface OverlayAskUserLifecycleDeps {
	tui: TUI;
	getOverlayState(): OverlayState;
	setOverlayState(state: OverlayState): void;
	getOverlayHandle(): unknown;
	setOverlayHandle(handle: AskUserOverlaySession | null): void;
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
}

export interface OverlayAskUserLifecycle {
	handler: AskUserHandler;
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
	const openSession = deps.openAskUserOverlay ?? openAskUserOverlay;

	const refresh = (): void => {
		deps.renderContextIsland();
		deps.renderTaskIsland();
		deps.requestRender();
	};

	const close = (): void => {
		pendingCancel = null;
		const current = session;
		session = null;
		if (current) {
			current.close();
			if (deps.getOverlayHandle() === current) deps.setOverlayHandle(null);
		} else if (deps.getOverlayState() === "ask-user") {
			const handle = deps.getOverlayHandle() as { hide?: () => void } | null;
			handle?.hide?.();
			deps.setOverlayHandle(null);
		}
		if (deps.getOverlayState() === "ask-user") deps.setOverlayState("closed");
		refresh();
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
		cancelledForTurn = true;
		session?.cancel();
		close();
	};

	const handler: AskUserHandler = async (questions, invokeOptions) => {
		const toolBacked = Boolean(invokeOptions?.turnId || invokeOptions?.toolCallId);
		if (toolBacked && cancelledForTurn) return cancelledAskUserResult();
		const activeSession = ensureSession();
		if (!activeSession) return cancelledAskUserResult();
		pendingCancel = cancel;
		const result = await activeSession.ask(questions, invokeOptions?.decisionPresentation);
		if (result.cancelled === true || !toolBacked) {
			if (result.cancelled === true) cancelledForTurn = true;
			close();
		} else {
			refresh();
		}
		return result;
	};

	unregisterHandler = deps.registerHandler?.(handler) ?? null;
	return {
		handler,
		close,
		cancel,
		cancelPending: () => {
			if (!pendingCancel) return false;
			pendingCancel();
			return true;
		},
		isWaiting: () => session?.isWaiting() ?? false,
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
