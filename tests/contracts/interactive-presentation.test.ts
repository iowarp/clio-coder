import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import type { SafeEventBus } from "../../src/core/event-bus.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { ObservabilityContract, ObservabilitySnapshot } from "../../src/domains/observability/index.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { Component, TUI } from "../../src/engine/tui.js";
import type { ChatLoop, ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import type { ChatPanel } from "../../src/interactive/chat-panel.js";
import type { CoalescingChatRenderer } from "../../src/interactive/chat-renderer.js";
import type { ClioEditor, EditorChrome } from "../../src/interactive/clio-editor.js";
import type { DispatchBoardView } from "../../src/interactive/dispatch-board.js";
import type { FollowUpQueuePanel } from "../../src/interactive/follow-up-queue-panel.js";
import type { FooterDashboardDeps, FooterDashboardPanel } from "../../src/interactive/footer/dashboard.js";
import { createNotificationCenter } from "../../src/interactive/footer/notifications.js";
import {
	createInteractivePresentation,
	type InteractivePresentationDeps,
	type InteractivePresentationFactories,
	type PresentationTickerHandle,
} from "../../src/interactive/interactive-presentation.js";
import type { ClioKeybindingManager } from "../../src/interactive/keybinding-manager.js";
import type { RunIo } from "../../src/interactive/slash-commands.js";
import { createStatusController, type StatusController, type TurnSummary } from "../../src/interactive/status/index.js";
import type { WorkspaceFacts } from "../../src/interactive/workspace-facts.js";

interface TestTicker extends PresentationTickerHandle {
	id: number;
}

interface ScheduledTicker {
	handle: TestTicker;
	intervalMs: number;
	callback: () => void;
}

function component(): Component {
	return { render: () => [], invalidate: () => {} };
}

function settings(): ClioSettings {
	return {
		keybindings: {},
		terminal: {
			showTerminalProgress: false,
			outputVerbosity: "default",
			tuiMode: "fullscreen",
			fullscreenScrollbar: "always",
		},
		orchestrator: { target: "local", model: "org/model", thinkingLevel: "off" },
	} as ClioSettings;
}

function snapshot(id: string): ObservabilitySnapshot {
	return {
		id,
		session: { latestThroughput: null, tokens: {}, cost: {} },
	} as unknown as ObservabilitySnapshot;
}

function harness() {
	const log: string[] = [];
	const scheduled: ScheduledTicker[] = [];
	const firstSnapshot = snapshot("first");
	let observabilityListener: ((next: ObservabilitySnapshot) => void) | null = null;
	let footerDeps: FooterDashboardDeps | null = null;
	let streaming = false;
	let statusPhase: ReturnType<StatusController["current"]>["phase"] = "idle";
	let expanded = false;
	let renders = 0;
	let footerRefreshes = 0;
	let chatInvalidations = 0;
	let workspaceRefreshes = 0;
	let editorChrome: EditorChrome | null = null;
	let layoutOptions: Parameters<InteractivePresentationFactories["buildLayout"]>[1] | undefined;
	let dispatchRuns: Array<{ runId: string; agentId: string }> = [];
	let now = 1_000;

	const keybindings = {
		getKeys: (id: string) => {
			if (id === "tui.input.submit") return ["enter"];
			if (id === "tui.input.newLine") return ["shift+enter", "ctrl+j"];
			if (id === "clio.tool.expand") return ["ctrl+o"];
			if (id === "clio.message.dequeue") return ["alt+up"];
			if (id === "clio.notifications.dismiss") return ["alt+x"];
			return [];
		},
	} as unknown as ClioKeybindingManager;
	let bannerMode: "launchpad" | "session" = "launchpad";
	const banner = {
		...component(),
		collapseToSessionHeader: () => {
			if (bannerMode === "session") return false;
			bannerMode = "session";
			log.push("banner.collapse");
			return true;
		},
		resetToLaunchpad: () => {
			if (bannerMode === "launchpad") return false;
			bannerMode = "launchpad";
			log.push("banner.reset");
			return true;
		},
	};
	const chatPanel = {
		...component(),
		appendReplayBlock: () => {},
		invalidate: () => {
			chatInvalidations += 1;
		},
	} as unknown as ChatPanel;
	const followUpQueuePanel = component() as FollowUpQueuePanel;
	const statusController = {
		current: () => ({ phase: statusPhase }),
		subscribe: () => () => {},
		reset: () => log.push("status.reset"),
		dispose: () => log.push("status.dispose"),
	} as unknown as StatusController;
	const dispatchBoardStore = {
		rows: () => [],
		activeRows: () => [],
		reconcile: () => {},
		unsubscribe: () => log.push("dispatch.unsubscribe"),
	};
	const contextActivityStore = {
		active: () => false,
		current: () => null,
		unsubscribe: () => log.push("context.unsubscribe"),
	};
	const footer = {
		view: component(),
		refresh: () => {
			footerRefreshes += 1;
		},
		isExpanded: () => expanded,
		dispose: () => log.push("footer.dispose"),
	} as unknown as FooterDashboardPanel;
	const editor = {
		...component(),
		focused: false,
		setAutocompleteProvider: () => log.push("editor.autocomplete"),
	} as unknown as ClioEditor;
	const dispatchBoard = component() as DispatchBoardView;
	const chatRenderer = {
		applyEvent: () => {},
		flush: () => {},
		mutate: (mutation: () => void) => mutation(),
		reset: (mutation: () => void) => mutation(),
		flushAndCommit: async () => {},
		setSmoothStreamingMode: () => {},
		dispose: () => {},
	} as CoalescingChatRenderer;
	const io = {} as RunIo;
	const root = component();

	const factories: Partial<InteractivePresentationFactories> = {
		createKeybindings: () => {
			log.push("keybindings");
			return keybindings;
		},
		createBanner: () => {
			log.push("banner");
			return banner;
		},
		createChatPanel: () => {
			log.push("chat");
			return chatPanel;
		},
		createFollowUpQueuePanel: () => {
			log.push("follow-up");
			return followUpQueuePanel;
		},
		createStatusController: () => {
			log.push("status");
			return statusController;
		},
		createDispatchBoardStore: () => {
			log.push("dispatch-store");
			return dispatchBoardStore;
		},
		createContextActivityStore: () => {
			log.push("context-store");
			return contextActivityStore;
		},
		createNotificationCenter: (options) => {
			log.push("notifications");
			return createNotificationCenter(options);
		},
		buildFooter: (input) => {
			log.push("footer");
			footerDeps = input;
			return footer;
		},
		createEditor: (_tui, chrome) => {
			log.push("editor");
			editorChrome = chrome;
			return editor;
		},
		createAutocomplete: () => {
			log.push("autocomplete");
			return {} as ReturnType<InteractivePresentationFactories["createAutocomplete"]>;
		},
		createDispatchBoardView: () => {
			log.push("dispatch-view");
			return dispatchBoard;
		},
		createChatRenderer: () => {
			log.push("renderer");
			return chatRenderer;
		},
		createIo: () => {
			log.push("io");
			return io;
		},
		buildLayout: (_parts, options) => {
			log.push("layout");
			layoutOptions = options;
			return root as ReturnType<InteractivePresentationFactories["buildLayout"]>;
		},
	};

	const workspaceFacts: WorkspaceFacts = {
		getWorkspaceSnapshot: () => ({}) as ReturnType<WorkspaceFacts["getWorkspaceSnapshot"]>,
		getLiveWorkspaceSnapshot: () => ({}) as ReturnType<WorkspaceFacts["getLiveWorkspaceSnapshot"]>,
		refreshLiveWorkspaceGit: () => {
			workspaceRefreshes += 1;
			return Promise.resolve();
		},
		ready: () => Promise.resolve(),
		getExtensionStats: () => ({ active: 0, installed: 0 }),
	};
	const observability = {
		snapshot: () => firstSnapshot,
		subscribe: (listener: (next: ObservabilitySnapshot) => void) => {
			log.push("observability.subscribe");
			observabilityListener = listener;
			listener(firstSnapshot);
			return () => log.push("observability.unsubscribe");
		},
	} as unknown as ObservabilityContract;
	const deps: InteractivePresentationDeps = {
		bus: {} as SafeEventBus,
		providers: {} as ProvidersContract,
		dispatch: { snapshot: () => ({ running: dispatchRuns }) } as unknown as Pick<DispatchContract, "snapshot">,
		observability,
		chat: {
			contextUsage: () => ({}),
			contextLedger: () => ({}),
			isStreaming: () => streaming,
		} as unknown as ChatLoop,
		workspaceFacts,
		sessionTranscript: { liveSessionTurns: () => 0 },
		tui: { requestRender: () => renders++ } as unknown as TUI,
		terminal: { columns: 120 },
		mount: (mountedRoot, mountedEditor) => {
			strictEqual(mountedRoot, root);
			strictEqual(mountedEditor, editor);
			log.push("mount");
		},
		getSettings: settings,
		now: () => now,
		scheduleInterval: (callback, intervalMs) => {
			const handle: TestTicker = {
				id: scheduled.length + 1,
				unref: () => log.push(`unref:${intervalMs}`),
			};
			scheduled.push({ handle, intervalMs, callback });
			log.push(`schedule:${intervalMs}`);
			return handle;
		},
		clearScheduledInterval: (handle) => log.push(`clear:${(handle as TestTicker).id}`),
		factories,
	};

	return {
		deps,
		log,
		scheduled,
		firstSnapshot,
		footer,
		getFooterDeps: () => footerDeps,
		getEditorChrome: () => editorChrome,
		getLayoutOptions: () => layoutOptions,
		emitObservability: (next: ObservabilitySnapshot) => observabilityListener?.(next),
		setStreaming: (next: boolean) => {
			streaming = next;
		},
		setStatusPhase: (next: typeof statusPhase) => {
			statusPhase = next;
		},
		setDispatchRuns: (next: typeof dispatchRuns) => {
			dispatchRuns = next;
		},
		setExpanded: (next: boolean) => {
			expanded = next;
		},
		setNow: (next: number) => {
			now = next;
		},
		counts: () => ({ renders, footerRefreshes, chatInvalidations, workspaceRefreshes }),
	};
}

describe("interactive presentation ownership", () => {
	it("constructs and mounts the visual graph before starting the three refresh tickers", () => {
		const test = harness();
		const presentation = createInteractivePresentation(test.deps);

		deepStrictEqual(test.log, [
			"keybindings",
			"banner",
			"chat",
			"follow-up",
			"status",
			"dispatch-store",
			"context-store",
			"notifications",
			"footer",
			"observability.subscribe",
			"editor",
			"autocomplete",
			"editor.autocomplete",
			"dispatch-view",
			"renderer",
			"io",
			"layout",
			"mount",
			"schedule:120",
			"unref:120",
			"schedule:1000",
			"unref:1000",
			"schedule:5000",
			"unref:5000",
		]);
		deepStrictEqual(
			test.scheduled.map((ticker) => ticker.intervalMs),
			[120, 1_000, 5_000],
		);
		strictEqual(presentation.notifications.list().length, 0);
		deepStrictEqual(test.getLayoutOptions(), { mode: "fullscreen", fullscreenScrollbar: "always" });
	});

	it("keeps the optional settings path on regular-screen defaults", () => {
		const test = harness();
		delete test.deps.getSettings;
		const presentation = createInteractivePresentation(test.deps);
		deepStrictEqual(test.getLayoutOptions(), { mode: "regular", fullscreenScrollbar: "auto" });
		presentation.dispose();
	});

	it("wires live streaming state and resolved editor bindings into composer chrome", () => {
		const test = harness();
		createInteractivePresentation(test.deps);
		const chrome = test.getEditorChrome();
		if (!chrome) throw new Error("editor chrome dependencies were not captured");

		strictEqual(chrome.isStreaming?.(), false);
		strictEqual(chrome.getSubmitKeyLabel?.(), "Enter");
		strictEqual(chrome.getNewlineKeyLabel?.(), "Shift+Enter");
		test.setStreaming(true);
		strictEqual(chrome.isStreaming?.(), true, "composer reads streaming state live rather than at construction");
		strictEqual(chrome.willEnterSteer?.("correct course"), true);
		strictEqual(chrome.willEnterSteer?.("/help"), false, "a local slash command does not claim orange steer intent");
		strictEqual(chrome.willEnterSteer?.("!pwd"), false, "a blocked streaming bash command is not a steer");
		strictEqual(chrome.willEnterSteer?.("@worker correct course"), true, "without fleet work, @text steers Clio");
		test.setDispatchRuns([{ runId: "run-123", agentId: "worker" }]);
		strictEqual(chrome.willEnterSteer?.("@worker correct course"), true, "a unique fleet target is steerable");
		strictEqual(chrome.willEnterSteer?.("@missing correct course"), false, "a missing fleet target only warns");
		test.setDispatchRuns([
			{ runId: "run-123", agentId: "worker" },
			{ runId: "run-456", agentId: "worker" },
		]);
		strictEqual(chrome.willEnterSteer?.("@worker correct course"), false, "an ambiguous fleet target only warns");
	});

	it("keeps footer telemetry and the observability projection behind narrow callbacks", () => {
		const test = harness();
		const presentation = createInteractivePresentation(test.deps);
		const input = test.getFooterDeps();
		if (!input) throw new Error("footer dependencies were not captured");

		presentation.recordToolStart("call-1", "bash");
		presentation.recordToolStart("call-2", "bash");
		presentation.recordToolEnd({ toolCallId: "call-1", isError: true, truncated: true });
		deepStrictEqual(input.getToolCounts?.(), {
			tools: { bash: 2 },
			errors: 1,
			active: 1,
			truncatedResults: 1,
		});

		const summary = { stopReason: "stop" } as TurnSummary;
		presentation.setLastTurnSummary(summary);
		strictEqual(input.getLastTurnSummary?.(), summary);
		const rendersBeforeCollapse = test.counts().renders;
		presentation.collapseWelcomeDashboard();
		presentation.collapseWelcomeDashboard();
		ok(test.log.includes("banner.collapse"));
		strictEqual(test.counts().renders, rendersBeforeCollapse + 1, "the height transition requests exactly one repaint");

		// A new session starts with no history, so the footer must not still be
		// reporting the turn the previous session ended on.
		presentation.resetForNewSession();
		ok(test.log.includes("banner.reset"));
		deepStrictEqual(input.getToolCounts?.(), { tools: {}, errors: 0, active: 0, truncatedResults: 0 });
		strictEqual(input.getLastTurnSummary?.(), null);

		const next = snapshot("next");
		test.emitObservability(next);
		strictEqual(presentation.getObservabilitySnapshot(), next);
	});

	it("uses the active turn's advancing throughput instead of the previous settled turn", () => {
		const test = harness();
		const previous = {
			tokensPerSecond: 102,
			outputTokens: 9_000,
			durationMs: 86_000,
			ttftMs: 621,
			providerId: "local",
			modelId: "org/model",
			recordedAt: 900,
		};
		test.firstSnapshot.session.latestThroughput = previous;
		const presentation = createInteractivePresentation(test.deps);
		const input = test.getFooterDeps();
		if (!input) throw new Error("footer dependencies were not captured");

		presentation.recordChatEvent({ type: "agent_start" } as ChatLoopEvent);
		strictEqual(input.getTokenThroughput?.(), null, "the prior turn stays hidden before this turn's first token");

		test.setNow(1_200);
		presentation.recordChatEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "thinking_delta",
				partial: { content: [{ type: "thinking", thinking: "a".repeat(400) }] },
			},
		} as unknown as ChatLoopEvent);
		test.setNow(2_200);
		const first = input.getTokenThroughput?.();
		strictEqual(first?.outputTokens, 100);
		strictEqual(first?.ttftMs, 200);
		strictEqual(first?.tokensPerSecond, 100);

		test.setNow(3_200);
		presentation.recordChatEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "thinking_delta",
				partial: { content: [{ type: "thinking", thinking: "b".repeat(800) }] },
			},
		} as unknown as ChatLoopEvent);
		test.setNow(4_200);
		const second = input.getTokenThroughput?.();
		strictEqual(second?.outputTokens, 200, "the live output follows the advancing partial response");
		ok(
			second?.tokensPerSecond !== first?.tokensPerSecond,
			"the live rate is recomputed instead of staying byte-identical",
		);
		strictEqual(second?.ttftMs, 200, "TTFT belongs to this turn, not the prior settled snapshot");

		const settled = { ...second, outputTokens: 210 } as NonNullable<typeof second>;
		const next = snapshot("settled");
		next.session.latestThroughput = settled;
		test.emitObservability(next);
		presentation.recordChatEvent({ type: "agent_end", messages: [] } as unknown as ChatLoopEvent);
		strictEqual(input.getTokenThroughput?.(), settled, "settlement hands ownership back to completed observability");
	});

	it("clears the terminal status a finished turn left on the footer", () => {
		// The status controller only settles an ended turn back to idle five
		// seconds later. Without a reset a session started inside that window
		// opens showing the previous session's stop verb and elapsed time,
		// because the footer reads the live status independently of the turn
		// summary that /new already clears.
		const test = harness();
		let chatListener: ((event: ChatLoopEvent) => void) | null = null;
		test.deps.chat = {
			contextUsage: () => ({}),
			contextLedger: () => ({}),
			isStreaming: () => false,
			getSessionId: () => "session-one",
			onEvent: (listener: (event: ChatLoopEvent) => void) => {
				chatListener = listener;
				return () => {};
			},
		} as unknown as ChatLoop;
		test.deps.providers = { list: () => [] } as unknown as ProvidersContract;
		test.deps.bus = { on: () => () => {}, emit: () => {} } as unknown as SafeEventBus;
		test.deps.factories = { ...test.deps.factories, createStatusController };
		const presentation = createInteractivePresentation(test.deps);
		const input = test.getFooterDeps();
		if (!input) throw new Error("footer dependencies were not captured");
		if (!chatListener) throw new Error("the status controller did not subscribe to the chat loop");

		const emit = chatListener as (event: ChatLoopEvent) => void;
		try {
			emit({ type: "agent_start" } as ChatLoopEvent);
			emit({ type: "agent_end", messages: [] } as unknown as ChatLoopEvent);
			strictEqual(input.getAgentStatus?.().phase, "ended");

			presentation.resetForNewSession();
			strictEqual(input.getAgentStatus?.().phase, "idle");
			strictEqual(input.getAgentStatus?.().summary, undefined);
		} finally {
			// The real controller owns a live tick interval and a settle timer.
			presentation.dispose();
		}
	});

	it("preserves each ticker guard and disposes owned phases in exact order once", () => {
		const test = harness();
		const presentation = createInteractivePresentation(test.deps);
		const [footerTicker, toolTicker, workspaceTicker] = test.scheduled;
		if (!footerTicker || !toolTicker || !workspaceTicker) throw new Error("presentation did not schedule all tickers");
		const baseline = test.counts();

		footerTicker.callback();
		toolTicker.callback();
		deepStrictEqual(test.counts(), baseline);

		test.setStreaming(true);
		footerTicker.callback();
		toolTicker.callback();
		workspaceTicker.callback();
		deepStrictEqual(test.counts(), {
			renders: baseline.renders + 3,
			footerRefreshes: baseline.footerRefreshes + 2,
			chatInvalidations: baseline.chatInvalidations + 1,
			workspaceRefreshes: baseline.workspaceRefreshes + 1,
		});

		test.setStreaming(false);
		test.setStatusPhase("thinking");
		footerTicker.callback();
		test.setStatusPhase("idle");
		test.setExpanded(true);
		footerTicker.callback();

		test.log.length = 0;
		presentation.stopTickers();
		test.log.push("root.interleave");
		presentation.disposeBeforeStatus();
		test.log.push("events.dispose");
		presentation.disposeStatus();
		presentation.dispose();
		deepStrictEqual(test.log, [
			"clear:1",
			"clear:2",
			"clear:3",
			"root.interleave",
			"footer.dispose",
			"observability.unsubscribe",
			"context.unsubscribe",
			"dispatch.unsubscribe",
			"events.dispose",
			"status.dispose",
		]);
	});
});
