import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { CLIO_KEYBINDINGS } from "../../src/domains/config/keybindings.js";
import { KeybindingsManager, setKeybindings, type TUI, visibleWidth } from "../../src/engine/tui.js";
import { ClioEditor, type EditorChrome } from "../../src/interactive/clio-editor.js";
import { createSlashCommandAutocompleteProvider } from "../../src/interactive/slash-autocomplete.js";
import { clioTheme } from "../../src/interactive/theme/index.js";

const fakeTui = { requestRender: () => {}, terminal: { rows: 24 } } as unknown as TUI;
const chrome: EditorChrome = {
	getModelLabel: () => "mini",
	getThinkingLabel: () => "off",
	isStreaming: () => false,
	willEnterSteer: (text) => text.trim().length > 0,
	getSubmitKeyLabel: () => "Enter",
	getNewlineKeyLabel: () => "Shift+Enter",
};
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "gu");
const CURSOR_MARKER = "\x1b_pi:c\x07";

function plain(line: string): string {
	return line.replace(ANSI, "").replaceAll(CURSOR_MARKER, "");
}

function createEditor(overrides: Partial<EditorChrome> = {}, tui = fakeTui) {
	const editor = new ClioEditor(tui, { ...chrome, ...overrides });
	const submitted: string[] = [];
	editor.onSubmit = (text) => submitted.push(text);
	editor.onChange = () => {};
	return { editor, submitted };
}

