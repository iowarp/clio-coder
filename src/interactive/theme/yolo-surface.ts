import { extractAnsiCode } from "../../engine/tui.js";
import { padAnsi } from "./rules.js";
import {
	type ClioTheme,
	projectsYolo,
	type SemanticRole,
	SGR_RESET,
	sgrResetsForeground,
	skinEpoch,
	withThemeContext,
} from "./tokens.js";

/** Preserve explicit selection/diff backgrounds and their own text colors. */
function inlineBackgroundAfter(code: string, previous: boolean): boolean {
	const values = code.slice(2, -1).split(";").map(Number);
	let active = previous;
	for (let index = 0; index < values.length; index += 1) {
		const value = values[index];
		if (value === 0 || value === 49) active = false;
		else if ((value !== undefined && value >= 40 && value <= 47) || (value !== undefined && value >= 100 && value <= 107))
			active = true;
		else if (value === 38 || value === 48 || value === 58) {
			if (value === 48) active = true;
			index += values[index + 1] === 2 ? 4 : values[index + 1] === 5 ? 2 : 0;
		}
	}
	return active;
}

/** A static composer surface; cached rows preserve inline colors and explicit backgrounds. */
export function createComposerSurfacePainter(
	theme: ClioTheme,
	width: number,
	baseRole: SemanticRole = "inputText",
): (line: string) => string {
	const context = theme.context;
	let background = "";
	let foreground = "";
	let paintedEpoch = -1;
	const rows = new Map<string, string>();
	return (line: string): string => {
		if (paintedEpoch !== skinEpoch()) {
			paintedEpoch = skinEpoch();
			rows.clear();
			withThemeContext(context, () => {
				background = projectsYolo(context) ? theme.bg("composerSurface", "").replace(SGR_RESET, "") : "";
				foreground = theme.fgSequence(baseRole);
			});
		}
		if (!foreground && !background) return line;
		const cached = rows.get(line);
		if (cached !== undefined) return cached;
		const fitted = padAnsi(line, width);
		let output = `${background}${foreground}`;
		let inlineBackground = false;
		for (let index = 0; index < fitted.length; ) {
			const ansi = extractAnsiCode(fitted, index);
			if (ansi) {
				const code = ansi.code;
				output += code;
				if (code.startsWith("\u001b[") && code.endsWith("m")) {
					inlineBackground = inlineBackgroundAfter(code, inlineBackground);
					if (sgrResetsForeground(code)) output += foreground;
					if (!inlineBackground) output += background;
				}
				index += ansi.length;
				continue;
			}
			const nextEscape = fitted.indexOf("\u001b", index + 1);
			const end = nextEscape < 0 ? fitted.length : nextEscape;
			output += fitted.slice(index, end);
			index = end;
		}
		const painted = `${output}${SGR_RESET}`;
		if (rows.size >= 64) rows.clear();
		rows.set(line, painted);
		return painted;
	};
}
