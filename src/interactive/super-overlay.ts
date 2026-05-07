import { brandedBottomBorder, brandedContentRow, brandedTopBorder } from "./overlay-frame.js";

const OVERLAY_CONTENT_WIDTH = 52;
const OVERLAY_INNER_WIDTH = OVERLAY_CONTENT_WIDTH + 2;
const OVERLAY_TITLE_KEYBIND = "─ Super mode confirmation ";
const OVERLAY_TITLE_TOOL = "─ Allow this tool call? (one-time) ";

function padOverlayContent(text: string): string {
	return brandedContentRow(text.padEnd(OVERLAY_CONTENT_WIDTH), OVERLAY_CONTENT_WIDTH);
}

/**
 * Default super-confirm overlay text. Used for the persistent Alt+S
 * escalation (`origin === "keybind"`). Kept as a stable export so any caller
 * outside `renderSuperOverlayLinesForOrigin` keeps the original framing.
 */
export function renderSuperOverlayLines(): string[] {
	return [
		brandedTopBorder(OVERLAY_TITLE_KEYBIND, OVERLAY_INNER_WIDTH),
		padOverlayContent("Super mode grants privileged operations (writes"),
		padOverlayContent("outside cwd, package installs, admin queries)."),
		padOverlayContent("git_destructive remains hard-blocked. Mode"),
		padOverlayContent("persists until you exit it (Alt+M cycles back,"),
		padOverlayContent("Shift+Tab returns to default)."),
		padOverlayContent(""),
		padOverlayContent("[Enter] enter Super mode    [Esc] cancel"),
		brandedBottomBorder(OVERLAY_INNER_WIDTH),
	];
}

/**
 * Tool-driven one-shot variant. The user reached this overlay because a
 * single tool call was parked at the admission gate (e.g. a write outside
 * cwd). Confirming runs that one call under super-equivalent permission and
 * leaves the persistent mode unchanged. The text makes that explicit so the
 * user is not surprised by a silent global elevation.
 */
export function renderSuperOverlayLinesForToolGrant(): string[] {
	return [
		brandedTopBorder(OVERLAY_TITLE_TOOL, OVERLAY_INNER_WIDTH),
		padOverlayContent("A tool call needs elevated permission for this"),
		padOverlayContent("single operation, such as a write outside cwd."),
		padOverlayContent("Confirming runs only this call; the mode"),
		padOverlayContent("does NOT change. Hard-blocked actions still block."),
		padOverlayContent(""),
		padOverlayContent("[Enter] allow once    [Esc] cancel"),
		brandedBottomBorder(OVERLAY_INNER_WIDTH),
	];
}

export type SuperOverlayOrigin = "keybind" | "tool";

export function renderSuperOverlayLinesForOrigin(origin: SuperOverlayOrigin): string[] {
	return origin === "tool" ? renderSuperOverlayLinesForToolGrant() : renderSuperOverlayLines();
}
