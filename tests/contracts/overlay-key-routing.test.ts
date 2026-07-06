import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	isEscapeKey,
	isLiveWorkerEscalationRequest,
	type OverlayKeyDeps,
	type OverlayState,
	routeOverlayKey,
	routePermissionOverlayKey,
	shouldAnnouncePermissionRequest,
} from "../../src/interactive/index.js";

const ESC = "\x1b";
const KITTY_ESC = "\x1b[27u";
const KITTY_ESC_RELEASE = "\x1b[27;1:3u";
const MODIFY_OTHER_ESC = "\x1b[27;1;27~";
const KITTY_ENTER = "\x1b[13u";
const KITTY_ENTER_RELEASE = "\x1b[13;1:3u";

/**
 * routeOverlayKey is the seam where BT04-1 regressed: the Skills Hub state
 * was added (71c3e53) without joining the list-overlay routing union from
 * 7cae8fe, so every hub key fell through to the dispatch-board branch and was
 * swallowed. These tests pin the contract for every list overlay: all input
 * including Esc is forwarded to the focused ListOverlay (return false). The
 * kit owns Esc so a first Esc can clear a nonempty filter before a second
 * Esc closes (bt-06 finding 2); router-level Esc interception bypassed that.
 */

const LIST_OVERLAY_STATES: ReadonlyArray<OverlayState> = ["help", "agents", "prompts", "extensions", "skills-hub"];

function makeDeps(): {
	deps: OverlayKeyDeps;
	closed: () => number;
	shutdowns: () => number;
	cancelledPermissions: () => number;
	confirmedPermissions: () => number;
	cancelledAskUser: () => number;
} {
	let closeCount = 0;
	let shutdownCount = 0;
	let cancelPermissionCount = 0;
	let confirmPermissionCount = 0;
	let cancelAskUserCount = 0;
	const deps: OverlayKeyDeps = {
		closeOverlay: () => {
			closeCount += 1;
		},
		cancelPermission: () => {
			cancelPermissionCount += 1;
		},
		confirmPermission: () => {
			confirmPermissionCount += 1;
		},
		cancelAskUser: () => {
			cancelAskUserCount += 1;
		},
		requestShutdown: () => {
			shutdownCount += 1;
		},
	};
	return {
		deps,
		closed: () => closeCount,
		shutdowns: () => shutdownCount,
		cancelledPermissions: () => cancelPermissionCount,
		confirmedPermissions: () => confirmPermissionCount,
		cancelledAskUser: () => cancelAskUserCount,
	};
}

const neverMatches = () => false;

describe("list-overlay key routing", () => {
	for (const state of LIST_OVERLAY_STATES) {
		it(`forwards typing, arrows, Enter, and action keys to the ${state} overlay`, () => {
			const { deps, closed } = makeDeps();
			for (const key of ["t", "\x1b[A", "\x1b[B", "\r", "i", "\t"]) {
				strictEqual(
					routeOverlayKey(key, state, deps, neverMatches),
					false,
					`${JSON.stringify(key)} must reach the focused ListOverlay in ${state}`,
				);
			}
			strictEqual(closed(), 0, "no key except Esc closes the overlay");
		});

		it(`forwards Esc to the ${state} overlay so the kit can clear a filter before closing`, () => {
			const { deps, closed } = makeDeps();
			strictEqual(routeOverlayKey(ESC, state, deps, neverMatches), false);
			strictEqual(routeOverlayKey(KITTY_ESC, state, deps, neverMatches), false);
			strictEqual(closed(), 0, "close happens through the ListOverlay's onClose, not the router");
		});
	}

	it("skills-hub no longer falls through to the key-swallowing dispatch-board branch (BT04-1)", () => {
		const { deps, closed } = makeDeps();
		// Before the fix this returned true (input swallowed, hub dead).
		strictEqual(routeOverlayKey("t", "skills-hub", deps, neverMatches), false);
		strictEqual(closed(), 0);
	});

	it("recognizes Escape across raw, CSI-u, and modifyOtherKeys encodings", () => {
		strictEqual(isEscapeKey(ESC), true);
		strictEqual(isEscapeKey(KITTY_ESC), true);
		strictEqual(isEscapeKey(MODIFY_OTHER_ESC), true);
		strictEqual(isEscapeKey(KITTY_ESC_RELEASE), false);
		strictEqual(isEscapeKey("\x1b[A"), false);
	});

	it("routes CSI-u Escape through app-owned overlay close handlers", () => {
		for (const state of [
			"dispatch-board",
			"providers",
			"auth",
			"cost",
			"context-view",
			"thinking",
			"model",
			"scoped-models",
			"settings",
			"message-picker",
		] satisfies ReadonlyArray<OverlayState>) {
			const { deps, closed } = makeDeps();
			strictEqual(routeOverlayKey(KITTY_ESC, state, deps, neverMatches), true, state);
			strictEqual(closed(), 1, state);
		}
	});

	it("routes CSI-u Escape to permission and ask_user cancellation", () => {
		const permission = makeDeps();
		strictEqual(routeOverlayKey(KITTY_ESC, "permission-confirm", permission.deps, neverMatches), true);
		strictEqual(permission.cancelledPermissions(), 1);

		const askUser = makeDeps();
		strictEqual(routeOverlayKey(KITTY_ESC, "ask-user", askUser.deps, neverMatches), true);
		strictEqual(askUser.cancelledAskUser(), 1);
	});

	it("ignores Escape and Enter key release events in pure overlay handlers", () => {
		const permission = makeDeps();
		strictEqual(routePermissionOverlayKey(KITTY_ENTER, permission.deps), true);
		strictEqual(permission.confirmedPermissions(), 1);
		strictEqual(routePermissionOverlayKey(KITTY_ENTER_RELEASE, permission.deps), false);
		strictEqual(routePermissionOverlayKey(KITTY_ESC_RELEASE, permission.deps), false);
		strictEqual(permission.confirmedPermissions(), 1);
		strictEqual(permission.cancelledPermissions(), 0);
	});

	it("dedupes permission parked notices by requestId", () => {
		const seen = new Set<string>();
		let noticeCount = 0;
		for (const requestId of ["req-one", "req-one", "req-two"]) {
			if (shouldAnnouncePermissionRequest(seen, requestId)) noticeCount += 1;
		}

		strictEqual(noticeCount, 2);
		strictEqual(shouldAnnouncePermissionRequest(seen, "req-one"), false);
	});

	it("routes only live worker escalation requests to the interactive overlay", () => {
		strictEqual(
			isLiveWorkerEscalationRequest({
				tool: "bash",
				actionClass: "execute",
				requestId: "worker-policy-deny",
				origin: "worker:run-1",
				requestedBy: "run-1",
			}),
			false,
		);
		strictEqual(
			isLiveWorkerEscalationRequest({
				tool: "bash",
				actionClass: "execute",
				requestId: "worker-live",
				origin: "worker:run-1",
				requestedBy: "run-1",
				escalation: true,
				timeoutMs: 120_000,
			}),
			true,
		);
	});
});
