import { terminalBackground } from "../core/terminal-background.js";
import { colorDepth } from "../core/terminal-preferences.js";
import { type ClioTheme, paintHex, paletteRgb } from "./theme/tokens.js";

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
/** Rows of the stacked wordmark that spell CLIO; a blank row and CODER follow. */
const STACKED_CLIO_ROWS = 5;
const BAND_GAP = "   ";
/** Cells of CLIO on the one band, before the gap and CODER. */
const BAND_CLIO_WIDTH = [..."CLIO"].map((letter) => LETTERS[letter]?.[0] ?? "").join(" ").length;
/** The compact letters on one band, CLIO then CODER, for panels too narrow to set the art beside the details. */
export const WELCOME_WORDMARK_ROW: readonly string[] = Array.from({ length: 5 }, (_, row) =>
	["CLIO", "CODER"].map((text) => [...text].map((letter) => LETTERS[letter]?.[row] ?? "").join(" ")).join(BAND_GAP),
);

/**
 * At 16 colors a ramp has no steps to stand on, so the brand is two flat tones: CLIO in the `wordmark` role and CODER
 * in `brandCopper`, which project to ANSI cyan and yellow.
 */
function flatTones(theme: ClioTheme): boolean {
	return colorDepth() === "16" && theme.fgSequence("wordmark") !== "";
}

/** The one-band mark runs from cyan CLIO at left to copper CODER at right. */
export function paintWelcomeRowWordmark(theme: ClioTheme): string[] {
	if (theme.fgSequence("wordmark") === "") return [...WELCOME_WORDMARK_ROW];
	if (flatTones(theme))
		return WELCOME_WORDMARK_ROW.map(
			(line) =>
				`${theme.fg("wordmark", line.slice(0, BAND_CLIO_WIDTH))}${BAND_GAP}${theme.fg("brandCopper", line.slice(BAND_CLIO_WIDTH + BAND_GAP.length))}`,
		);
	const background = terminalBackground();
	const start = paletteRgb("cyanFocal", background);
	const end = paletteRgb("orangeFocal", background);
	const options = { truecolor: theme.truecolor, color: true };
	return WELCOME_WORDMARK_ROW.map((line) =>
		[...line]
			.map((glyph, column) => {
				if (glyph === " ") return glyph;
				const t = column / Math.max(1, line.length - 1);
				const hex = `#${start
					.map((value, channel) =>
						Math.round(value + ((end[channel] ?? value) - value) * t)
							.toString(16)
							.padStart(2, "0"),
					)
					.join("")}`;
				return paintHex(glyph, hex, options);
			})
			.join(""),
	);
}

/** One vertical cyan-to-copper ramp: CLIO above, CODER below. */
export function paintWelcomeWordmark(lines: readonly string[], theme: ClioTheme): string[] {
	if (theme.fgSequence("wordmark") === "") return [...lines];
	if (flatTones(theme))
		return lines.map((line, row) =>
			line.trim() === "" ? line : theme.fg(row < STACKED_CLIO_ROWS ? "wordmark" : "brandCopper", line),
		);
	const background = terminalBackground();
	const start = paletteRgb("cyanFocal", background);
	const end = paletteRgb("orangeFocal", background);
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
