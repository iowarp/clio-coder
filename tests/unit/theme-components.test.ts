import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	editorTheme,
	markdownTheme,
	selectListTheme,
	settingsListTheme,
} from "../../src/interactive/theme/components.js";
import { createClioTheme } from "../../src/interactive/theme/tokens.js";

describe("theme components", () => {
	const theme = createClioTheme({ truecolor: false });

	it("builds a markdown theme from clio tokens", () => {
		const md = markdownTheme(theme, (code) => [`highlight:${code}`]);
		ok(md.heading("H").includes("\u001b[1;38;5;80m"), md.heading("H"));
		ok(md.code("x").includes("\u001b[38;5;102m"), md.code("x"));
		strictEqual(md.highlightCode?.("code", "ts")[0], "highlight:code");
	});

	it("builds select and settings list themes", () => {
		const select = selectListTheme(theme);
		ok(select.selectedText("row").includes("\u001b[1;38;5;80m"), select.selectedText("row"));
		ok(select.noMatch("empty").includes("\u001b[38;5;221m"), select.noMatch("empty"));

		const settings = settingsListTheme(theme);
		strictEqual(settings.label("Mode", false), "Mode");
		ok(settings.label("Mode", true).includes("\u001b[1;38;5;80m"), settings.label("Mode", true));
		ok(settings.value("on", true).includes("\u001b[38;5;114m"), settings.value("on", true));
	});

	it("builds an editor theme with themed rails and select list", () => {
		const editor = editorTheme(theme);
		ok(editor.borderColor("─").includes("\u001b[38;5;23m"), editor.borderColor("─"));
		ok(editor.selectList.selectedPrefix(">").includes("\u001b[38;5;80m"), editor.selectList.selectedPrefix(">"));
	});
});
