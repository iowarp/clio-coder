import type { ClioKeybinding } from "../domains/config/keybindings.js";
import { isKeyRelease, matchesKey } from "../engine/tui.js";

export type OverlayState =
	| "closed"
	| "permission-confirm"
	| "dispatch-board"
	| "providers"
	| "auth"
	| "cost"
	| "context-view"
	| "context-reset"
	| "fleet"
	| "tasks"
	| "memory"
	| "view"
	| "thinking"
	| "model"
	| "scoped-models"
	| "settings"
	| "resume"
	| "tree"
	| "message-picker"
	| "cwd-fallback"
	| "ask-user"
	| "help"
	| "agents"
	| "prompts"
	| "extensions"
	| "skills-hub";

export interface PermissionOverlayKeyDeps {
	cancelPermission: () => void;
	confirmPermission: () => void;
	stopTurnFromPermission: () => void;
}

export interface DispatchBoardOverlayKeyDeps {
	closeOverlay: () => void;
	selectPreviousDispatch: () => void;
	selectNextDispatch: () => void;
	steerSelectedDispatch: () => void;
	cancelSelectedDispatch: () => void;
}

interface CloseOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface AskUserOverlayKeyDeps {
	cancelAskUser: () => void;
}

export interface OverlayKeyDeps extends PermissionOverlayKeyDeps, DispatchBoardOverlayKeyDeps, AskUserOverlayKeyDeps {}

export function isEscapeKey(data: string): boolean {
	return matchesKey(data, "escape") && !isKeyRelease(data);
}

/** Pure permission overlay key router: returns true when the input was consumed. */
export function routePermissionOverlayKey(data: string, deps: PermissionOverlayKeyDeps): boolean {
	if (matchesKey(data, "enter") && !isKeyRelease(data)) {
		deps.confirmPermission();
		return true;
	}
	if (isEscapeKey(data)) {
		deps.cancelPermission();
		return true;
	}
	// Denying one call does not stop the model asking again, and it re-asked six
	// times with the command mutated each time. Escape answers this call; `s`
	// answers the turn.
	if (matchesKey(data, "s") && !isKeyRelease(data)) {
		deps.stopTurnFromPermission();
		return true;
	}
	return false;
}

/** Pure overlay key router for the dispatch board. */
export function routeDispatchBoardOverlayKey(data: string, deps: DispatchBoardOverlayKeyDeps): boolean {
	if (isEscapeKey(data)) {
		deps.closeOverlay();
		return true;
	}
	if (isKeyRelease(data)) return false;
	if (matchesKey(data, "up") || matchesKey(data, "k")) {
		deps.selectPreviousDispatch();
		return true;
	}
	if (matchesKey(data, "down") || matchesKey(data, "j")) {
		deps.selectNextDispatch();
		return true;
	}
	if (matchesKey(data, "s")) {
		deps.steerSelectedDispatch();
		return true;
	}
	if (matchesKey(data, "x")) {
		deps.cancelSelectedDispatch();
		return true;
	}
	return false;
}

/** Pure overlay key router for the target hub. Esc closes; hub keys fall through to the focused view. */
function routeProvidersOverlayKey(data: string, deps: CloseOverlayKeyDeps): boolean {
	if (isEscapeKey(data)) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/** Pure overlay key router for auth overlays. Esc closes; input handles Enter itself. */
function routeAuthOverlayKey(data: string, deps: CloseOverlayKeyDeps): boolean {
	if (isEscapeKey(data)) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/** Pure overlay key router for the /cost overlay. Esc closes; everything else is swallowed. */
function routeCostOverlayKey(data: string, deps: CloseOverlayKeyDeps): boolean {
	if (isEscapeKey(data)) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/** Pure overlay key router for the /thinking overlay. Esc closes; arrows and Enter fall through. */
function routeThinkingOverlayKey(data: string, deps: CloseOverlayKeyDeps): boolean {
	if (isEscapeKey(data)) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/** Pure overlay key router for the /model overlay. Esc closes; arrows and Enter fall through. */
function routeModelOverlayKey(data: string, deps: CloseOverlayKeyDeps): boolean {
	if (isEscapeKey(data)) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/** Pure overlay key router for the /scoped-models overlay. */
function routeScopedModelsOverlayKey(data: string, deps: CloseOverlayKeyDeps): boolean {
	if (isEscapeKey(data)) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/** Pure overlay key router for the /settings overlay. */
function routeSettingsOverlayKey(data: string, deps: CloseOverlayKeyDeps): boolean {
	if (isEscapeKey(data)) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/** Pure overlay key router for the /fork message-picker. */
function routeMessagePickerOverlayKey(data: string, deps: CloseOverlayKeyDeps): boolean {
	if (isEscapeKey(data)) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/** Pure overlay key router for ask_user. */
function routeAskUserOverlayKey(data: string, deps: AskUserOverlayKeyDeps): boolean {
	if (isEscapeKey(data)) {
		deps.cancelAskUser();
		return true;
	}
	return false;
}

export function overlayOwnsInput(overlayState: OverlayState): boolean {
	return overlayState !== "closed";
}

export function routeOverlayKey(
	data: string,
	overlayState: OverlayState,
	deps: OverlayKeyDeps,
	matches: (data: string, id: ClioKeybinding) => boolean,
): boolean {
	if (overlayState === "closed") return false;
	if (
		(overlayState === "dispatch-board" && matches(data, "clio.dispatchBoard.toggle")) ||
		(overlayState === "tree" && matches(data, "clio.session.tree")) ||
		((overlayState === "model" || overlayState === "scoped-models") && matches(data, "clio.model.select")) ||
		(overlayState === "help" && matches(data, "clio.leader"))
	) {
		deps.closeOverlay();
		return true;
	}
	if (overlayState === "permission-confirm") {
		routePermissionOverlayKey(data, deps);
		return true;
	}
	if (overlayState === "providers") return routeProvidersOverlayKey(data, deps);
	if (overlayState === "auth") return routeAuthOverlayKey(data, deps);
	if (overlayState === "cost") {
		routeCostOverlayKey(data, deps);
		return true;
	}
	if (overlayState === "context-view") {
		routeCostOverlayKey(data, deps);
		return true;
	}
	if (overlayState === "context-reset") return false;
	if (overlayState === "fleet") return false;
	if (overlayState === "tasks") return false;
	if (overlayState === "memory") return false;
	if (overlayState === "view") return false;
	if (overlayState === "thinking") return routeThinkingOverlayKey(data, deps);
	if (overlayState === "model") return routeModelOverlayKey(data, deps);
	if (overlayState === "scoped-models") return routeScopedModelsOverlayKey(data, deps);
	if (overlayState === "settings") return routeSettingsOverlayKey(data, deps);
	if (overlayState === "resume") return false;
	if (overlayState === "tree") return false;
	if (overlayState === "message-picker") return routeMessagePickerOverlayKey(data, deps);
	if (overlayState === "cwd-fallback") return false;
	if (overlayState === "ask-user") return routeAskUserOverlayKey(data, deps);
	if (
		overlayState === "help" ||
		overlayState === "agents" ||
		overlayState === "prompts" ||
		overlayState === "extensions" ||
		overlayState === "skills-hub"
	) {
		return false;
	}
	if (overlayState === "dispatch-board") {
		routeDispatchBoardOverlayKey(data, deps);
		return true;
	}
	// Adding an OverlayState without an explicit route is a compile error. At
	// runtime an invalid cast still fails closed by swallowing the modal input.
	overlayState satisfies never;
	return true;
}
