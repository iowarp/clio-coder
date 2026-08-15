import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { BashCommandResult } from "../../src/core/bash-exec.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import {
	createEditorSubmitController,
	type EditorSubmitDeps,
	type EditorSubmitEditor,
} from "../../src/interactive/editor-submit.js";

const flushAsync = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const bashResult = (): BashCommandResult => ({
	error: null,
	stdout: "result\n",
	stderr: "",
	exitCode: 0,
	signal: null,
	aborted: false,
	timedOut: false,
	outputCapped: false,
});

function createHarness(options: { streaming?: boolean; running?: Array<{ runId: string; agentId: string }> } = {}) {
	let text = "";
	let streaming = options.streaming ?? false;
	let restored: string[] = [];
	let queueAccepted = true;
	const history: string[] = [];
	const stderr: string[] = [];
	const events: string[] = [];
	const queued: string[] = [];
	const steers: Array<{ runId: string; text: string }> = [];
	const notices: Array<{ level: string; text: string; key: string }> = [];
	const editor: EditorSubmitEditor = {
		getText: () => text,
		setText: (next) => {
			text = next;
			events.push(`set:${next}`);
		},
		addToHistory: (entry) => {
			history.push(entry);
			events.push(`history:${entry}`);
		},
	};
	const running = options.running ?? [];
	const deps: EditorSubmitDeps = {
		editor,
		ui: {
			start: () => events.push("start"),
			stop: () => events.push("stop"),
			requestRender: (force) => events.push(force ? "render:force" : "render"),
		},
		io: { stdout: () => {}, stderr: (message) => stderr.push(message) },
		chat: {
			isStreaming: () => streaming,
			queueFollowUp: (message) => {
				queued.push(message);
				return queueAccepted;
			},
			clearQueuedFollowUps: () => restored,
		},
		dispatch: {
			snapshot: () => ({ running }) as ReturnType<DispatchContract["snapshot"]>,
			steer: (runId, message) => steers.push({ runId, text: message }),
		},
		sessionTranscript: {
			ensureSessionForLocalEntry: () => events.push("ensure-session"),
			refreshChatContextFromSession: (leafTurnId) => events.push(`refresh:${leafTurnId ?? "null"}`),
		},
		chatPanel: { appendReplayBlock: () => events.push("append-bash") },
		dispatchCommand: (command) => events.push(`dispatch:${command}`),
		expandSubmit: async (input) => ({ text: input, images: [] }),
		notify: (level, message, key) => notices.push({ level, text: message, key }),
	};
	return {
		deps,
		editor,
		events,
		history,
		stderr,
		queued,
		steers,
		notices,
		setText: (next: string) => {
			text = next;
		},
		getText: () => text,
		setStreaming: (next: boolean) => {
			streaming = next;
		},
		setRestored: (next: string[]) => {
			restored = next;
		},
		setQueueAccepted: (next: boolean) => {
			queueAccepted = next;
		},
	};
}

