import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { CLIO_APP_KEYBINDINGS } from "../../src/domains/config/keybindings.js";
import {
	dispatchInteractiveAction,
	isEscapeKey,
	isLiveWorkerEscalationRequest,
	type KeyBindingDeps,
	type OverlayKeyDeps,
	type OverlayState,
	overlayOwnsInput,
	resolveCtrlCAction,
	routeDispatchBoardOverlayKey,
	routeOverlayKey,
	routePermissionOverlayKey,
	shouldAnnouncePermissionRequest,
} from "../../src/interactive/index.js";
import { createKeybindingManagerForTesting } from "../../src/interactive/keybinding-manager.js";

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
 * The router now exhausts OverlayState, so adding a state without an explicit
 * route fails typecheck instead of recreating the dispatch-board fallthrough.
 */

const LIST_OVERLAY_STATES: ReadonlyArray<OverlayState> = ["help", "agents", "prompts", "extensions", "skills-hub"];

function makeDeps(): {
	deps: OverlayKeyDeps;
	closed: () => number;
	cancelledPermissions: () => number;
	confirmedPermissions: () => number;
	cancelledAskUser: () => number;
	selectedPrevious: () => number;
	selectedNext: () => number;
	steeredDispatches: () => number;
	cancelledDispatches: () => number;
} {
	let closeCount = 0;
	let cancelPermissionCount = 0;
	let confirmPermissionCount = 0;
	let cancelAskUserCount = 0;
	let selectPreviousCount = 0;
	let selectNextCount = 0;
	let steerDispatchCount = 0;
	let cancelDispatchCount = 0;
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
		selectPreviousDispatch: () => {
			selectPreviousCount += 1;
		},
		selectNextDispatch: () => {
			selectNextCount += 1;
		},
		steerSelectedDispatch: () => {
			steerDispatchCount += 1;
		},
		cancelSelectedDispatch: () => {
			cancelDispatchCount += 1;
		},
		cancelAskUser: () => {
			cancelAskUserCount += 1;
		},
	};
	return {
		deps,
		closed: () => closeCount,
		cancelledPermissions: () => cancelPermissionCount,
		confirmedPermissions: () => confirmPermissionCount,
		cancelledAskUser: () => cancelAskUserCount,
		selectedPrevious: () => selectPreviousCount,
		selectedNext: () => selectNextCount,
		steeredDispatches: () => steerDispatchCount,
		cancelledDispatches: () => cancelDispatchCount,
	};
}

const neverMatches = () => false;

describe("modal precedence", () => {
	it("keeps every open overlay ahead of the editor and active run", () => {
		strictEqual(overlayOwnsInput("closed"), false);
		for (const state of ["fleet", "agents", "settings", "ask-user"] satisfies ReadonlyArray<OverlayState>) {
			strictEqual(overlayOwnsInput(state), true, state);
		}
	});

	it("makes Ctrl+C close a modal instead of cancelling or shutting down", () => {
		strictEqual(
			resolveCtrlCAction({
				overlayState: "agents",
				streaming: true,
				editorText: "",
				lastCtrlCAt: Date.now(),
				now: Date.now(),
			}),
			"close-overlay",
		);
	});

	it("keeps Ctrl+D as delete-forward when the editor is nonempty", () => {
		let shutdowns = 0;
		const deps = {
			canExit: () => false,
			requestShutdown: () => {
				shutdowns += 1;
			},
		} as KeyBindingDeps;
		strictEqual(dispatchInteractiveAction("clio.exit", deps), false);
		strictEqual(shutdowns, 0);
		strictEqual(dispatchInteractiveAction("clio.exit", { ...deps, canExit: () => true }), true);
		strictEqual(shutdowns, 1);
	});

	it("keeps latest/all tool and reasoning controls bound and dispatchable", () => {
		strictEqual(CLIO_APP_KEYBINDINGS["clio.tool.expand"].defaultKeys, "alt+o");
		ok(
			CLIO_APP_KEYBINDINGS["clio.tool.expandAll"].defaultKeys.includes("ctrl+alt+o"),
			"all-tools has a Ctrl+Alt fallback",
		);
		strictEqual(CLIO_APP_KEYBINDINGS["clio.thinking.expand"].defaultKeys, "alt+r");
		ok(
			CLIO_APP_KEYBINDINGS["clio.thinking.expandAll"].defaultKeys.includes("ctrl+alt+r"),
			"all-reasoning has a Ctrl+Alt fallback",
		);
		const manager = createKeybindingManagerForTesting();
		strictEqual(manager.matches("\x1b\x0f", "clio.tool.expandAll"), true);
		strictEqual(manager.matches("\x1b\x12", "clio.thinking.expandAll"), true);

		const calls: string[] = [];
		const deps = {
			toggleToolExpansion: () => calls.push("tool"),
			toggleAllToolExpansion: () => calls.push("tools"),
			toggleThinkingExpansion: () => calls.push("thinking"),
			toggleAllThinkingExpansion: () => calls.push("thinkings"),
		} as unknown as KeyBindingDeps;
		for (const [id, label] of [
			["clio.tool.expand", "tool"],
			["clio.tool.expandAll", "tools"],
			["clio.thinking.expand", "thinking"],
			["clio.thinking.expandAll", "thinkings"],
		] as const) {
			strictEqual(dispatchInteractiveAction(id, deps), true, id);
			strictEqual(calls.at(-1), label, id);
		}
	});
});

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

	it("fails a corrupted runtime overlay state closed without dispatch-board actions", () => {
		const overlay = makeDeps();
		strictEqual(routeOverlayKey("x", "corrupted" as OverlayState, overlay.deps, neverMatches), true);
		strictEqual(overlay.cancelledDispatches(), 0);
		strictEqual(overlay.steeredDispatches(), 0);
		strictEqual(overlay.closed(), 0);
	});

	it("forwards the full /context reset chooser keymap to its SelectList", () => {
		const { deps, closed } = makeDeps();
		for (const key of ["\x1b[A", "\x1b[B", "\r", ESC, KITTY_ESC]) {
			strictEqual(routeOverlayKey(key, "context-reset", deps, neverMatches), false);
		}
		strictEqual(closed(), 0, "the chooser closes through its own select/cancel callbacks");
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

	it("routes dispatch-board navigation, steer, and cancel actions", () => {
		const board = makeDeps();
		strictEqual(routeDispatchBoardOverlayKey("k", board.deps), true);
		strictEqual(routeDispatchBoardOverlayKey("\x1b[A", board.deps), true);
		strictEqual(routeDispatchBoardOverlayKey("j", board.deps), true);
		strictEqual(routeDispatchBoardOverlayKey("\x1b[B", board.deps), true);
		strictEqual(routeDispatchBoardOverlayKey("s", board.deps), true);
		strictEqual(routeDispatchBoardOverlayKey("x", board.deps), true);

		strictEqual(board.selectedPrevious(), 2);
		strictEqual(board.selectedNext(), 2);
		strictEqual(board.steeredDispatches(), 1);
		strictEqual(board.cancelledDispatches(), 1);
		strictEqual(board.closed(), 0);
	});

	it("does not invoke dispatch-board actions for key-release events", () => {
		const board = makeDeps();
		strictEqual(routeDispatchBoardOverlayKey("\x1b[115;1:3u", board.deps), false);
		strictEqual(routeDispatchBoardOverlayKey(KITTY_ESC_RELEASE, board.deps), false);
		strictEqual(board.steeredDispatches(), 0);
		strictEqual(board.closed(), 0);
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
