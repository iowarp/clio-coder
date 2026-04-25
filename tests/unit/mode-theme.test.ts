import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { editorBorderColorForMode, styleForMode } from "../../src/interactive/mode-theme.js";

describe("interactive/mode-theme", () => {
	it("keeps default mode on the terminal foreground", () => {
		strictEqual(styleForMode("default", "──"), "──");
		strictEqual(editorBorderColorForMode("default")("──"), "──");
	});

	it("colors advise and super prompt rails distinctly", () => {
		const advise = editorBorderColorForMode("advise")("──");
		const superMode = editorBorderColorForMode("super")("──");
		ok(advise.includes("\u001b[38;5;214m"), advise);
		ok(superMode.includes("\u001b[38;5;203m"), superMode);
	});
});