describe("contracts/interactive editor submit", () => {
	it("collapses exactly once before the first non-empty submit can dispatch output", () => {
		const harness = createHarness();
		let launchpad = true;
		harness.deps.collapseLaunchpadBeforeSubmit = () => {
			if (!launchpad) return;
			launchpad = false;
			harness.events.push("collapse");
		};
		const controller = createEditorSubmitController(harness.deps);

		controller.submitEditorText("   ");
		controller.submitEditorText("first prompt");
		controller.submitEditorText("second prompt");

		deepStrictEqual(harness.events, [
			"collapse",
			"set:",
			"dispatch:first prompt",
			"render",
			"set:",
			"dispatch:second prompt",
			"render",
		]);
	});

	it("clears the editor before dispatching trimmed command text", () => {
		const harness = createHarness();
		const controller = createEditorSubmitController(harness.deps);

		controller.submitEditorText("  /help topic  ");

		deepStrictEqual(harness.events, ["set:", "dispatch:/help topic", "render"]);
	});

	// A token the registry does not claim used to be put back so it could be
	// corrected in place. The restored text carries no cursor of its own, so the
	// next keystrokes landed in front of it, the line stopped parsing as a
	// command, and the whole concatenation went to the model as a chat message
	// the operator never wrote.
	it("clears a token that is not a command so the next keystrokes cannot join it", () => {
		const harness = createHarness();
		const controller = createEditorSubmitController(harness.deps);

		controller.submitEditorText("/thnking off");

		strictEqual(harness.getText(), "");
		deepStrictEqual(harness.events, ["set:", "dispatch:/thnking off", "render"]);
	});

	it("returns input a command rejected on its arguments", () => {
		const harness = createHarness();
		const controller = createEditorSubmitController(harness.deps);

		controller.submitEditorText("/context init --no-generate");

		strictEqual(harness.getText(), "/context init --no-generate");
	});

	// Only the shapes that never reached a handler come back. A command that ran
	// and a message that went to the model both leave the line empty.
	it("clears the editor for commands that run and for chat text", () => {
		const harness = createHarness();
		const controller = createEditorSubmitController(harness.deps);

		controller.submitEditorText("/help");
		strictEqual(harness.getText(), "");

		harness.setText("explain this repository");
		controller.submitEditorText("explain this repository");
		strictEqual(harness.getText(), "");
	});

	it("consumes a matching steer mention before slash or chat dispatch", () => {
		const harness = createHarness({ running: [{ runId: "run-123", agentId: "scout" }] });
		const controller = createEditorSubmitController(harness.deps);

		controller.submitEditorText("@scout inspect only");

		deepStrictEqual(harness.steers, [{ runId: "run-123", text: "inspect only" }]);
		deepStrictEqual(harness.history, ["@scout inspect only"]);
		deepStrictEqual(harness.notices, [
			{
				level: "info",
				text: "steer queued for scout (run-123); awaiting worker acknowledgement",
				key: "steer:run-123",
			},
		]);
		deepStrictEqual(harness.events, ["history:@scout inspect only", "set:", "render"]);
	});

	it("queues an expanded follow-up while streaming and clears only after acceptance", async () => {
		const harness = createHarness({ streaming: true });
		harness.setText("  next step  ");
		harness.deps.expandSubmit = async () => ({ text: "expanded next step", images: [] });
		const controller = createEditorSubmitController(harness.deps);

		controller.queueFollowUpFromEditor();
		strictEqual(harness.getText(), "  next step  ");
		await flushAsync();

		deepStrictEqual(harness.queued, ["expanded next step"]);
		deepStrictEqual(harness.history, ["next step"]);
		strictEqual(harness.getText(), "");
	});

	it("preserves the draft when a streaming follow-up contains an image", async () => {
		const harness = createHarness({ streaming: true });
		harness.setText("look at @plot.png");
		harness.deps.expandSubmit = async () => ({ text: "look", images: [{}] });
		const controller = createEditorSubmitController(harness.deps);

		controller.queueFollowUpFromEditor();
		await flushAsync();

		strictEqual(harness.getText(), "look at @plot.png");
		deepStrictEqual(harness.queued, []);
		deepStrictEqual(harness.stderr, ["[follow-up] image references cannot be queued while a response is streaming\n"]);
	});

	it("restores queued follow-ups ahead of the current draft", () => {
		const harness = createHarness();
		harness.setText("current draft");
		harness.setRestored(["first", "second"]);
		const controller = createEditorSubmitController(harness.deps);

		controller.restoreQueuedFollowUpsToEditor();

		strictEqual(harness.getText(), "first\n\nsecond\n\ncurrent draft");
		deepStrictEqual(harness.events, ["set:first\n\nsecond\n\ncurrent draft", "render"]);
	});

	it("stops and restarts the TUI around a successful external edit", () => {
		const harness = createHarness();
		harness.setText("before");
		harness.deps.resolveEditor = () => "vi";
		harness.deps.editExternally = (initialText, command) => {
			harness.events.push(`edit:${command}:${initialText}`);
			return { ok: true, text: "after" };
		};
		const controller = createEditorSubmitController(harness.deps);

		controller.openExternalEditorForInput();

		strictEqual(harness.getText(), "after");
		deepStrictEqual(harness.events, ["stop", "edit:vi:before", "start", "render:force", "set:after", "render:force"]);
	});

	it("runs local bash with the existing timeout and refresh ordering", async () => {
		const harness = createHarness();
		let resolveBash: (result: BashCommandResult) => void = () => {};
		let receivedSignal: AbortSignal | undefined;
		harness.deps.getCwd = () => "/work/project";
		harness.deps.nowIso = () => "2026-08-09T00:00:00.000Z";
		harness.deps.runBash = (_command, options) => {
			receivedSignal = options?.signal;
			return new Promise((resolve) => {
				resolveBash = resolve;
			});
		};
		const controller = createEditorSubmitController(harness.deps);

		strictEqual(controller.runEditorBash("!! pwd"), true);
		strictEqual(controller.hasActiveEditorBash(), true);
		strictEqual(receivedSignal?.aborted, false);
		resolveBash(bashResult());
		await flushAsync();

		strictEqual(controller.hasActiveEditorBash(), false);
		deepStrictEqual(harness.events, ["ensure-session", "append-bash", "refresh:null", "render"]);
	});

	it("rejects local bash behind a streaming response with the existing notice", () => {
		const harness = createHarness({ streaming: true });
		const controller = createEditorSubmitController(harness.deps);

		strictEqual(controller.runEditorBash("! pwd"), true);
		strictEqual(controller.hasActiveEditorBash(), false);
		deepStrictEqual(harness.stderr, [
			"[bash] response in progress. Press Esc to cancel the active run before running a local command.\n",
		]);
	});
});
