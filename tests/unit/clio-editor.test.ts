import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { TUI } from "../../src/engine/tui.js";
import { visibleWidth } from "../../src/engine/tui.js";
import { __clioEditorTest, ClioEditor } from "../../src/interactive/clio-editor.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

function fakeTui(rows = 24): TUI {
	return { terminal: { rows } } as unknown as TUI;
}

describe("interactive/ClioEditor", () => {
	it("renders minimal chrome without decorating typed content", () => {
		const editor = new ClioEditor(fakeTui(), {
			getModelLabel: () => "mini·llama3.3:70b",
			getThinkingLabel: () => "high",
			getMode: () => "advise",
		});
		editor.setText("draft prompt");
		const lines = editor.render(80);
		const plain = lines.map(stripAnsi);
		const text = plain.join("\n");

		strictEqual(visibleWidth(lines[0] ?? ""), 80);
		// The editor rail owns the full model identity: target·model · think · mode.
		ok(plain[0]?.includes("mini·llama3.3:70b"), plain[0]);
		ok(plain[0]?.includes("think high"), plain[0]);
		ok(plain[0]?.includes("advise"), plain[0]);
		ok(!plain[0]?.includes("compose"), plain[0]);
		ok(text.includes("draft prompt"), text);
		ok(!text.includes("⏎ send"), text);
		ok(!text.includes("⌃L model"), text);
		const typedLine = plain.find((line) => line.includes("draft prompt")) ?? "";
		strictEqual(typedLine.trim().startsWith("draft prompt"), true);
	});

	it("preserves scroll rails instead of replacing them with the model label", () => {
		const editor = new ClioEditor(fakeTui(5), {
			getModelLabel: () => "mini·qwen",
			getThinkingLabel: () => "off",
			getMode: () => "default",
		});
		editor.setText(Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n"));
		editor.handleInput("\x1b[B");
		editor.handleInput("\x1b[B");
		editor.handleInput("\x1b[B");
		editor.handleInput("\x1b[B");
		const plain = editor.render(64).map(stripAnsi);

		ok(plain[0]?.includes("↑"), plain.join("\n"));
		ok(!plain[0]?.includes("mini·qwen"), plain[0]);
	});

	it("recognizes rail rows structurally", () => {
		strictEqual(__clioEditorTest.isRail("────"), true);
		strictEqual(__clioEditorTest.isRail("─── ↓ 4 more ─"), true);
		strictEqual(__clioEditorTest.isRail("draft prompt"), false);
	});
});
