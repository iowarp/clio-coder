import type { ClioSettings } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { ContextState } from "../domains/context/index.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { TaskMemoryOperatorStatus } from "../domains/memory/index.js";
import type { ObservabilityContract, ObservabilitySnapshot } from "../domains/observability/index.js";
import { type ProvidersContract, resolveModelRuntimeCapabilitiesForProviders } from "../domains/providers/index.js";
import type { ResourcesContract } from "../domains/resources/index.js";
import { getMarketplaceSkills } from "../domains/resources/skills/marketplace.js";
import type { SessionContract, TaskBoardSnapshot } from "../domains/session/index.js";
import type { Component, TUI } from "../engine/tui.js";
import type { ChatLoop, ChatLoopEvent } from "./chat-loop.js";
import { type ChatPanel, createChatPanel } from "./chat-panel.js";
import { type CoalescingChatRenderer, createCoalescingChatRenderer } from "./chat-renderer.js";
import { ClioEditor } from "./clio-editor.js";
import { createCommandOutputRunIo } from "./command-output.js";
import { createContextActivityStore } from "./context-activity.js";
import { createDispatchBoardStore, createDispatchBoardView, type DispatchBoardView } from "./dispatch-board.js";
import { parseEditorBashCommand } from "./editor-bash.js";
import { parseEditorSteerMention, resolveSteerTarget } from "./editor-steer.js";
import { createFollowUpQueuePanel, type FollowUpQueuePanel } from "./follow-up-queue-panel.js";
import { buildFooterDashboard, type FooterDashboardDeps, type FooterDashboardPanel } from "./footer/dashboard.js";
import { createNotificationCenter, type NotificationCenter } from "./footer/notifications.js";
import { getActiveRenderTrace } from "./interactive-shell.js";
import type { InteractiveNoticeLevel } from "./interactive-subscriptions.js";
import { type ClioKeybindingManager, createKeybindingManager } from "./keybinding-manager.js";
import { buildLayout } from "./layout.js";
import type { SessionTranscript } from "./session-transcript.js";
import { createSlashCommandAutocompleteProvider } from "./slash-autocomplete.js";
import { parseSlashCommand, type RunIo } from "./slash-commands.js";
import { createStatusController, type StatusController, type TurnSummary } from "./status/index.js";
import { formatTargetLabel } from "./theme/index.js";
import { createWelcomeDashboard, type WelcomeDashboardComponent } from "./welcome-dashboard.js";
import type { WorkspaceFacts } from "./workspace-facts.js";

export interface PresentationTickerHandle {
	unref?(): void;
}

type DispatchBoardStore = ReturnType<typeof createDispatchBoardStore>;
type ContextActivityStore = ReturnType<typeof createContextActivityStore>;
type AutocompleteProvider = ReturnType<typeof createSlashCommandAutocompleteProvider>;

export interface InteractivePresentationFactories {
	createKeybindings: typeof createKeybindingManager;
	createBanner: (deps: Parameters<typeof createWelcomeDashboard>[0]) => WelcomeDashboardComponent;
	createChatPanel: typeof createChatPanel;
	createFollowUpQueuePanel: typeof createFollowUpQueuePanel;
	createStatusController: typeof createStatusController;
	createDispatchBoardStore: typeof createDispatchBoardStore;
	createContextActivityStore: typeof createContextActivityStore;
	createNotificationCenter: typeof createNotificationCenter;
	buildFooter: typeof buildFooterDashboard;
	createEditor: (tui: TUI, chrome: ConstructorParameters<typeof ClioEditor>[1]) => ClioEditor;
	createAutocomplete: typeof createSlashCommandAutocompleteProvider;
	createDispatchBoardView: typeof createDispatchBoardView;
	createChatRenderer: typeof createCoalescingChatRenderer;
	createIo: typeof createCommandOutputRunIo;
	buildLayout: typeof buildLayout;
}

