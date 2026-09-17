import assert from "node:assert/strict";
import { it } from "node:test";
import type { DispatchBoardRow } from "../../src/interactive/dispatch-board.js";
import { createDispatchSteering } from "../../src/interactive/dispatch-steering.js";
import { parseEditorSteerMention, type RunningDispatchRef } from "../../src/interactive/editor-steer.js";
import { createEditorSubmitController, type EditorSubmitDeps } from "../../src/interactive/editor-submit.js";
import { createFileReferenceCompletionSource } from "../../src/interactive/file-reference-completion.js";

const noop = () => {};
const worker = { runId: "run-123456", agentId: "worker" };
function fixture(runs: RunningDispatchRef[] = []) {
	let draft = "";
	const history: string[] = [];
	const chat: string[] = [];
	const steers: Array<[string, string]> = [];
	const notices: Array<{ level: string; text: string }> = [];
	const editor = {
		focused: false,
		getText: () => draft,
		getTextForSubmit: () => draft,
		setText: (text: string) => {
			draft = text;
		},
		addToHistory: (text: string) => {
			history.push(text);
		},
	};
	const deps: EditorSubmitDeps = {
		editor,
		ui: { start: noop, stop: noop, requestRender: noop },
		io: { stdout: noop, stderr: noop },
		chat: {
			isStreaming: () => false,
			queueFollowUp: () => false,
			clearQueuedFollowUps: () => [],
			interruptRefusal: () => null,
			submit: async (text) => {
				chat.push(text);
			},
			whenSettled: async () => {},
		},
		dispatch: {
			snapshot: () => ({ running: runs }) as ReturnType<EditorSubmitDeps["dispatch"]["snapshot"]>,
			steer: (id, text) => {
				steers.push([id, text]);
			},
		},
		sessionTranscript: {
			ensureSessionForLocalEntry: noop,
			refreshChatContextFromSession: noop,
			recordSubmittedTurn: noop,
		},
		chatPanel: { appendReplayBlock: noop },
		dispatchCommand: (text) => {
			chat.push(text);
			return "accepted";
		},
		expandSubmit: async (text) => ({ text, images: [] }),
		notify: (level, text) => {
			notices.push({ level, text });
		},
	};
	const controller = createEditorSubmitController(deps);
	return { editor, deps, controller, history, chat, steers, notices };
}

it("Fleet Runs steering remains addressed when the selected worker finishes before Enter", () => {
	const runs = [worker];
	const f = fixture(runs);
	f.editor.setText("keep the numeric precision");
	createDispatchSteering({
		getSelectedRow: () => ({ ...worker, status: "running", runtimeKind: "http" }) as DispatchBoardRow,
		notify: f.deps.notify,
		abortDispatch: noop,
		editor: f.editor,
		closeOverlay: noop,
		requestRender: noop,
	}).steerSelectedDispatch();
	const submitted = f.editor.getText();
	assert.equal(submitted, "@run-123456 keep the numeric precision");
	runs.length = 0;
	f.editor.setText(""); // The terminal editor clears before invoking onSubmit.
	f.controller.submitEditorText(submitted);
	assert.deepEqual(f.chat, []);
	assert.deepEqual(f.steers, []);
	assert.deepEqual(f.history, []);
	assert.equal(f.editor.getText(), submitted);
	assert.match(f.notices[0]?.text ?? "", /no running dispatch.*@run-123456/);
});

for (const target of [worker.runId, "run-123", "worker"]) {
	it(`submits an active exact, prefix, or agent target: ${target}`, () => {
		const f = fixture([worker]);
		f.controller.submitEditorText(`@${target} check again`);
		assert.deepEqual(f.steers, [[worker.runId, "check again"]]);
		assert.deepEqual(f.chat, []);
		assert.equal(f.editor.getText(), "");
		assert.deepEqual(f.history, [`@${target} check again`]);
		assert.match(f.notices[0]?.text ?? "", /queued.*awaiting worker acknowledgement/);
	});
}

for (const runs of [[], [worker]]) {
	it(`rejects unknown targets with ${runs.length} active workers`, () => {
		const f = fixture(runs);
		f.controller.submitEditorText("@unknown recover this instruction");
		assert.deepEqual(f.chat, []);
		assert.deepEqual(f.steers, []);
		assert.equal(f.editor.getText(), "@unknown recover this instruction");
		assert.equal(f.notices[0]?.level, "warning");
	});
}

