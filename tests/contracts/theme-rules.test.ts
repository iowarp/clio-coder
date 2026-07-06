import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "../../src/engine/tui.js";
import { clioTheme, fitUnits } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

describe("contracts/theme-rules fitUnits", () => {
	const theme = clioTheme();

	it("joins every unit onto the prefix with the middot separator when they all fit", () => {
		strictEqual(stripAnsi(fitUnits(theme, "p:", ["aa", "bb", "cc"], 100)), "p:aa · bb · cc");
	});

	it("drops a whole overflowing tail behind a dim ellipsis, never a partial unit", () => {
		const fitted = fitUnits(theme, "p:", ["aaaa", "bbbb", "cccc"], 12);
		strictEqual(stripAnsi(fitted), "p:aaaa …");
		ok(fitted.includes(theme.fg("dim", "…")), "the dropped tail must close with a dim ellipsis");
		ok(!stripAnsi(fitted).includes("bbbb"), "an overflowing unit is dropped whole");
		ok(!stripAnsi(fitted).includes("cccc"), "every later unit is dropped with it");
	});

	it("hard-truncates with an ellipsis when even the first unit cannot fit", () => {
		const fitted = fitUnits(theme, "p:", ["a".repeat(20)], 10);
		ok(visibleWidth(fitted) <= 10, `first-unit overflow must respect maxWidth, got ${visibleWidth(fitted)}`);
		ok(stripAnsi(fitted).includes("…"), "a single oversized unit still marks its cut");
	});

	it("measures ANSI-styled units by their visible width, not their raw byte length", () => {
		// The styled unit carries SGR bytes that dwarf its 4-cell visible width; it
		// fits at maxWidth 4 only because the fit test is ANSI-aware.
		const styled = theme.fg("muted", "abcd");
		ok(styled.length > 4, "the styled unit should carry escape bytes for the measurement to matter");
		const fitted = fitUnits(theme, "", [styled], 4);
		strictEqual(stripAnsi(fitted), "abcd");
		strictEqual(visibleWidth(fitted), 4);
	});
});