export interface InteractivePresentationDeps {
	bus: SafeEventBus;
	providers: ProvidersContract;
	dispatch: Pick<DispatchContract, "snapshot">;
	observability: ObservabilityContract;
	chat: ChatLoop;
	workspaceFacts: WorkspaceFacts;
	sessionTranscript: Pick<SessionTranscript, "liveSessionTurns">;
	tui: TUI;
	terminal: { readonly columns: number };
	mount: (root: Component, editor: Component) => void;
	getSettings?: () => Readonly<ClioSettings>;
	resources?: Pick<ResourcesContract, "skills">;
	session?: Pick<SessionContract, "current">;
	getSessionId?: () => string | null;
	getTaskBoard?: () => TaskBoardSnapshot | null;
	getTaskMemoryStatus?: () => TaskMemoryOperatorStatus;
	getTaskMemorySeedOffer?: () => { source: string; count: number } | null;
	getContextState?: (cwd?: string) => ContextState;
	/** Whether the Ctrl+G leader is armed and waiting for its next key. */
	getLeaderArmed?: () => boolean;
	/** Whether a Ctrl+C armed the double tap and its window is still open. */
	getShutdownArmed?: () => boolean;
	getCwd?: () => string;
	resolveVisibleEventSequence?: (event: ChatLoopEvent) => number | null;
	scheduleInterval?: (callback: () => void, intervalMs: number) => PresentationTickerHandle;
	clearScheduledInterval?: (handle: PresentationTickerHandle) => void;
	factories?: Partial<InteractivePresentationFactories>;
}

export interface PresentationToolEnd {
	toolCallId: string;
	isError: boolean;
	truncated: boolean;
}

export interface InteractivePresentation {
	keybindings: ClioKeybindingManager;
	banner: WelcomeDashboardComponent;
	chatPanel: ChatPanel;
	followUpQueuePanel: FollowUpQueuePanel;
	statusController: StatusController;
	dispatchBoardStore: DispatchBoardStore;
	contextActivityStore: ContextActivityStore;
	footer: FooterDashboardPanel;
	notifications: NotificationCenter;
	notify(level: InteractiveNoticeLevel, text: string, key?: string): void;
	dismissContextBootstrapNotices(): void;
	announceTaskMemorySeedOffer(): void;
	collapseWelcomeDashboard(): void;
	editor: ClioEditor;
	dispatchBoard: DispatchBoardView;
	chatRenderer: CoalescingChatRenderer;
	io: RunIo;
	root: Component;
	getObservabilitySnapshot(): ObservabilitySnapshot;
	recordToolStart(toolCallId: string, toolName: string): void;
	recordToolEnd(result: PresentationToolEnd): void;
	setLastTurnSummary(summary: TurnSummary | null): void;
	/** Drop every piece of presentation state that belonged to the old session. */
	resetForNewSession(): void;
	stopTickers(): void;
	disposeBeforeStatus(): void;
	disposeStatus(): void;
	dispose(): void;
}

const DEFAULT_FACTORIES: InteractivePresentationFactories = {
	createKeybindings: createKeybindingManager,
	createBanner: createWelcomeDashboard,
	createChatPanel,
	createFollowUpQueuePanel,
	createStatusController,
	createDispatchBoardStore,
	createContextActivityStore,
	createNotificationCenter,
	buildFooter: buildFooterDashboard,
	createEditor: (tui, chrome) => new ClioEditor(tui, chrome),
	createAutocomplete: createSlashCommandAutocompleteProvider,
	createDispatchBoardView,
	createChatRenderer: createCoalescingChatRenderer,
	createIo: createCommandOutputRunIo,
	buildLayout,
};

/** Title-case a KeyId for compact chrome hints, preserving each caller's fallback. */
function formatKeyLabel(keyId: string | undefined, fallback = "Alt+X"): string {
	if (!keyId || keyId.length === 0) return fallback;
	return keyId
		.split("+")
		.map((segment) => (segment.length === 0 ? segment : segment.charAt(0).toUpperCase() + segment.slice(1)))
		.join("+");
}