describe("contracts/clio-editor", () => {
	it("renders an idle empty composer with identity, placeholder, and real send/newline bindings", () => {
		const { editor } = createEditor();
		editor.focused = true;
		const cursorBefore = editor.getCursor();
		const lines = editor.render(80);

		ok(plain(lines[0] ?? "").startsWith("MESSAGE "));
		ok(plain(lines[0] ?? "").includes("mini · off"));
		ok(plain(lines[1] ?? "").includes("Ask Clio…  / for commands"));
		ok(plain(lines[2] ?? "").includes("Enter send · Shift+Enter newline"));
		strictEqual((lines[1] ?? "").includes(CURSOR_MARKER), true, "placeholder keeps the hardware cursor marker");
		deepStrictEqual(editor.getCursor(), cursorBefore, "placeholder rendering does not move the editor cursor");
		for (const line of lines) strictEqual(visibleWidth(line.replaceAll(CURSOR_MARKER, "")), 80);
	});

	it("removes the placeholder for non-empty and multiline drafts without changing base layout", () => {
		const { editor } = createEditor();
		editor.setText("first line");
		let lines = editor.render(80);
		strictEqual(
			lines.some((line) => plain(line).includes("Ask Clio")),
			false,
		);
		strictEqual(lines.length, 3, "single-line draft keeps the base top/content/bottom shape");

		editor.setText("first line\nsecond line");
		lines = editor.render(80);
		strictEqual(
			lines.some((line) => plain(line).includes("Ask Clio")),
			false,
		);
		strictEqual(lines.length, 4, "multiline draft retains both base Editor content rows");
		ok(lines.some((line) => plain(line).includes("first line")));
		ok(lines.some((line) => plain(line).includes("second line")));
	});

	it("drops the teaching hint at 40 columns before model identity or draft content", () => {
		const { editor } = createEditor();
		editor.setText("keep this draft visible");
		const lines = editor.render(40);

		ok(plain(lines[0] ?? "").startsWith("MESSAGE "));
		ok(plain(lines[0] ?? "").includes("mini · off"));
		ok(lines.some((line) => plain(line).includes("keep this draft visible")));
		strictEqual(
			lines.some((line) => plain(line).includes("Enter send")),
			false,
		);
		for (const line of lines) strictEqual(visibleWidth(line), 40);
	});

	it("uses FOLLOW-UP while streaming empty and one orange STEER tag only for a steerable draft", () => {
		let streaming = true;
		const { editor } = createEditor({ isStreaming: () => streaming });
		const theme = clioTheme();
		const actionSequence = theme.fgSequence("action");
		const actionTagOpener = theme.style("action", " ", { bold: true }).split(" ")[0] ?? "";
		let lines = editor.render(80);
		ok(plain(lines[0] ?? "").startsWith("FOLLOW-UP "));
		if (actionSequence.length > 0) strictEqual((lines[0] ?? "").includes(actionTagOpener), false);

		editor.setText("correct the active run");
		lines = editor.render(80);
		ok(plain(lines[0] ?? "").startsWith("STEER "));
		if (actionSequence.length > 0) strictEqual(lines.join("\n").split(actionTagOpener).length - 1, 1);

		streaming = false;
		lines = editor.render(80);
		ok(plain(lines[0] ?? "").startsWith("MESSAGE "));
		if (actionSequence.length > 0) strictEqual((lines[0] ?? "").includes(actionTagOpener), false);
	});

	it("keeps streaming local-command drafts non-orange when Enter will not steer", () => {
		const { editor } = createEditor({
			isStreaming: () => true,
			willEnterSteer: (text) => !text.startsWith("/") && !text.startsWith("!"),
		});
		for (const draft of ["/help", "!pwd"]) {
			editor.setText(draft);
			const topRail = editor.render(80)[0] ?? "";
			ok(plain(topRail).startsWith("FOLLOW-UP "), `${draft} is not presented as a steer`);
		}
	});

	it("folds a streaming STEER tag into an occupied scroll-indicator rail", () => {
		const shortTui = { requestRender: () => {}, terminal: { rows: 10 } } as unknown as TUI;
		const { editor } = createEditor({ isStreaming: () => true }, shortTui);
		editor.setText(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"));
		const cursorBefore = editor.getCursor();
		const lines = editor.render(80);
		const theme = clioTheme();
		const actionSequence = theme.fgSequence("action");
		const actionTagOpener = theme.style("action", " ", { bold: true }).split(" ")[0] ?? "";

		ok(plain(lines[0] ?? "").startsWith("STEER "), "the mode remains the first rail signal");
		ok(plain(lines[0] ?? "").includes("↑ 3 more"), "the base top scroll indicator survives");
		if (actionSequence.length > 0) {
			ok((lines[0] ?? "").includes(actionTagOpener), "STEER keeps the action token in the indicator row");
			strictEqual(lines.join("\n").split(actionTagOpener).length - 1, 1, "the editor has only one orange element");
		}
		for (const line of lines) strictEqual(visibleWidth(line), 80);
		deepStrictEqual(editor.getCursor(), cursorBefore);
	});

	it("keeps autocomplete rows open and separate from the composer rails", async () => {
		const { editor } = createEditor();
		editor.setAutocompleteProvider(createSlashCommandAutocompleteProvider({ fdPath: null }));
		editor.setText("/context ");
		editor.handleInput("i");
		for (let attempt = 0; attempt < 10 && editor.render(80).length < 4; attempt += 1) {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		const lines = editor.render(80);

		ok(plain(lines[0] ?? "").startsWith("MESSAGE "));
		ok(lines.some((line) => line.includes("Initialize project context")));
		ok(lines.some((line) => plain(line).includes("Enter send · Shift+Enter newline")));
		strictEqual(
			lines.some((line) => plain(line).includes("Ask Clio")),
			false,
		);
		for (const line of lines) strictEqual(visibleWidth(line), 80);
	});

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

	it("browses accepted prompt history with Ctrl+P and Ctrl+N while preserving the draft", () => {
		setKeybindings(new KeybindingsManager(CLIO_KEYBINDINGS));
		const { editor } = createEditor();
		editor.addToHistory("first prompt");
		editor.addToHistory("second prompt");
		editor.addToHistory("  second prompt  ");
		editor.setText("unfinished draft");

		editor.handleInput("\x10");
		strictEqual(editor.getText(), "second prompt");
		editor.handleInput("\x10");
		strictEqual(editor.getText(), "first prompt");
		editor.handleInput("\x0e");
		strictEqual(editor.getText(), "second prompt");
		editor.handleInput("\x0e");
		strictEqual(editor.getText(), "unfinished draft");
	});
});
