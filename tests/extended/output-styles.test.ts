import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS, nextOutputStyle, type OutputStyle } from "../../src/core/defaults.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { CLIO_APP_KEYBINDINGS } from "../../src/domains/config/keybindings.js";
import { ScrollView, stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { preserveTranscriptScroll } from "../../src/interactive/layout.js";
import { renderBashTranscriptExecution, renderToolPreview } from "../../src/interactive/renderers/tool-execution.js";
import { parseSlashCommand } from "../../src/interactive/slash-commands.js";
import { createStatusController } from "../../src/interactive/status/controller.js";
import { reduceStatus } from "../../src/interactive/status/state-machine.js";
import { INITIAL_STATUS } from "../../src/interactive/status/types.js";
import { transcriptDetail } from "../../src/interactive/transcript-detail.js";
import { ViewOverlayView } from "../../src/interactive/view/view-overlay.js";

const plain = (rows: string[]) => rows.map(stripTerminalSequences).join("\n");

test("legacy preferences normalize without changing other settings or the input", () => {
	for (const [legacy, expected] of [
		["minimal", "compact"],
		["default", "standard"],
		["verbose", "detailed"],
	]) {
		const raw = { version: 2, interface: { outputDetail: legacy }, fleet: { concurrency: 7 } };
		const snapshot = structuredClone(raw);
		const result = validateSettings(raw);
		strictEqual(result.settings.interface.outputDetail, expected);
		strictEqual(result.settings.fleet.concurrency, 7);
		deepStrictEqual(raw, snapshot);
	}
	strictEqual(DEFAULT_SETTINGS.interface.outputDetail, "standard");
});

test("Alt+O has one preset action and retired /output gives migration guidance", () => {
	strictEqual(CLIO_APP_KEYBINDINGS["clio-coder.output.cycle"].defaultKeys, "alt+o");
	const ids = Object.keys(CLIO_APP_KEYBINDINGS);
	ok(!ids.some((id) => /(?:tool\.(?:expand|liveOutput)|thinking\.expand)/u.test(id)));
	strictEqual(nextOutputStyle("standard"), "detailed");
	strictEqual(nextOutputStyle(nextOutputStyle(nextOutputStyle("standard"))), "standard");
	const retired = parseSlashCommand("/output verbose");
	strictEqual(retired.kind, "usage-error");
	if (retired.kind === "usage-error") match(retired.reason, /\/help.*Output cycle.*\/settings.*\/view/u);
});

test("a long unbroken reasoning paragraph is bounded after wrapping and freezes its tail", async () => {
	let style: OutputStyle = "standard";
	const panel = createChatPanel({ getOutputStyle: () => style, getTerminalRows: () => 40 });
	const reasoning = `Beginning ${"checking boundary behavior ".repeat(200)} final reasoning tail`;
	panel.applyEvent({ type: "thinking_delta", contentIndex: 0, delta: reasoning, partialThinking: reasoning });
	const streaming = panel.render(32);
	strictEqual(streaming.length, 3);
	match(plain(streaming), /final reasoning tail/u);
	ok(streaming.every((row) => visibleWidth(row) <= 32));
	panel.applyEvent({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "thinking", thinking: reasoning }] },
	} as never);
	deepStrictEqual(panel.render(32), streaming);
	style = "detailed";
	strictEqual(panel.render(32).length, 12);
	style = "compact";
	doesNotMatch(plain(panel.render(32)), /final reasoning tail/u);
	const artifact = panel.inspectionArtifacts()[0];
	ok(artifact);
	strictEqual((await artifact.load()).lines.join("\n"), reasoning);
});

test("large successful cat output stays bounded in every style; errors and local shell output remain visible", () => {
	const output = Array.from({ length: 1000 }, (_, i) => `file contents ${i}`).join("\n");
	const call = {
		toolCallId: "cat",
		toolName: "bash",
		args: { command: "cat large.txt" },
		result: output,
		isError: false,
	};
	for (const style of ["compact", "standard", "detailed"] as const) {
		const policy = transcriptDetail(style);
		const rendered = renderToolPreview(call, 44, policy);
		ok(rendered.length <= 14, `${style}: ${rendered.length}`);
		match(plain(rendered), /cat large.txt.*exit 0/u);
		if (style !== "detailed") doesNotMatch(plain(rendered), /file contents/u);
		else match(plain(rendered), /file contents 999/u);
		const failed = renderToolPreview(
			{ ...call, isError: true, result: "Missing dependency\nInstall the compiler and retry" },
			44,
			policy,
		);
		match(plain(failed), /Missing dependency/u);
		const shell = renderBashTranscriptExecution(
			{ command: "cat large.txt", output, running: false, exitCode: 0, excludeFromContext: true },
			44,
			undefined,
			{ detail: policy },
		);
		match(plain(shell), /file contents 999/u);
		match(plain(shell), /not sent to model/u);
		ok(shell.length <= policy.operatorBashRows + 4);
	}
});

test("style changes preserve a scrolled text anchor and follow-end remains disabled", () => {
	let expanded = false;
	const component = {
		render: () => [...Array(expanded ? 40 : 10).fill("preview"), ...Array.from({ length: 50 }, (_, i) => `answer ${i}`)],
		invalidate() {},
	};
	const view = new ScrollView(component, { follow: "end" });
	view.updateLayout(60, 12, () => {});
	view.scrollTo(14, { disableFollow: true });
	preserveTranscriptScroll(view, 80, () => {
		expanded = true;
	});
	strictEqual(view.scrollTop, 44);
	strictEqual(view.isFollowingEnd, false);
	view.scrollToEnd();
	preserveTranscriptScroll(view, 80, () => {
		expanded = false;
	});
	strictEqual(view.isFollowingEnd, true);
});