for (const target of ["worker", "run-"]) {
	it(`preserves ambiguous ${target} targets for correction`, () => {
		const f = fixture([worker, { runId: "run-987654", agentId: "worker" }]);
		f.controller.submitEditorText(`@${target} check again`);
		assert.deepEqual(f.chat, []);
		assert.deepEqual(f.steers, []);
		assert.equal(f.editor.getText(), `@${target} check again`);
		assert.match(f.notices[0]?.text ?? "", /matches 2 runs.*use a runId prefix/);
	});
}

for (const diagnostic of [
	"run is not active",
	"run is aborting and cannot be steered",
	"worker has exited or its stdin is closed",
	"subprocess does not support live steering",
	"acp-delegation does not support live steering",
]) {
	it(`does not report success when admission rejects after the snapshot: ${diagnostic}`, () => {
		const f = fixture([worker]);
		f.deps.dispatch.steer = () => {
			throw new Error(diagnostic);
		};
		f.controller.submitEditorText("@worker keep this");
		assert.deepEqual(f.chat, []);
		assert.deepEqual(f.history, []);
		assert.equal(f.editor.getText(), "@worker keep this");
		assert.equal(f.notices.length, 1);
		assert.equal(f.notices[0]?.level, "error");
		assert.ok(f.notices[0]?.text.includes(diagnostic));
	});
}

it("preserves snapshot diagnostics and the addressed draft", () => {
	const f = fixture();
	f.deps.dispatch.snapshot = () => {
		throw new Error("snapshot unavailable: test evidence");
	};
	f.controller.submitEditorText("@worker keep this");
	assert.deepEqual(f.chat, []);
	assert.equal(f.editor.getText(), "@worker keep this");
	assert.equal(f.notices[0]?.level, "error");
	assert.match(f.notices[0]?.text ?? "", /snapshot unavailable: test evidence/);
});

it("rejects late boot steering for recovery without touching a newer draft", async () => {
	const f = fixture();
	f.editor.setText("newer draft");
	await assert.rejects(f.controller.admitCapturedText("@run-123456 keep this"), /preserving it for recovery/);
	assert.equal(f.editor.getText(), "newer draft");
	assert.deepEqual(f.chat, []);
	assert.deepEqual(f.history, []);
});

it("accepts active boot steering without touching a newer draft", async () => {
	const f = fixture([worker]);
	f.editor.setText("newer draft");
	await f.controller.admitCapturedText("@worker keep this");
	assert.equal(f.editor.getText(), "newer draft");
	assert.deepEqual(f.chat, []);
	assert.deepEqual(f.steers, [[worker.runId, "keep this"]]);
});

it("preserves ordinary chat and unambiguous file references with and without active workers", async () => {
	const source = createFileReferenceCompletionSource({
		basePath: process.cwd(),
		listWorkspaceFiles: async () => ["README"],
		listTrackedFiles: async () => new Set(["README"]),
	});
	const completions = await source({ query: "README", signal: new AbortController().signal });
	assert.equal(completions[0]?.value, '@"README"');
	const textCases: readonly string[] = [
		"ordinary chat",
		"inspect @worker",
		"@worker",
		"@README.md explain",
		"@src/file.ts explain",
		"@./README explain",
		`${completions[0]?.value} explain`,
	];
	for (const runs of [[], [worker]]) {
		for (const text of textCases) {
			assert.equal(parseEditorSteerMention(text), null);
			const f = fixture(runs);
			f.controller.submitEditorText(text);
			assert.deepEqual(f.chat, [text]);
			assert.deepEqual(f.steers, []);
		}
	}
});

for (const runtimeKind of ["http", "sdk"] as const) {
	it(`Fleet Runs supports ${runtimeKind} steering through submission`, () => {
		const f = fixture([worker]);
		f.editor.setText("keep this");
		createDispatchSteering({
			getSelectedRow: () => ({ ...worker, status: "running", runtimeKind }) as DispatchBoardRow,
			notify: f.deps.notify,
			abortDispatch: noop,
			editor: f.editor,
			closeOverlay: noop,
			requestRender: noop,
		}).steerSelectedDispatch();
		f.controller.submitEditorText(f.editor.getText());
		assert.deepEqual(f.steers, [[worker.runId, "keep this"]]);
		assert.deepEqual(f.chat, []);
	});
}

it("retains exact agent matching precedence over run prefixes", () => {
	const f = fixture([worker, { runId: "worker-987", agentId: "other" }]);
	f.controller.submitEditorText("@worker keep this");
	assert.deepEqual(f.steers, [[worker.runId, "keep this"]]);
	assert.deepEqual(f.chat, []);
});
