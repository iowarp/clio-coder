import type { Component } from "../engine/tui.js";

const SUPER_OVERLAY_CONTENT_WIDTH = 52;

const KEYBIND_BODY_LINES = [
	"Super mode grants privileged operations (writes",
	"outside cwd, package installs, admin queries).",
	"git_destructive remains hard-blocked. Mode",
	"persists until you exit it (Alt+M cycles back,",
	"Shift+Tab returns to default).",
	"",
	"[Enter] enter Super mode    [Esc] cancel",
] as const;

const TOOL_BODY_LINES = [
	"A tool call needs elevated permission for this",
	"single operation, such as a write outside cwd.",
	"Confirming runs only this call; the mode",
	"does NOT change. Hard-blocked actions still block.",
	"",
	"[Enter] allow once    [Esc] cancel",
] as const;

export const SUPER_OVERLAY_WIDTH = SUPER_OVERLAY_CONTENT_WIDTH + 4;

export type SuperOverlayOrigin = "keybind" | "tool";

class SuperOverlayBody implements Component {
	constructor(private readonly lines: readonly string[]) {}

	render(_width: number): string[] {
		return [...this.lines];
	}

	invalidate(): void {}
}

export function superOverlayTitleForOrigin(origin: SuperOverlayOrigin): string {
	return origin === "tool" ? "Allow this tool call? (one-time)" : "Super mode confirmation";
}

export function createSuperOverlayBody(origin: SuperOverlayOrigin): Component {
	return new SuperOverlayBody(origin === "tool" ? TOOL_BODY_LINES : KEYBIND_BODY_LINES);
}