function willEnterSteerActiveWork(deps: InteractivePresentationDeps, text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0 || parseEditorBashCommand(text)) return false;
	const mention = parseEditorSteerMention(trimmed);
	if (mention) {
		let running: Array<{ runId: string; agentId: string }> = [];
		try {
			running = deps.dispatch.snapshot().running.map((run) => ({ runId: run.runId, agentId: run.agentId }));
		} catch {
			running = [];
		}
		if (running.length > 0) return resolveSteerTarget(mention.target, running).kind === "match";
	}
	return parseSlashCommand(trimmed).kind === "unknown";
}

/**
 * Construct the terminal-independent presentation graph around an injected
 * TUI. The composition root retains process/session ownership; this unit owns
 * visual components, their mutable footer projection, and their refresh
 * timers as one lifecycle.
 */
export function createInteractivePresentation(deps: InteractivePresentationDeps): InteractivePresentation {
	const factories = { ...DEFAULT_FACTORIES, ...deps.factories };
	const getCwd = deps.getCwd ?? (() => process.cwd());
	const requestRender = (): void => deps.tui.requestRender();
	const settings = deps.getSettings?.() ?? ({ keybindings: {} } as ClioSettings);
	const keybindings = factories.createKeybindings(settings);
	const { getExtensionStats, getLiveWorkspaceSnapshot, getWorkspaceSnapshot, refreshLiveWorkspaceGit } =
		deps.workspaceFacts;

	const banner = factories.createBanner({
		providers: deps.providers,
		observability: deps.observability,
		getContextUsage: () => deps.chat.contextUsage(),
		getWorkspaceSnapshot,
		getExtensionStats,
		// The repository probe runs off the render path now, so the frame that
		// shows its result has to be asked for when the probe lands.
		onFactsRefreshed: requestRender,
		...(deps.getTaskMemoryStatus ? { getTaskMemoryStatus: deps.getTaskMemoryStatus } : {}),
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
	});
	const renderTrace = getActiveRenderTrace();
	const chatPanel = factories.createChatPanel({
		getToolExpandKey: () => {
			const first = keybindings.getKeys("clio.tool.expand")[0];
			return typeof first === "string" && first.length > 0 ? first : undefined;
		},
		getOutputVerbosity: () => deps.getSettings?.().terminal.outputVerbosity ?? "default",
		...(renderTrace ? { onRenderMetrics: (metrics) => renderTrace.recordPanelRender(metrics) } : {}),
	});
	const followUpQueuePanel = factories.createFollowUpQueuePanel({
		getDequeueKey: () => {
			const first = keybindings.getKeys("clio.message.dequeue")[0];
			return typeof first === "string" && first.length > 0 ? first : undefined;
		},
	});
	const statusController = factories.createStatusController({
		chat: deps.chat,
		providers: deps.providers,
		bus: deps.bus,
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
	});
	const dispatchBoardStore = factories.createDispatchBoardStore(deps.bus, () => deps.dispatch.snapshot());
	const contextActivityStore = factories.createContextActivityStore(deps.bus);

	const footerToolCounts = new Map<string, number>();
	const footerActiveTools = new Set<string>();
	let footerToolErrors = 0;
	let footerToolTruncatedResults = 0;
	let lastTurnSummary: TurnSummary | null = null;
	let observabilitySnapshot = deps.observability.snapshot();
	let footer: FooterDashboardPanel;
	const notifications = factories.createNotificationCenter({
		onChange: () => {
			footer?.refresh();
			requestRender();
		},
	});
	const notify = (level: InteractiveNoticeLevel, text: string, key?: string): void => {
		notifications.add(key ? { level, text, key } : { level, text });
	};
	const dismissContextBootstrapNotices = (): void => {
		for (const notice of notifications.list()) {
			if (/^clio: (No CLIO\.md detected|malformed CLIO\.md ignored|Imported agent context changed)/.test(notice.text)) {
				notifications.dismiss(notice.id);
			}
		}
	};
	const announceTaskMemorySeedOffer = (): void => {
		const offer = deps.getTaskMemorySeedOffer?.() ?? null;
		if (!offer || offer.count === 0) return;
		notify(
			"info",
			`task memory: ${offer.count} handoff entr${offer.count === 1 ? "y" : "ies"} available from ${offer.source}; run /memory seed to import`,
			"memory:seed-offer",
		);
	};

	const footerDeps: FooterDashboardDeps = {
		providers: deps.providers,
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		getAgentStatus: () => statusController.current(),
		getTerminalColumns: () => deps.terminal.columns,
		getSessionTokens: () => observabilitySnapshot.session.tokens,
		getTokenThroughput: () => observabilitySnapshot.session.latestThroughput,
		getSessionCost: () => observabilitySnapshot.session.cost,
		getContextUsage: () => deps.chat.contextUsage(),
		getContextLedger: () => deps.chat.contextLedger(),
		getDispatchRows: () => dispatchBoardStore.rows(),
		...(deps.getTaskBoard ? { getTaskBoard: deps.getTaskBoard } : {}),
		...(deps.getTaskMemoryStatus ? { getTaskMemoryStatus: deps.getTaskMemoryStatus } : {}),
		getContextActivity: () => contextActivityStore.current(),
		...(deps.getLeaderArmed ? { getLeaderArmed: deps.getLeaderArmed } : {}),
		...(deps.getShutdownArmed ? { getShutdownArmed: deps.getShutdownArmed } : {}),
		getToolCounts: () => ({
			tools: Object.fromEntries(footerToolCounts),
			errors: footerToolErrors,
			active: footerActiveTools.size,
			truncatedResults: footerToolTruncatedResults,
		}),
		...(deps.getContextState
			? { getContextState: () => deps.getContextState?.(getCwd()) ?? { clioMd: "none", memoryCount: 0 } }
			: {}),
		getWorkspaceSnapshot: getLiveWorkspaceSnapshot,
		getExtensionStats,
		getSessionInfo: () => {
			const meta = deps.session?.current();
			return {
				id: meta?.id ?? deps.getSessionId?.() ?? null,
				name: meta?.name ?? null,
				turns: deps.sessionTranscript.liveSessionTurns(),
			};
		},
		getLastTurnSummary: () => lastTurnSummary,
		getNotifications: () => notifications.list(),
		dismissKeyLabel: formatKeyLabel(keybindings.getKeys("clio.notifications.dismiss")[0]),
	};
	footer = factories.buildFooter(footerDeps);
	const unsubscribeObservability = deps.observability.subscribe((snapshot) => {
		observabilitySnapshot = snapshot;
		footer.refresh();
		requestRender();
	});

	const editor = factories.createEditor(deps.tui, {
		getModelLabel: () => {
			const current = deps.getSettings?.();
			// The rail is the narrowest of the three, so it drops the spaces.
			return formatTargetLabel(current?.orchestrator?.target, current?.orchestrator?.model, { separator: "·" });
		},
		getThinkingLabel: () => {
			const current = deps.getSettings?.();
			return (
				resolveModelRuntimeCapabilitiesForProviders(
					deps.providers,
					current?.orchestrator?.target,
					current?.orchestrator?.model,
					current?.orchestrator?.thinkingLevel ?? "off",
				)?.thinking.display ??
				current?.orchestrator?.thinkingLevel ??
				"off"
			);
		},
		isStreaming: () => deps.chat.isStreaming(),
		willEnterSteer: (text) => willEnterSteerActiveWork(deps, text),
		getSubmitKeyLabel: () => formatKeyLabel(keybindings.getKeys("tui.input.submit")[0], "Enter"),
		getNewlineKeyLabel: () => formatKeyLabel(keybindings.getKeys("tui.input.newLine")[0], "Shift+Enter"),
	});
	editor.focused = true;
	const autocomplete: AutocompleteProvider = factories.createAutocomplete({
		listSkills: () => ({
			installed: deps.resources?.skills(getCwd()).items ?? [],
			marketplace: getMarketplaceSkills(),
		}),
	});
	editor.setAutocompleteProvider(autocomplete);

	const dispatchBoard = factories.createDispatchBoardView(
		() => dispatchBoardStore.rows(),
		() => observabilitySnapshot,
	);
	const chatRenderer = factories.createChatRenderer({
		chatPanel,
		requestRender,
		...(renderTrace
			? {
					visibleEventSequence: (event) => deps.resolveVisibleEventSequence?.(event) ?? null,
					onQueue: (eventSeq, action) => renderTrace.recordQueue(eventSeq, action),
					onPanelApplied: (eventSeq) => renderTrace.recordPanelApplied(eventSeq),
				}
			: {}),
	});
	const io = factories.createIo({
		appendReplayBlock: (renderBlock) => chatPanel.appendReplayBlock(renderBlock),
		requestRender,
	});
	const root = factories.buildLayout(
		{
			banner,
			chat: chatPanel,
			pending: followUpQueuePanel,
			editor,
			footer: footer.view,
		},
		{
			mode: settings.terminal?.tuiMode ?? "regular",
			fullscreenScrollbar: settings.terminal?.fullscreenScrollbar ?? "auto",
		},
	);
	deps.mount(root, editor);

	const scheduleInterval = deps.scheduleInterval ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
	const clearScheduledInterval =
		deps.clearScheduledInterval ??
		((handle: PresentationTickerHandle): void => clearInterval(handle as ReturnType<typeof setInterval>));
	const footerTicker = scheduleInterval(() => {
		const statusActive = statusController.current().phase !== "idle";
		if (!deps.chat.isStreaming() && !statusActive && !footer.isExpanded()) return;
		footer.refresh();
		requestRender();
	}, 120);
	footerTicker.unref?.();
	const toolElapsedTicker = scheduleInterval(() => {
		if (!deps.chat.isStreaming()) return;
		chatPanel.invalidate?.();
		requestRender();
	}, 1_000);
	toolElapsedTicker.unref?.();
	const workspaceTicker = scheduleInterval(() => {
		refreshLiveWorkspaceGit(true);
		footer.refresh();
		requestRender();
	}, 5_000);
	workspaceTicker.unref?.();

	let tickersStopped = false;
	let beforeStatusDisposed = false;
	let statusDisposed = false;
	const stopTickers = (): void => {
		if (tickersStopped) return;
		tickersStopped = true;
		clearScheduledInterval(footerTicker);
		clearScheduledInterval(toolElapsedTicker);
		clearScheduledInterval(workspaceTicker);
	};
	const disposeBeforeStatus = (): void => {
		if (beforeStatusDisposed) return;
		beforeStatusDisposed = true;
		footer.dispose();
		unsubscribeObservability();
		contextActivityStore.unsubscribe();
		dispatchBoardStore.unsubscribe();
	};
	const disposeStatus = (): void => {
		if (statusDisposed) return;
		statusDisposed = true;
		statusController.dispose();
	};
	return {
		keybindings,
		banner,
		chatPanel,
		followUpQueuePanel,
		statusController,
		dispatchBoardStore,
		contextActivityStore,
		footer,
		notifications,
		notify,
		dismissContextBootstrapNotices,
		announceTaskMemorySeedOffer,
		collapseWelcomeDashboard: () => {
			if (banner.collapseToSessionHeader()) requestRender();
		},
		editor,
		dispatchBoard,
		chatRenderer,
		io,
		root,
		getObservabilitySnapshot: () => observabilitySnapshot,
		recordToolStart: (toolCallId, toolName) => {
			footerActiveTools.add(toolCallId);
			footerToolCounts.set(toolName, (footerToolCounts.get(toolName) ?? 0) + 1);
		},
		recordToolEnd: ({ toolCallId, isError, truncated }) => {
			footerActiveTools.delete(toolCallId);
			if (isError) footerToolErrors += 1;
			if (truncated) footerToolTruncatedResults += 1;
		},
		setLastTurnSummary: (summary) => {
			lastTurnSummary = summary;
		},
		resetForNewSession: () => {
			banner.resetToLaunchpad();
			footerToolCounts.clear();
			footerActiveTools.clear();
			footerToolErrors = 0;
			footerToolTruncatedResults = 0;
			lastTurnSummary = null;
			statusController.reset();
		},
		stopTickers,
		disposeBeforeStatus,
		disposeStatus,
		dispose: () => {
			stopTickers();
			disposeBeforeStatus();
			disposeStatus();
		},
	};
}
