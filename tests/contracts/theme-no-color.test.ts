import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { createClioTheme } from "../../src/interactive/theme/tokens.js";

const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[([0-9;]*)m`, "gu");

function codes(text: string): string[] {
	return [...text.matchAll(SGR)].map((match) => match[1] ?? "").filter((code) => code !== "" && code !== "0");
}

// Clio ignored NO_COLOR entirely. A pty session launched with NO_COLOR=1 wrote
// 961 non-reset SGR sequences in its first three seconds, 704 of them the
// 24-bit frame color. The variable exists to stop exactly that.
describe("contracts/theme honors NO_COLOR", () => {
	it("emits no foreground or background codes when color is off", () => {
		const theme = createClioTheme({ truecolor: true, color: false });

		strictEqual(codes(theme.fg("error", "boom")).length, 0);
		strictEqual(codes(theme.bg("accent", "chip")).length, 0);
		strictEqual(theme.fgSequence("warning"), "");
		strictEqual(theme.fg("error", "boom"), "boom", "an unstyled run carries no escape at all");
	});

	it("keeps the attributes that are not color, because they are what is left to read by", () => {
		const theme = createClioTheme({ truecolor: true, color: false });
		const styled = theme.style("title", "Memory", { bold: true });

		ok(styled.includes("Memory"));
		strictEqual(codes(styled).join(), "1", "bold survives; the color code does not");

		const both = theme.paint("x", { fg: "error", dim: true, underline: true });
		strictEqual(codes(both).join(), "2;4");
	});

	it("still paints when color is on, so the default path is unchanged", () => {
		const theme = createClioTheme({ truecolor: true, color: true });

		strictEqual(codes(theme.fg("error", "boom")).join(), "38;2;255;92;102");
		ok(theme.fgSequence("warning").length > 0);
	});
});
