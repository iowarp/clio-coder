import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { SelectList, type SelectListTheme } from "../../src/engine/tui.js";
import { clioTheme, GLYPH, selectListTheme } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
const PI_ARROW = String.fromCharCode(0x2192);

describe("contracts/select-list", () => {
	it("renders the design cursor on the selected row instead of pi-tui's arrow", () => {
		const list = new SelectList(
			[
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
			5,
			selectListTheme(clioTheme()),
		);
		const lines = list.render(80).map(stripAnsi);
		const selected = lines.find((l) => l.includes("Alpha")) ?? "";
		ok(selected.includes(GLYPH.cursor), `selected row should use ${GLYPH.cursor}, got: ${selected}`);
		ok(!selected.includes(PI_ARROW), "pi-tui's arrow must not survive on the selected row");
		const unselected = lines.find((l) => l.includes("Beta")) ?? "";
		ok(!unselected.includes(GLYPH.cursor), "unselected rows carry no cursor");
	});

	it("rewrites only the prefix, leaving an arrow inside a label intact", () => {
		const list = new SelectList([{ value: "a", label: `A ${PI_ARROW} B` }], 5, selectListTheme(clioTheme()));
		const selected = stripAnsi(list.render(80).find((l) => l.includes("A ")) ?? "");
		ok(selected.startsWith(`${GLYPH.cursor} `), "the leading prefix becomes the design cursor");
		ok(selected.includes(`A ${PI_ARROW} B`), "an arrow inside the label is preserved");
	});

	it("preserves pi-tui's arrow when the theme omits a cursor", () => {
		const full = selectListTheme(clioTheme());
		const themeWithoutCursor: SelectListTheme = {
			selectedPrefix: full.selectedPrefix,
			selectedText: full.selectedText,
			description: full.description,
			scrollInfo: full.scrollInfo,
			noMatch: full.noMatch,
		};
		const list = new SelectList([{ value: "a", label: "Alpha" }], 5, themeWithoutCursor);
		const selected = stripAnsi(list.render(80).find((l) => l.includes("Alpha")) ?? "");
		ok(selected.includes(PI_ARROW), "without a themed cursor the engine leaves pi-tui's arrow in place");
	});
});
