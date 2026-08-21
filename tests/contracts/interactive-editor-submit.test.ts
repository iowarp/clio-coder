import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { BashCommandResult, RunBashCommandOptions } from "../../src/core/bash-exec.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import type { ReplayBlockFoldControl } from "../../src/interactive/chat-panel.js";
import {
	createEditorSubmitController,
	type EditorSubmitDeps,
	type EditorSubmitEditor,
} from "../../src/interactive/editor-submit.js";
import type { SlashCommandDispatchResult } from "../../src/interactive/slash-commands.js";
import { type TranscriptDetailPolicy, transcriptDetail } from "../../src/interactive/transcript-detail.js";

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
	outputBytes: 7,
});

function createHarness(
	options: {
		streaming?: boolean;
		running?: Array<{ runId: string; agentId: string }>;
		dispatchResult?: SlashCommandDispatchResult;
	} = {},
) {
	let text = "";
	let streaming = options.streaming ?? false;
	let restored: string[] = [];
	let queueAccepted = true;
	const history: string[] = [];
	const stderr: string[] = [];
	const events: string[] = [];
	const queued: string[] = [];
	const submits: Array<{
		text: string;
		steering?: string;
		workingContextPaths?: ReadonlyArray<string>;
		pendingSkillRequests?: ReadonlyArray<unknown>;
	}> = [];
	let interruptRefusal: string | null = null;
	let clearQueuedCalls = 0;
	const steers: Array<{ runId: string; text: string }> = [];
	const notices: Array<{ level: string; text: string; key: string }> = [];
	const replayBlocks: Array<(width: number, detail: TranscriptDetailPolicy) => string[]> = [];
	const replayFolds: Array<ReplayBlockFoldControl | undefined> = [];
	const editor: EditorSubmitEditor = {
		getText: () => text,
		setText: (next) => {
			text = next;
			events.push(`set:${next}`);
		},
		addToHistory: (entry) => {
			const trimmed = entry.trim();
			if (history.at(-1) !== trimmed) history.push(trimmed);
			events.push(`history:${trimmed}`);
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
			whenSettled: async () => {},
			queueFollowUp: (message) => {
				queued.push(message);
				return queueAccepted;
			},
			clearQueuedFollowUps: () => {
				clearQueuedCalls += 1;
				return restored;
			},
			interruptRefusal: () => interruptRefusal,
			submit: async (message, options) => {
				submits.push({
					text: message,
					...(options?.steering ? { steering: options.steering } : {}),
					...(options?.workingContextPaths ? { workingContextPaths: options.workingContextPaths } : {}),
					...(options?.pendingSkillRequests ? { pendingSkillRequests: options.pendingSkillRequests } : {}),
				});
				events.push(`submit:${options?.steering ?? "default"}:${message}`);
			},
		},
		dispatch: {
			snapshot: () => ({ running }) as ReturnType<DispatchContract["snapshot"]>,
			steer: (runId, message) => steers.push({ runId, text: message }),
		},
		sessionTranscript: {
			ensureSessionForLocalEntry: () => events.push("ensure-session"),
			refreshChatContextFromSession: (leafTurnId) => events.push(`refresh:${leafTurnId ?? "null"}`),
			recordSubmittedTurn: () => events.push("record-turn"),
		},
		chatPanel: {
			appendReplayBlock: (renderBlock, _isLive, fold) => {
				events.push("append-bash");
				replayBlocks.push(renderBlock);
				replayFolds.push(fold);
			},
		},
		dispatchCommand: (command) => {
			events.push(`dispatch:${command}`);
			return options.dispatchResult ?? "accepted";
		},
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
		submits,
		steers,
		notices,
		replayBlocks,
		replayFolds,
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
		setInterruptRefusal: (next: string | null) => {
			interruptRefusal = next;
		},
		clearQueuedCalls: () => clearQueuedCalls,
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
			"history:first prompt",
			"set:",
			"dispatch:first prompt",
			"render",
			"history:second prompt",
			"set:",
			"dispatch:second prompt",
			"render",
		]);
	});

	it("clears the editor before dispatching trimmed command text", () => {
		const harness = createHarness();
		const controller = createEditorSubmitController(harness.deps);

		controller.submitEditorText("  /help topic  ");

		deepStrictEqual(harness.events, ["history:/help topic", "set:", "dispatch:/help topic", "render"]);
	});

	it("admits an immutable boot submission without touching the later live draft", async () => {
		const harness = createHarness();
		harness.setText("draft typed after submit");
		harness.deps.dispatchCommandAsync = async (command) => {
			harness.events.push(`admit:${command}`);
		};
		const controller = createEditorSubmitController(harness.deps);

		await controller.admitCapturedText("  early prompt  ");

		strictEqual(harness.getText(), "draft typed after submit");
		deepStrictEqual(harness.history, ["early prompt"]);
		deepStrictEqual(harness.events, ["history:early prompt", "admit:early prompt", "render"]);
	});

	it("does not turn a rejected captured command into history or overwrite the live draft", async () => {
		const harness = createHarness();
		harness.setText("later draft");
		const controller = createEditorSubmitController(harness.deps);

		await rejects(controller.admitCapturedText("/context init --no-generate"), /preserving it for recovery/u);

		strictEqual(harness.getText(), "later draft");
		deepStrictEqual(harness.history, []);
		deepStrictEqual(harness.events, ["dispatch:/context init --no-generate", "render"]);
	});

	it("serializes captured bash commands through the prior process settlement", async () => {
		const harness = createHarness();
		const commands: string[] = [];
		const releases: Array<(result: BashCommandResult) => void> = [];
		harness.deps.runBash = (command) => {
			commands.push(command);
			return new Promise((resolve) => releases.push(resolve));
		};
		const controller = createEditorSubmitController(harness.deps);

		await controller.admitCapturedText("!! printf first");
		const second = controller.admitCapturedText("!! printf second");
		await flushAsync();
		deepStrictEqual(commands, ["printf first"], "the second immutable record cannot collide with the active bash");

		releases[0]?.(bashResult());
		await second;
		deepStrictEqual(commands, ["printf first", "printf second"]);
		releases[1]?.(bashResult());
		await flushAsync();
	});

	it("aborts a captured bash admission while a chat turn is settling", async () => {
		const harness = createHarness({ streaming: true });
		let settle = (): void => {};
		harness.deps.chat.whenSettled = () =>
			new Promise<void>((resolve) => {
				settle = resolve;
			});
		let bashCalls = 0;
		harness.deps.runBash = async () => {
			bashCalls += 1;
			return bashResult();
		};
		const controller = createEditorSubmitController(harness.deps);
		const abort = new AbortController();
		const admission = controller.admitCapturedText("!! printf late", abort.signal);
		await flushAsync();
		abort.abort();

		await rejects(admission, /abort/u);
		strictEqual(bashCalls, 0);
		settle();
	});

	it("rejects an ambiguous captured steer so the lease can recover it without reordering later records", async () => {
		const harness = createHarness({
			running: [
				{ runId: "run-1", agentId: "scout" },
				{ runId: "run-2", agentId: "scout" },
			],
		});
		const controller = createEditorSubmitController(harness.deps);

		await rejects(controller.admitCapturedText("@scout preserve this"), /preserving it for recovery/u);
		deepStrictEqual(harness.history, []);
		deepStrictEqual(harness.steers, []);
	});

	it("restores a token that neither a command nor prompt template claims", () => {
		const harness = createHarness({ dispatchResult: "rejected" });
		const controller = createEditorSubmitController(harness.deps);

		controller.submitEditorText("/compact");

		strictEqual(harness.getText(), "/compact");
		deepStrictEqual(harness.history, [], "a rejected token remains a draft, not submitted history");
		deepStrictEqual(harness.events, ["dispatch:/compact", "set:/compact", "render"]);
	});

	it("clears and records an unknown command token claimed by a prompt template", () => {
		const harness = createHarness({ dispatchResult: "accepted" });
		const controller = createEditorSubmitController(harness.deps);

		controller.submitEditorText("/interopdemo alpha");

		strictEqual(harness.getText(), "");
		deepStrictEqual(harness.history, ["/interopdemo alpha"]);
		deepStrictEqual(harness.events, ["dispatch:/interopdemo alpha", "history:/interopdemo alpha", "set:", "render"]);
	});

	it("returns input a command rejected on its arguments", () => {
		const harness = createHarness();
		const controller = createEditorSubmitController(harness.deps);

		controller.submitEditorText("/context init --no-generate");

		strictEqual(harness.getText(), "/context init --no-generate");
		deepStrictEqual(harness.history, [], "a rejected command is a draft to correct, not submitted history");
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
		deepStrictEqual(harness.history, ["/help", "explain this repository"]);
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

	it("restores unresolved steer mentions without adding them to history", () => {
		const ambiguous = createHarness({
			running: [
				{ runId: "run-123", agentId: "scout" },
				{ runId: "run-456", agentId: "scout" },
			],
		});
		const ambiguousController = createEditorSubmitController(ambiguous.deps);

		ambiguousController.submitEditorText("@scout inspect only");

		strictEqual(ambiguous.getText(), "@scout inspect only", "Pi cleared the draft before onSubmit");
		deepStrictEqual(ambiguous.history, []);
		deepStrictEqual(ambiguous.steers, []);
		strictEqual(ambiguous.notices[0]?.level, "warning");

		const missing = createHarness({ running: [{ runId: "run-123", agentId: "scout" }] });
		const missingController = createEditorSubmitController(missing.deps);

		missingController.submitEditorText("@builder inspect only");

		strictEqual(missing.getText(), "@builder inspect only", "Pi cleared the draft before onSubmit");
		deepStrictEqual(missing.history, []);
		deepStrictEqual(missing.steers, []);
		strictEqual(missing.notices[0]?.level, "warning");
	});

	it("restores a failed steer without adding it to history", () => {
		const harness = createHarness({ running: [{ runId: "run-123", agentId: "scout" }] });
		harness.deps.dispatch.steer = () => {
			throw new Error("queue unavailable");
		};
		const controller = createEditorSubmitController(harness.deps);

		controller.submitEditorText("@scout inspect only");

		strictEqual(harness.getText(), "@scout inspect only", "Pi cleared the draft before onSubmit");
		deepStrictEqual(harness.history, []);
		deepStrictEqual(harness.notices, [
			{
				level: "error",
				text: "steer to @scout failed: queue unavailable",
				key: "steer:scout",
			},
		]);
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

	it("interrupt while idle is a plain send through the normal submit path", () => {
		const harness = createHarness();
		harness.setText("just send it");
		const controller = createEditorSubmitController(harness.deps);

		controller.interruptFromEditor();

		deepStrictEqual(harness.events, [
			"set:",
			"history:just send it",
			"set:",
			"dispatch:just send it",
			"render",
			"render",
		]);
		deepStrictEqual(harness.submits, []);
	});

	it("interrupt while streaming restores the queue to the editor and submits in interrupt mode", async () => {
		const harness = createHarness({ streaming: true });
		harness.setText("  stop and read this  ");
		harness.setRestored(["earlier steer", "earlier follow-up"]);
		harness.deps.expandSubmit = async () => ({ text: "expanded stop", images: [] });
		const controller = createEditorSubmitController(harness.deps);

		controller.interruptFromEditor();
		strictEqual(harness.getText(), "  stop and read this  ", "the draft stays until expansion accepts it");
		await flushAsync();

		deepStrictEqual(harness.submits, [{ text: "expanded stop", steering: "interrupt" }]);
		deepStrictEqual(harness.history, ["stop and read this"]);
		strictEqual(harness.getText(), "earlier steer\n\nearlier follow-up", "queued texts come back like Esc");
		deepStrictEqual(harness.queued, [], "an interrupt never rides the follow-up queue");
		strictEqual(harness.clearQueuedCalls(), 1);
		deepStrictEqual(harness.events, [
			"history:stop and read this",
			"set:earlier steer\n\nearlier follow-up",
			"render",
			"record-turn",
			"submit:interrupt:expanded stop",
		]);
	});

	it("interrupt while streaming carries the expansion's paths and skill requests, like an idle send", async () => {
		const harness = createHarness({ streaming: true });
		harness.setText("use /skill grill-me on @src/foo.ts");
		const skillRequest = { name: "grill-me", source: "slash-command" };
		harness.deps.expandSubmit = async () => ({
			text: "use grill-me on <file>",
			images: [],
			workingContextPaths: ["src/foo.ts"],
			pendingSkillRequests: [skillRequest as never],
		});
		let collapsed = 0;
		harness.deps.collapseLaunchpadBeforeSubmit = () => {
			collapsed += 1;
			harness.events.push("collapse");
		};
		const controller = createEditorSubmitController(harness.deps);

		controller.interruptFromEditor();
		await flushAsync();

		deepStrictEqual(harness.submits, [
			{
				text: "use grill-me on <file>",
				steering: "interrupt",
				workingContextPaths: ["src/foo.ts"],
				pendingSkillRequests: [skillRequest],
			},
		]);
		strictEqual(collapsed, 1, "the launchpad collapses once, as it does for an idle send");
		ok(harness.events.includes("record-turn"), "the submitted-turn counter moves, as it does for an idle send");
	});

	it("interrupt while streaming omits empty paths and skill requests rather than passing empty arrays", async () => {
		const harness = createHarness({ streaming: true });
		harness.setText("plain");
		harness.deps.expandSubmit = async () => ({
			text: "plain",
			images: [],
			workingContextPaths: [],
			pendingSkillRequests: [],
		});
		const controller = createEditorSubmitController(harness.deps);

		controller.interruptFromEditor();
		await flushAsync();

		deepStrictEqual(harness.submits, [{ text: "plain", steering: "interrupt" }]);
	});

	it("a refused interrupt leaves the queue alone and still hands the text to the chat loop", async () => {
		const harness = createHarness({ streaming: true });
		harness.setText("also check X");
		harness.setRestored(["earlier steer"]);
		harness.setInterruptRefusal("an attached dispatch is running");
		const controller = createEditorSubmitController(harness.deps);

		controller.interruptFromEditor();
		await flushAsync();

		deepStrictEqual(harness.submits, [{ text: "also check X", steering: "interrupt" }]);
		strictEqual(harness.getText(), "", "nothing was cancelled, so nothing is restored");
		strictEqual(harness.clearQueuedCalls(), 0);
	});

	it("preserves the draft when a streaming interrupt contains an image", async () => {
		const harness = createHarness({ streaming: true });
		harness.setText("look at @plot.png");
		harness.deps.expandSubmit = async () => ({ text: "look", images: [{}] });
		const controller = createEditorSubmitController(harness.deps);

		controller.interruptFromEditor();
		await flushAsync();

		strictEqual(harness.getText(), "look at @plot.png");
		deepStrictEqual(harness.submits, []);
		deepStrictEqual(harness.stderr, ["[interrupt] image references cannot be sent while a response is streaming\n"]);
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
		deepStrictEqual(harness.events, ["ensure-session", "append-bash", "render", "refresh:null", "render"]);
	});

	it("updates one local bash transcript block from live output through settlement", async () => {
		const harness = createHarness();
		let receivedOptions: RunBashCommandOptions | undefined;
		let resolveBash: (result: BashCommandResult) => void = () => {};
		harness.deps.runBash = (_command, options) => {
			receivedOptions = options;
			return new Promise((resolve) => {
				resolveBash = resolve;
			});
		};
		const controller = createEditorSubmitController(harness.deps);

		strictEqual(controller.runEditorBash("!! npm run typecheck"), true);
		strictEqual(harness.replayBlocks.length, 1);
		const fold = harness.replayFolds[0];
		ok(fold !== undefined, "the local bash block hands the panel a fold control");
		const detail = transcriptDetail("default");
		strictEqual(fold.fold(), undefined, "local bash starts with no operator override");
		strictEqual(fold.policyFold(detail), "folded", "the policy folds a running local bash row");
		strictEqual(fold.policyFold(transcriptDetail("verbose")), "expanded", "verbose opens the running body");

		// Folded: the row carries the command and the live elapsed, not the body.
		let rendered = stripTerminalSequences(harness.replayBlocks[0]?.(100, detail).join("\n") ?? "");
		ok(rendered.includes("running `npm run typecheck`"), rendered);
		ok(rendered.includes("running"), rendered);

		receivedOptions?.onUpdate?.({ stdout: "checking src\n", stderr: "", outputBytes: 13 });
		rendered = stripTerminalSequences(harness.replayBlocks[0]?.(100, detail).join("\n") ?? "");
		ok(!rendered.includes("checking src"), `the folded running row keeps the body closed, got: ${rendered}`);
		strictEqual(harness.replayBlocks.length, 1, "progress replaces the same replay block");

		// Expanded on operator request: the live body appears in place.
		fold.setFold("expanded");
		rendered = stripTerminalSequences(harness.replayBlocks[0]?.(100, detail).join("\n") ?? "");
		ok(rendered.includes("running `npm run typecheck`"), rendered);
		ok(!rendered.includes("bash("), rendered);
		ok(rendered.includes("live output"), rendered);
		ok(rendered.includes("checking src"), rendered);
		ok(rendered.includes("excluded from model context"), rendered);
		fold.setFold(undefined);

		resolveBash({ ...bashResult(), stdout: "checking src\nclean\n" });
		await flushAsync();
		strictEqual(fold.policyFold(detail), "folded", "bash's presentation folds the settled row");
		rendered = stripTerminalSequences(harness.replayBlocks[0]?.(100, detail).join("\n") ?? "");
		ok(rendered.includes("✓"), rendered);
		ok(rendered.includes("ran `npm run typecheck`"), rendered);
		ok(rendered.includes("exit 0"), rendered);
		ok(rendered.includes("excluded from context"), rendered);
		ok(!rendered.includes("clean"), `the settled row stays folded, got: ${rendered}`);
		strictEqual(harness.replayBlocks.length, 1, "settlement keeps the original transcript position");

		fold.setFold("expanded");
		rendered = stripTerminalSequences(harness.replayBlocks[0]?.(100, detail).join("\n") ?? "");
		ok(rendered.includes("output · exit 0"), rendered);
		ok(rendered.includes("clean"), rendered);
		// Without an override the verbose policy opens the same settled body.
		fold.setFold(undefined);
		rendered = stripTerminalSequences(harness.replayBlocks[0]?.(100, transcriptDetail("verbose")).join("\n") ?? "");
		ok(rendered.includes("clean"), `verbose opens the settled local bash body, got: ${rendered}`);
	});

	it("records an accepted local bash submission but restores refusals without history", async () => {
		const accepted = createHarness();
		accepted.deps.runBash = async () => bashResult();
		const acceptedController = createEditorSubmitController(accepted.deps);
		acceptedController.submitEditorText("! pwd");
		await flushAsync();
		deepStrictEqual(accepted.history, ["! pwd"]);
		strictEqual(
			accepted.events.filter((event) => event === "history:! pwd").length,
			1,
			"an accepted command is added to history exactly once",
		);
		strictEqual(accepted.getText(), "");

		const refused = createHarness({ streaming: true });
		const refusedController = createEditorSubmitController(refused.deps);
		refusedController.submitEditorText("! pwd");
		deepStrictEqual(refused.history, []);
		strictEqual(refused.getText(), "! pwd", "Pi cleared the draft before onSubmit");

		let resolveActive: (result: BashCommandResult) => void = () => {};
		const active = createHarness();
		active.deps.runBash = () =>
			new Promise((resolve) => {
				resolveActive = resolve;
			});
		const activeController = createEditorSubmitController(active.deps);
		activeController.submitEditorText("! first");
		activeController.submitEditorText("! second");
		deepStrictEqual(active.history, ["! first"]);
		strictEqual(active.getText(), "! second", "the refused command is restored after Pi clears it");
		resolveActive(bashResult());
		await flushAsync();
	});

	it("restores the leaf the session has when the bash finishes, not the one captured when it started", async () => {
		const harness = createHarness();
		let leafId: string | null = "u1";
		const appended: Array<{ kind: string; parentTurnId: string | null }> = [];
		harness.deps.session = {
			current: () => ({ id: "s1" }),
			tree: () => ({ leafId }),
			appendEntry: (input: { kind: string; parentTurnId?: string | null }) => {
				appended.push({ kind: input.kind, parentTurnId: input.parentTurnId ?? null });
				return { ...input, turnId: "e1", timestamp: "2026-08-17T00:00:00.000Z" };
			},
		} as never;
		let resolveBash: (result: BashCommandResult) => void = () => {};
		harness.deps.runBash = () =>
			new Promise((resolve) => {
				resolveBash = resolve;
			});
		const controller = createEditorSubmitController(harness.deps);

		strictEqual(controller.runEditorBash("! npm test"), true);
		// A prompt lands while the command runs: the session leaf moves on.
		leafId = "a2";
		resolveBash(bashResult());
		await flushAsync();

		deepStrictEqual(appended, [{ kind: "bashExecution", parentTurnId: "u1" }], "the entry keeps its start-time anchor");
		ok(harness.events.includes("refresh:a2"), `chat leaf restored to the current leaf: ${harness.events.join(",")}`);
		ok(!harness.events.includes("refresh:u1"), "and never to the stale one, which wedged every later submit");
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
