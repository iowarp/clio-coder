import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { TUI } from "../../src/engine/tui.js";
import { ClioEditor } from "../../src/interactive/clio-editor.js";

const fakeTui = { requestRender: () => {}, terminal: { rows: 24 } } as unknown as TUI;
const chrome = { getModelLabel: () => "mini", getThinkingLabel: () => "off" };

function createEditor() {
	const editor = new ClioEditor(fakeTui, chrome);
	const submitted: string[] = [];
	editor.onSubmit = (text) => submitted.push(text);
	editor.onChange = () => {};
	return { editor, submitted };
}

describe("contracts/clio-editor", () => {
	it("submits a pasted slash command whose paste carried a trailing newline", () => {
		const { editor, submitted } = createEditor();
		editor.handleInput("\x1b[200~/model\n\x1b[201~");
		deepStrictEqual(submitted, ["/model"]);
		deepStrictEqual(editor.getText(), "");
	});

	it("routes a pasted unknown command through the same submit path", () => {
		const { editor, submitted } = createEditor();
		editor.handleInput("\x1b[200~/nonsense\n\x1b[201~");
		deepStrictEqual(submitted, ["/nonsense"]);
	});

	it("leaves a paste without a trailing newline unsubmitted, same as before", () => {
		const { editor, submitted } = createEditor();
		editor.handleInput("\x1b[200~/model\x1b[201~");
		deepStrictEqual(submitted, []);
		deepStrictEqual(editor.getText(), "/model");
	});
});
