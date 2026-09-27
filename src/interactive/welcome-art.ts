import { terminalBackground } from "../core/terminal-background.js";
import { paletteProjection } from "../core/theme-token-hex.js";
import { type ClioTheme, paintHex } from "./theme/tokens.js";

/** Five-row shaded block lettering inspired by Gemini CLI's welcome wordmark. */
const LETTERS: Record<string, readonly string[]> = {
	C: [" ████", "██░  ", "██░  ", "██░  ", " ████"],
	L: ["██░  ", "██░  ", "██░  ", "██░  ", "█████"],
	I: ["███", " █ ", " █ ", " █ ", "███"],
	O: [" ███ ", "██░██", "██░██", "██░██", " ███ "],
	D: ["████ ", "██░██", "██░██", "██░██", "████ "],
	E: ["█████", "██░  ", "████ ", "██░  ", "█████"],
	R: ["████ ", "██░██", "████ ", "██░██", "██░██"],
};

const WIDE_LETTERS: Record<string, readonly string[]> = {
	C: [" ██████", "██░░░░░", "██░    ", "██░    ", " ██████"],
	L: ["██░    ", "██░    ", "██░    ", "██░    ", "███████"],
	I: ["██", "██", "██", "██", "██"],
	O: [" ██████ ", "██░░░░██", "██░   ██", "██░   ██", " ██████ "],
	D: ["██████ ", "██░░░██", "██░  ██", "██░  ██", "██████ "],
	E: ["███████", "██░░░░░", "█████  ", "██░░░  ", "███████"],
	R: ["██████ ", "██░░░██", "██████ ", "██░░██ ", "██░  ██"],
};
function stacked(font: Record<string, readonly string[]>): string[] {
	const word = (text: string) =>
		Array.from({ length: 5 }, (_, row) => [...text].map((letter) => font[letter]?.[row] ?? "").join(" "));
	const clio = word("CLIO");
	const coder = word("CODER");
	const width = coder[0]?.length ?? 0;
	return [
		...clio.map((line) => line.padStart(line.length + Math.floor((width - line.length) / 2)).padEnd(width)),
		" ".repeat(width),
		...coder,
	];
}

export const WELCOME_WORDMARK = stacked(LETTERS);
export const WELCOME_WORDMARK_WIDE = stacked(WIDE_LETTERS);

/** One vertical cyan-to-copper ramp: CLIO above, CODER below. */
export function paintWelcomeWordmark(lines: readonly string[], theme: ClioTheme): string[] {
	if (theme.fgSequence("wordmark") === "") return [...lines];
	const background = terminalBackground();
	const channels = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
	const start = channels(paletteProjection("cyanFocal", background)[0]);
	const end = channels(paletteProjection("orangeFocal", background)[0]);
	const options = { truecolor: theme.truecolor, color: true };
	// RGB interpolation keeps the complementary brand colors on a quiet neutral
	// bridge instead of swinging through unrelated green or magenta hues.
	return lines.map((line, row) => {
		const t = row / Math.max(1, lines.length - 1);
		const hex = `#${start
			.map((value, channel) =>
				Math.round(value + ((end[channel] ?? value) - value) * t)
					.toString(16)
					.padStart(2, "0"),
			)
			.join("")}`;
		return line.trim() === "" ? line : paintHex(line, hex, options);
	});
}
