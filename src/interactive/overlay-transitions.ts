import type { OverlayHandle } from "../engine/tui.js";
import type { OverlayState } from "./overlay-key-routing.js";

export interface OverlayTransitionsDeps {
	stopDispatchBoardTicker: () => void;
	renderContextIsland: () => void;
	renderTaskIsland: () => void;
	requestRender: () => void;
	cancelPendingAskUser: () => boolean;
	finishAuth: (dismiss: boolean) => void;
	onPermissionOverlayClosed: () => void;
	/**
	 * Runs after any overlay has closed and the state is back to `closed`. The
	 * permission lifecycle uses it to re-present a call that parked while this
	 * overlay held the screen; nothing else re-attempts that dialog.
	 */
	onOverlayClosed?: () => void;
}

export interface OverlayTransitions {
	state: OverlayState;
	handle: OverlayHandle | null;
	close(): void;
}

export function createOverlayTransitions(deps: OverlayTransitionsDeps): OverlayTransitions {
	let state: OverlayState = "closed";
	let handle: OverlayHandle | null = null;

	return {
		get state() {
			return state;
		},
		set state(next) {
			const closing = state !== "closed" && next === "closed";
			state = next;
			// The ask-user and auth lifecycles leave by assigning the state rather
			// than through `close`, so the hook fires here for them.
			if (closing) deps.onOverlayClosed?.();
		},
		get handle() {
			return handle;
		},
		set handle(next) {
			handle = next;
		},
		close,
	};

	function close(): void {
		if (state === "closed") return;
		if (state === "ask-user" && deps.cancelPendingAskUser()) return;
		if (state === "auth") {
			deps.finishAuth(true);
			return;
		}
		const leaving = state;
		state = "closed";
		deps.stopDispatchBoardTicker();
		handle?.hide();
		handle = null;
		if (leaving === "permission-confirm") deps.onPermissionOverlayClosed();
		else deps.onOverlayClosed?.();
		deps.renderContextIsland();
		deps.renderTaskIsland();
		deps.requestRender();
	}
}