test("concurrent tools retain their actual running state after a sibling settles", () => {
	const ctx = { now: 1000, localRuntime: false };
	let state = reduceStatus(INITIAL_STATUS, { type: "agent_start" } as never, ctx);
	for (const id of ["one", "two"])
		state = reduceStatus(
			state,
			{ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: {} } as never,
			ctx,
		);
	state = reduceStatus(
		state,
		{ type: "tool_execution_end", toolCallId: "two", toolName: "bash", isError: false, result: "" } as never,
		ctx,
	);
	strictEqual(state.phase, "tool_running");
	strictEqual(state.tool?.toolCallId, "one");
	state = reduceStatus(
		state,
		{ type: "tool_execution_end", toolCallId: "one", toolName: "bash", isError: false, result: "" } as never,
		ctx,
	);
	strictEqual(state.phase, "preparing");
});

test("background worker lifecycle does not overwrite the main agent phase", () => {
	const bus = createSafeEventBus();
	let emit: (event: never) => void = () => {};
	const controller = createStatusController({
		chat: {
			onEvent: (listener: (event: never) => void) => {
				emit = listener;
				return () => {};
			},
			getSessionId: () => "session",
		} as never,
		providers: { list: () => [] } as never,
		bus,
		now: () => 1000,
		setInterval: () => 0,
		clearInterval() {},
		setTimeout: () => 0,
		clearTimeout() {},
	});
	try {
		emit({ type: "agent_start" } as never);
		emit({ type: "text_delta", delta: "writing" } as never);
		bus.emit(BusChannels.DispatchStarted, { runId: "one" } as never);
		bus.emit(BusChannels.DispatchStarted, { runId: "two" } as never);
		strictEqual(controller.current().phase, "writing");
		bus.emit(BusChannels.DispatchCompleted, { runId: "one" } as never);
		strictEqual(controller.current().phase, "writing");
	} finally {
		controller.dispose();
	}
});

test("bounded diff previews and full inspection redact credentials without altering the result", async () => {
	const diff = Array.from({ length: 80 }, (_, i) => `+${i + 1} line ${i}`).join("\n");
	const result = {
		content: [{ type: "text", text: "changed file" }],
		details: { diff: `+1 API_KEY=fixture-secret\n${diff}` },
	};
	const before = structuredClone(result);
	const call = { toolCallId: "edit", toolName: "edit", args: { path: "config.env" }, result, isError: false };
	for (const style of ["standard", "detailed"] as const) {
		const policy = transcriptDetail(style);
		const lines = renderToolPreview(call, 60, policy, { terminalRows: 60 });
		ok(lines.length <= policy.diffRows + 2);
		doesNotMatch(plain(lines), /fixture-secret/u);
		match(plain(lines), /redacted/u);
	}
	const panel = createChatPanel();
	panel.applyEvent({ type: "tool_execution_start", toolCallId: "edit", toolName: "edit", args: call.args } as never);
	panel.applyEvent({ type: "tool_execution_end", ...call } as never);
	const artifact = panel.inspectionArtifacts()[0];
	ok(artifact);
	const full = (await artifact.load()).lines;
	doesNotMatch(plain(full), /fixture-secret/u);
	match(plain(full), /line 79/u);
	deepStrictEqual(result, before);
});

test("the inspector wraps full text, accepts search letters, and supports Enter then Escape back", async () => {
	let closed = false;
	const view = new ViewOverlayView({
		providers: [
			{
				category: "transcript",
				list: async () => [
					{
						id: "reasoning",
						category: "transcript",
						title: "reasoning overview",
						timestamp: 0,
						load: async () => ({
							format: "text",
							lines: [`${"long reasoning paragraph ".repeat(60)} final words remain readable`],
						}),
					},
				],
			},
		],
		getBodyHeight: () => 10,
		onClose: () => {
			closed = true;
		},
	});
	view.refresh();
	await new Promise((resolve) => setImmediate(resolve));
	for (const key of "reasoning overview") view.handleInput(key);
	const list = plain(view.render(44));
	match(list, /filter: reasoning overview/u);
	doesNotMatch(list, /Accountability|Receipts|\(empty\)/u);
	view.handleInput("\r");
	view.render(44);
	await new Promise((resolve) => setImmediate(resolve));
	view.render(44);
	view.handleInput("G");
	const bottom = view.render(44);
	match(plain(bottom), /final words remain readable/u);
	ok(bottom.every((line) => visibleWidth(line) <= 44));
	view.handleInput("\x1b");
	strictEqual(closed, false);
	match(plain(view.render(44)), /filter: reasoning overview/u);
	view.handleInput("\x1b");
	strictEqual(closed, true);
});

test("fresh worker output clears the silence timer while waiting for dispatch", () => {
	const stalled = {
		...INITIAL_STATUS,
		phase: "stuck" as const,
		resumePhase: "tool_running" as const,
		tool: { toolName: "dispatch", toolPreview: "worker" },
		since: 1,
		lastMeaningfulAt: 1,
		watchdogTier: 4 as const,
	};
	const progress = reduceStatus(stalled, { type: "dispatch_progress" }, { now: 600001, localRuntime: false });
	strictEqual(progress.lastMeaningfulAt, 600001);
	strictEqual(progress.watchdogTier, 0);
	const tick = reduceStatus(progress, { type: "watchdog_tick" }, { now: 600002, localRuntime: false });
	strictEqual(tick.phase, "tool_running");
});
