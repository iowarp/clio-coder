import { type ClioTheme, type ClioToken, type RuleOptions, rule } from "./theme/index.js";

export interface EditorRailState {
	phase: "idle" | "working" | "attention";
	yolo: boolean;
	animate: boolean;
	now: number;
}

/** Presentation only. Reuses the existing render ticker; never owns input or timers. */
export function renderEditorRail(
	theme: ClioTheme,
	width: number,
	options: RuleOptions,
	state: EditorRailState,
): string {
	const line = rule(theme, width, { ...options, fillToken: "editor" });
	return line.replace(/─+/gu, (fill) => {
		const tokens: ClioToken[] = ["editorAction", "editorAction", "action", "editor", "editor", "accent", "accent"];
		const center = Math.floor(((state.now % 3600) / 3600) * (fill.length + 14)) - 7;
		let output = "";
		let runToken: ClioToken | null = null;
		let run = "";
		for (let column = 0; column < fill.length; column += 1) {
			let token: ClioToken = "editor";
			if (state.phase === "attention") {
				const wave = Math.abs(column - center);
				token = !state.animate || wave >= 9 ? "editorAction" : wave < 3 ? "warning" : wave < 6 ? "editorAction" : "action";
			} else if (state.phase === "working" && state.animate) {
				const distance = Math.abs(column - center);
				if (distance < tokens.length) token = tokens[distance] ?? "editor";
			}
			// Fixed endcaps retain the safety signal through every animation phase.
			if (state.yolo && (column < 3 || column >= fill.length - 3)) token = "editorDanger";
			if (runToken !== token && runToken !== null) {
				output += theme.style(runToken, run, { bold: true });
				run = "";
			}
			runToken = token;
			run += "━";
		}
		return output + (runToken ? theme.style(runToken, run, { bold: true }) : "");
	});
}
