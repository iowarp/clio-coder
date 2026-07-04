import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "../../src/engine/tui.js";
import { formatKeybindingDetailBodyLines } from "../../src/interactive/overlays/keybinding-detail.js";
import { clioTheme, GLYPH } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
const boldAccentPrefix = (): string => clioTheme().style("accent", "", { bold: true }).replace(`${ESC}[0m`, "");

describe("contracts/keybinding-detail", () => {
	it("renders keybinding facts as themed rows without overflowing", () => {
		const lines = formatKeybindingDetailBodyLines(
			{
				id: "clio.exit",
				keys: "Ctrl+D",
				action: "Exit the interactive terminal immediately",
				source: "user",
				warnings: ["ctrl+d may not fire because the terminal captures superlongterminalwordthatmustbetruncated"],
			},
			44,
		);
		const body = stripAnsi(lines.join("\n"));
		const actionLine = lines.find((line) => stripAnsi(line).startsWith("Action")) ?? "";
		const keysLine = lines.find((line) => stripAnsi(line).startsWith("Keys")) ?? "";
		const warningLine = lines.find((line) => stripAnsi(line).startsWith("Warning")) ?? "";

		ok(body.includes("Action"), body);
		ok(body.includes("Edit settings.yaml under"), body);
		ok(body.includes("keybindings, then restart"), body);
		ok(!body.includes("settings.yaml > keybindings"), "the detail text should not use a literal arrow breadcrumb");
		ok(actionLine.includes(clioTheme().fgSequence("dim")), "row labels use the dim token");
		ok(actionLine.includes(clioTheme().fgSequence("muted")), "row values use the muted token");
		ok(keysLine.includes(boldAccentPrefix()), "key affordances use the bold accent token");
		ok(stripAnsi(warningLine).includes(GLYPH.warnInline), "warnings use the shared inline warning glyph");
		ok(warningLine.includes(clioTheme().fgSequence("warning")), "warning glyph uses the warning token");
		ok(
			lines.some((line) => stripAnsi(line).includes("…")),
			"long warning text should truncate with an ellipsis",
		);
		for (const line of lines) strictEqual(visibleWidth(line) <= 44, true, `line overflows: ${stripAnsi(line)}`);
	});
});
