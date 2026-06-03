import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "../../src/engine/tui.js";
import { frame, rule } from "../../src/interactive/theme/rules.js";
import { createClioTheme } from "../../src/interactive/theme/tokens.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

describe("theme rules", () => {
	const theme = createClioTheme({ truecolor: false });

	it("renders a decorated straight rule at exact width", () => {
		const line = rule(theme, 42, { left: "compose", right: "model · mode" });
		strictEqual(visibleWidth(line), 42);
		const plain = stripAnsi(line);
		ok(plain.includes("compose"), plain);
		ok(plain.includes("model · mode"), plain);
		ok(plain.includes("─"), plain);
		ok(!plain.includes("┌"), plain);
	});

	it("truncates labels that exceed width", () => {
		const line = rule(theme, 8, { left: "compose", right: "very long" });
		strictEqual(visibleWidth(line), 8);
	});

	it("frames content with one box vocabulary", () => {
		const lines = frame(theme, "Panel", ["body"], 24);
		strictEqual(lines.length, 3);
		strictEqual(visibleWidth(lines[0] ?? ""), 24);
		strictEqual(visibleWidth(lines[1] ?? ""), 24);
		strictEqual(visibleWidth(lines[2] ?? ""), 24);
		const plain = stripAnsi(lines.join("\n"));
		ok(plain.includes("┌─ Panel "), plain);
		ok(plain.includes("│ body"), plain);
		ok(plain.includes("└"), plain);
	});
});
