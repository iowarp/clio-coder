import { doesNotMatch, match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { createClioTheme, detectTruecolor, fgSequence, SGR_RESET } from "../../src/interactive/theme/tokens.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const ESC = String.fromCharCode(27);

function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

describe("theme tokens", () => {
	it("detects truecolor from COLORTERM and TERM", () => {
		strictEqual(detectTruecolor({ COLORTERM: "truecolor" } as NodeJS.ProcessEnv), true);
		strictEqual(detectTruecolor({ COLORTERM: "24bit" } as NodeJS.ProcessEnv), true);
		strictEqual(detectTruecolor({ TERM: "xterm-truecolor" } as NodeJS.ProcessEnv), true);
		strictEqual(detectTruecolor({} as NodeJS.ProcessEnv), false);
	});

	it("paints truecolor fg with a full reset and leaves text intact when stripped", () => {
		const theme = createClioTheme({ truecolor: true });
		const out = theme.fg("accent", "hi");
		match(out, new RegExp(`${ESC}\\[38;2;70;229;208mhi${ESC}\\[0m`));
		strictEqual(stripAnsi(out), "hi");
	});

	it("falls back to 256-color fg when truecolor is off", () => {
		const theme = createClioTheme({ truecolor: false });
		match(theme.fg("accent", "hi"), new RegExp(`${ESC}\\[38;5;80mhi${ESC}\\[0m`));
	});

	it("composes fg, bg, and bold in one span", () => {
		const theme = createClioTheme({ truecolor: false });
		match(
			theme.paint("x", { fg: "title", bg: "accentDeep", bold: true }),
			new RegExp(`${ESC}\\[1;38;5;80;48;5;44mx${ESC}\\[0m`),
		);
	});

	it("returns plain text when no mods are given", () => {
		const theme = createClioTheme({ truecolor: false });
		strictEqual(theme.paint("plain", {}), "plain");
	});

	it("fgSequence returns a bare prefix and SGR_RESET is a full reset", () => {
		strictEqual(SGR_RESET, "\u001b[0m");
		const seq = fgSequence("warning", false);
		strictEqual(seq, "\u001b[38;5;221m");
		doesNotMatch(seq, new RegExp(`${ESC}\\[0m`));
	});
});
