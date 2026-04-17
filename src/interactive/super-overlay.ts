const OVERLAY_CONTENT_WIDTH = 52;
const OVERLAY_INNER_WIDTH = OVERLAY_CONTENT_WIDTH + 2;
const OVERLAY_TITLE = "─ Super mode confirmation ";

function padOverlayContent(text: string): string {
	return `│ ${text.padEnd(OVERLAY_CONTENT_WIDTH)} │`;
}

export function renderSuperOverlayLines(): string[] {
	return [
		`┌${OVERLAY_TITLE.padEnd(OVERLAY_INNER_WIDTH, "─")}┐`,
		padOverlayContent("Super mode grants privileged operations (writes"),
		padOverlayContent("outside cwd, package installs, admin queries). Some"),
		padOverlayContent("actions (system_modify, git_destructive) remain"),
		padOverlayContent("hard-blocked."),
		padOverlayContent(""),
		padOverlayContent("[Enter] confirm    [Esc] cancel"),
		`└${"─".repeat(OVERLAY_INNER_WIDTH)}┘`,
	];
}
