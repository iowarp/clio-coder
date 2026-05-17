import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { editorBorderColorForMode, styleForMode } from "../../src/interactive/mode-theme.js";
import { AMBER, RED_CRIT } from "../../src/interactive/palette.js";

describe("interactive/mode-theme", () => {
	it("keeps default mode on the terminal foreground", () => {
		strictEqual(styleForMode("default", "──"), "──");
		strictEqual(editorBorderColorForMode("default")("──"), "──");
	});

	it("colors advise and super prompt rails distinctly", () => {
		const advise = editorBorderColorForMode("advise")("──");
		const superMode = editorBorderColorForMode("super")("──");
		ok(advise.includes(AMBER), advise);
		ok(superMode.includes(RED_CRIT), superMode);
	});
});
