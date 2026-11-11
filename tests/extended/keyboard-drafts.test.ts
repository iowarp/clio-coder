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
} from "../../src/session-control/slash-commands.js";

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
			runningToolCalls: () => 0,
			queueEntries: () => [],
			removeQueuedEntry: () => null,
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
for (const action of ["interruptFromEditor"] as const) {
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
		// The expansion starts after the async egg-discovery seam, so let it
		// reach its pending state before the draft changes and the deferred resolves.
		await new Promise((resolve) => setImmediate(resolve));
		f.editor.setText("new draft typed while expansion waits");
		resume({ text: "first message", images: [] });
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(f.accepted, ["first message"]);
		// The queue stays queued across a send-now; only the newer draft remains.
		assert.equal(f.editor.getText(), "new draft typed while expansion waits");
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
// A template with tool constraints sent now while a tool ran was refused by the
// chat loop, yet the editor was already empty and "queued ahead" was shown.
it("a send-now the live run refuses keeps its draft and reports nothing queued", async () => {
	const f = fixture(async (text) => ({ text, images: [], constraints: { allowedTools: ["read"] } }));
	const notices: string[] = [];
	f.deps.notify = (_level, text) => notices.push(text);
	f.deps.chat.runningToolCalls = () => 1;
	f.deps.askSendNow = async () => "wait";
	f.deps.chat.submit = async (_text, options) => options?.onRefused?.("constrained-turn-in-flight");
	f.editor.setText("/review src");
	f.controller.interruptFromEditor();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.editor.getText(), "/review src");
	assert.deepEqual(notices, []);
});
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
it("retired key commands name their key and run nothing", () => {
	const notices: string[] = [];
	const context = {
		keyboardActions: { menuLabel: (letter: string) => `Ctrl+G ${letter.toUpperCase()}` },
		notice: (_level: string, text: string) => notices.push(text),
		render: noop,
	} as unknown as SlashCommandContext;
	for (const line of ["/background", "/editor", "/interrupt correct text", "/notifications dismiss"])
		assert.equal(dispatchSlashCommand(parseSlashCommand(line), context), "rejected");
	assert.deepEqual(notices, [
		"/background is now a key: Ctrl+G D.",
		"/editor is now a key: Ctrl+G G.",
		"/interrupt is now a key: Ctrl+G S.",
		"/notifications is now a key: Ctrl+G X.",
	]);
	const retired = parseSlashCommand("/interrupt correct text");
	assert.equal(retired.kind === "retired" ? retired.rest : undefined, "correct text");
});
it("clearing pasted input lets a newly typed bang become an intentional command", () => {
	const f = fixture();
	f.editor.handleInput("\x1b[200~!literal\x1b[201~");
	f.editor.applyEdit("deleteToLineStart");
	assert.equal(f.editor.getText(), "");
	f.editor.handleInput("!echo typed");
	assert.deepEqual(parseEditorBashCommand(f.editor.getTextForSubmit()), {
		command: "echo typed",
		excludeFromContext: false,
	});
});

it("undo restores a large pasted bang token as literal while a typed prefix remains deliberate", () => {
	const f = fixture();
	const pasted = `!echo ${"literal ".repeat(2000)}`;
	f.editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
	assert.notEqual(f.editor.getText(), pasted);
	f.editor.applyEdit("deleteToLineStart");
	assert.equal(f.editor.getText(), "");
	f.editor.applyEdit("undo");
	assert.equal(f.editor.getExpandedText(), pasted);
	assert.equal(parseEditorBashCommand(f.editor.getTextForSubmit()), null);
	f.editor.handleInput("\x1b[H");
	f.editor.handleInput("!typed ");
	assert.ok(parseEditorBashCommand(f.editor.getTextForSubmit()));
});
it("keeps a large paste literal when deleting preceding typed text exposes its bang", () => {
	const f = fixture();
	f.editor.handleInput("x");
	const pasted = `!echo ${"literal ".repeat(2000)}`;
	f.editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
	f.editor.handleInput("\x1b[H");
	f.editor.applyEdit("deleteCharForward");
	assert.equal(f.editor.getExpandedText(), pasted);
	assert.equal(parseEditorBashCommand(f.editor.getTextForSubmit()), null);
});

it("Enter on a slash row that leaves the typed line unchanged submits it", async () => {
	const previous = getKeybindings();
	createKeybindingManager(DEFAULT_SETTINGS, {});
	cleanups.push(() => setKeybindings(previous));
	// Submitting schedules a render, so every terminal method the render touches is a no-op.
	const terminal = new Proxy({ columns: 80, rows: 24 }, { get: (target, key) => Reflect.get(target, key) ?? noop });
	const tui = new TuiMainScreen(terminal as unknown as Terminal);
	const editor = new ClioEditor(tui, { getModelLabel: () => "fixture", getThinkingLabel: () => "off" });
	const submitted: string[] = [];
	editor.onSubmit = (text) => submitted.push(text);
	const rows = ["claude-sonnet-5.5", "claude-sonnet-5.5-fast"].map((model) => ({
		value: model,
		label: model,
		path: `model › ${model}`,
	}));
	editor.setAutocompleteProvider({
		getSuggestions: async (lines: string[], _line: number, col: number) => {
			const prefix = (lines[0] ?? "").slice("/model ".length, col);
			return { prefix, items: rows.filter((row) => row.value.startsWith(prefix)) };
		},
		applyCompletion: (lines: string[], _line: number, _col: number, item: { value: string }, prefix: string) => {
			const text = `${(lines[0] ?? "").slice(0, (lines[0] ?? "").length - prefix.length)}${item.value}`;
			return { lines: [text], cursorLine: 0, cursorCol: text.length };
		},
	} as unknown as Parameters<ClioEditor["setAutocompleteProvider"]>[0]);
	const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
	const open = async (text: string) => {
		editor.setText(text);
		editor.handleInput("\t");
		await settle();
		assert.equal(editor.isShowingAutocomplete(), true);
	};

	await open("/model claude-sonnet-5.5");
	editor.handleInput("\r");
	assert.deepEqual(submitted, ["/model claude-sonnet-5.5"]);

	// A row that changes the line still only completes it, so the operator confirms before it runs.
	await open("/model claude-son");
	editor.handleInput("\r");
	assert.equal(editor.getText(), "/model claude-sonnet-5.5");
	assert.deepEqual(submitted, ["/model claude-sonnet-5.5"]);
});

it("every /delegate form that fails to parse names /run first", () => {
	const notices: string[] = [];
	const context = {
		keyboardActions: { menuLabel: () => "" },
		notice: (_level: string, text: string) => notices.push(text),
		render: noop,
	} as unknown as SlashCommandContext;
	for (const line of ["/delegate", "/delegate --bogus"]) {
		notices.length = 0;
		dispatchSlashCommand(parseSlashCommand(line), context);
		assert.equal(notices[0], "/delegate is now /run; ran it.", line);
		assert.match(notices.at(-1) ?? "", /usage: \/run/u, line);
	}
});
