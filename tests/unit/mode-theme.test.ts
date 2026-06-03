import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { styleForMode } from "../../src/interactive/mode-theme.js";
import { AMBER, RED_CRIT } from "../../src/interactive/palette.js";

describe("interactive/mode-theme", () => {
	it("keeps default mode on the terminal foreground", () => {
		strictEqual(styleForMode("default", "──"), "──");
	});

	it("colors advise and super mode labels distinctly", () => {
		const advise = styleForMode("advise", "mode advise");
		const superMode = styleForMode("super", "mode super");
		ok(advise.includes(AMBER), advise);
		ok(superMode.includes(RED_CRIT), superMode);
	});
});
