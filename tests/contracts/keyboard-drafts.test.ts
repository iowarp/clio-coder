import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { getKeybindings, setKeybindings, type Terminal, TuiMainScreen } from "../../src/engine/tui.js";
import { ClioEditor } from "../../src/interactive/clio-editor.js";
import { parseEditorBashCommand } from "../../src/interactive/editor-bash.js";
import {
	createEditorSubmitController,
	type EditorSubmitDeps,
	type EditorSubmitExpansion,
} from "../../src/interactive/editor-submit.js";
import { createKeybindingManager } from "../../src/interactive/keybinding-manager.js";
import {
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";

const noop = () => {};
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(expand?: (text: string) => Promise<EditorSubmitExpansion>) {
	const previous = getKeybindings();
	createKeybindingManager(DEFAULT_SETTINGS, {});
	cleanups.push(() => setKeybindings(previous));
	const terminal = { columns: 80, rows: 24, write: noop } as unknown as Terminal;
	const tui = new TuiMainScreen(terminal);
	const editor = new ClioEditor(tui, { getModelLabel: () => "fixture", getThinkingLabel: () => "off" });
	let queue = ["prior steer", "prior follow-up"];
	let streaming = true;
	const accepted: string[] = [];
	const errors: string[] = [];
	const uiEvents: string[] = [];
	const deps: EditorSubmitDeps = {
		editor,
		ui: { start: () => uiEvents.push("start"), stop: () => uiEvents.push("stop"), requestRender: noop },
		io: { stdout: noop, stderr: (text) => errors.push(text) },
		chat: {
			isStreaming: () => streaming,
			queueFollowUp: (text) => {
				accepted.push(text);
				return true;
			},
			clearQueuedFollowUps: () => {
				const result = queue;
				queue = [];
				return result;
			},
			interruptRefusal: () => null,
			submit: async (text) => {
				accepted.push(text);
			},
			whenSettled: async () => {},
		},
		dispatch: { snapshot: () => ({ running: [] }), steer: noop } as unknown as EditorSubmitDeps["dispatch"],
		sessionTranscript: {
			ensureSessionForLocalEntry: noop,
			refreshChatContextFromSession: noop,
			recordSubmittedTurn: noop,
		},
		chatPanel: { appendReplayBlock: noop },
		dispatchCommand: () => "accepted",
		expandSubmit: expand ?? (async (text) => ({ text, images: [] })),
		notify: noop,
	};
	const controller = createEditorSubmitController(deps);
	return {
		editor,
		deps,
		controller,
		accepted,
		errors,
		uiEvents,
		idle: () => {
			streaming = false;
		},
	};
}
for (const action of ["queueFollowUpFromEditor", "interruptFromEditor"] as const) {
	it(`${action} owns only its accepted snapshot and rejects duplicate pending presses`, async () => {
		let resume!: (value: EditorSubmitExpansion) => void;
		const f = fixture(
			() =>
				new Promise((resolve) => {
					resume = resolve;
				}),
		);
		f.editor.setText("first message");
		f.controller[action]();
		f.controller[action]();
		f.editor.setText("new draft typed while expansion waits");
		resume({ text: "first message", images: [] });
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(f.accepted, ["first message"]);
		assert.equal(
			f.editor.getText(),
			action === "interruptFromEditor"
				? "prior steer\n\nprior follow-up\n\nnew draft typed while expansion waits"
				: "new draft typed while expansion waits",
		);
	});
	it(`${action} preserves an image-bearing refused draft`, async () => {
		const f = fixture(async (text) => ({ text, images: [{}] }));
		f.editor.setText("image draft");
		f.controller[action]();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(f.editor.getText(), "image draft");
		assert.equal(f.accepted.length, 0);
		assert.equal(f.errors.length, 1);
	});
}
it("large literal paste cannot submit or acquire local-bash provenance on undo/external round trip", () => {
	const f = fixture();
	let submissions = 0;
	f.editor.onSubmit = () => {
		submissions++;
	};
	const pasted = `!echo ${"scientific text\n".repeat(90)}`;
	f.editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
	assert.equal(submissions, 0);
	assert.equal(f.editor.getExpandedText(), pasted);
	assert.equal(parseEditorBashCommand(f.editor.getTextForSubmit()), null);
	f.deps.resolveEditor = () => "fixture";
	f.deps.editExternally = (text) => {
		assert.equal(text, pasted);
		return { ok: true, text };
	};
	assert.equal(f.controller.openExternalEditorForInput(), true);
	assert.equal(parseEditorBashCommand(f.editor.getTextForSubmit()), null);
	assert.deepEqual(f.uiEvents, ["stop", "start"]);
});
it("external editor process gets expanded text; failure restores the exact original provenance", () => {
	const f = fixture();
	const root = mkdtempSync(join(tmpdir(), "clio-keyboard-editor-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const script = join(root, "editor.mjs");
	const receipt = join(root, "received.txt");
	writeFileSync(
		script,
		`import {readFileSync,writeFileSync} from 'node:fs'; const file=process.argv.at(-1); writeFileSync(${JSON.stringify(receipt)},readFileSync(file)); writeFileSync(file,'edited text');`,
	);
	f.editor.handleInput(`\x1b[200~${"many lines\n".repeat(90)}\x1b[201~`);
	const original = f.editor.getExpandedText();
	f.deps.resolveEditor = () => `${process.execPath} ${script}`;
	assert.equal(f.controller.openExternalEditorForInput(), true);
	assert.equal(readFileSync(receipt, "utf8"), original);
	assert.equal(f.editor.getText(), "edited text");
	f.editor.handleInput("\x1b[200~!literal\x1b[201~");
	const snapshot = f.editor.getTextForSubmit();
	f.deps.editExternally = () => {
		throw new Error("fixture editor failed");
	};
	assert.equal(f.controller.openExternalEditorForInput(), false);
	assert.equal(f.editor.getTextForSubmit(), snapshot);
	assert.deepEqual(f.uiEvents, ["stop", "start", "stop", "start"]);
});
it("queue recovery prefixes both queue kinds exactly once and keeps literal bang safe", () => {
	const f = fixture();
	f.editor.setLiteralText("!draft");
	f.controller.restoreQueuedFollowUpsToEditor();
	assert.equal(f.editor.getText(), "prior steer\n\nprior follow-up\n\n!draft");
	f.controller.restoreQueuedFollowUpsToEditor();
	assert.equal(f.editor.getText(), "prior steer\n\nprior follow-up\n\n!draft");
});
it("four command bridges reuse owners once and reject correctable arguments", () => {
	const calls: unknown[] = [];
	const context = {
		keyboardActions: {
			background: () => calls.push("background"),
			editor: (text: string) => {
				calls.push(["editor", text]);
				return true;
			},
			interrupt: (text: string) => calls.push(["interrupt", text]),
			dismiss: (all: boolean) => calls.push(["dismiss", all]),
			outputLabel: () => "alt+p / ctrl+g o",
		},
		notice: noop,
		render: noop,
	} as unknown as SlashCommandContext;
	for (const line of [
		"/background",
		"/editor",
		"/editor !literal",
		"/interrupt correct text",
		"/notifications dismiss",
		"/notifications dismiss all",
	])
		assert.equal(dispatchSlashCommand(parseSlashCommand(line), context), "accepted");
	assert.deepEqual(calls, [
		"background",
		["editor", ""],
		["editor", "!literal"],
		["interrupt", "correct text"],
		["dismiss", false],
		["dismiss", true],
	]);
	for (const line of ["/background extra", "/interrupt", "/notifications dismiss typo"])
		assert.equal(dispatchSlashCommand(parseSlashCommand(line), context), "rejected");
});
