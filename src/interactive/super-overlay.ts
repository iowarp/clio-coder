import { brandedBottomBorder, brandedContentRow, brandedTopBorder } from "./overlay-frame.js";

const OVERLAY_CONTENT_WIDTH = 52;
const OVERLAY_INNER_WIDTH = OVERLAY_CONTENT_WIDTH + 2;
const OVERLAY_TITLE = "─ Super mode confirmation ";

function padOverlayContent(text: string): string {
	return brandedContentRow(text.padEnd(OVERLAY_CONTENT_WIDTH), OVERLAY_CONTENT_WIDTH);
}

export function renderSuperOverlayLines(): string[] {
	return [
		brandedTopBorder(OVERLAY_TITLE, OVERLAY_INNER_WIDTH),
		padOverlayContent("Super mode grants privileged operations (writes"),
		padOverlayContent("outside cwd, package installs, admin queries). Some"),
		padOverlayContent("actions (system_modify, git_destructive) remain"),
		padOverlayContent("hard-blocked."),
		padOverlayContent(""),
		padOverlayContent("[Enter] confirm    [Esc] cancel"),
		brandedBottomBorder(OVERLAY_INNER_WIDTH),
	];
}
