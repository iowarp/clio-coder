import { type ClioTheme, type ClioToken, type RuleOptions, rule } from "./theme/index.js";

export interface EditorRailState {
	phase: "idle" | "working" | "attention";
	yolo: boolean;
	animate: boolean;
	now: number;
	/** The rail's own ink while a decision owns the editor; the composer rail otherwise. */
	tone?: ClioToken;
}

/** Presentation only. Reuses the existing render ticker; never owns input or timers. */
export function renderEditorRail(
	theme: ClioTheme,
	width: number,
	options: RuleOptions,
	state: EditorRailState,
): string {
	const attention = state.phase === "attention";
	const base: ClioToken = state.tone ?? "composerRail";
	const paint = (columns: number, token: ClioToken): string => theme.style(token, "━".repeat(columns), { bold: true });
	if (!attention || !state.animate) {
		return rule(theme, width, {
			...options,
			fillToken: base,
			rightTail: options.rightTail ?? paint(1, base),
			renderFill: (columns) => paint(columns, base),
		});
	}
	// Both rails share a viewport coordinate, so labels never put their pulses out of step.
	const center = Math.floor(((state.now % 3600) / 3600) * (width + 8)) - 4;
	const renderFill = (columns: number, offset: number): string => {
		let output = "";
		let runToken: ClioToken = base;
		let run = 0;
		for (let column = 0; column < columns; column += 1) {
			let token: ClioToken = base;
			const distance = state.animate ? Math.abs(column + offset - center) : column + offset;
			if (distance < 4) {
				token = "attentionRail";
			}
			if (run > 0 && runToken !== token) {
				output += paint(run, runToken);
				run = 0;
			}
			runToken = token;
			run += 1;
		}
		return output + (run > 0 ? paint(run, runToken) : "");
	};
	return rule(theme, width, {
		...options,
		fillToken: base,
		rightTail: options.rightTail ?? renderFill(1, Math.max(0, width - 1)),
		renderFill,
	});
}
