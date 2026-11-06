import { performance } from "node:perf_hooks";
import type { ClioSettings } from "../core/config.js";
import { DEFAULT_SETTINGS } from "../core/defaults.js";
import type { JobRecord } from "../core/job-types.js";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import { motionEnabled } from "../core/terminal-preferences.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import { isUserVisibleAgent } from "../domains/agents/spec.js";
import type { ContextState } from "../domains/context/index.js";
import { renderPromptContext } from "../domains/context/index.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { TaskMemoryOperatorStatus } from "../domains/memory/index.js";
import { selectProjectPreload } from "../domains/prompts/preload.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import { resolveModelRuntimeCapabilitiesForProviders, thinkingEffectNote } from "../domains/providers/index.js";

/**
 * Why the rail's thinking word differs from the level asked for, in the operator's terms (TY05). `medium runs as on`
 * made the reader decode a mapping; a toggle model has no levels at all, which is the fact that explains the word.
 */
function railThinkingNote(thinking: Parameters<typeof thinkingEffectNote>[0]): string | null {
	const note = thinkingEffectNote(thinking);
	if (note === null) return null;
	if (thinking.mechanism === "on-off") return "this model has no levels";
	if (thinking.mechanism === "always-on") return "this model always thinks";
	if (thinking.mechanism === "none") return note;
	return `${thinking.configuredLevel} not offered`;
}

import { createQuotaSummaryFeed } from "../domains/quota/summary-feed.js";
import type { ResourcesContract } from "../domains/resources/index.js";
import { jobIsComplete } from "../domains/scheduling/job-model.js";
import type { LocalCapacity } from "../domains/scheduling/local-capacity.js";
import type { SessionContract, TaskBoardSnapshot } from "../domains/session/index.js";
import type { TelemetryContract, TokenThroughputSnapshot } from "../domains/telemetry/index.js";
import type { UserTasksStore } from "../domains/user-tasks/store.js";
import type { Component, ScrollView, TUI } from "../engine/tui.js";
import { truncateToWidth, visibleWidth } from "../engine/tui.js";
import { createAssistantGenerationTiming, RATE_MIN_WINDOW_MS } from "../session-control/assistant-generation-timing.js";
import type { ChatLoop, ChatLoopEvent } from "../session-control/chat-loop.js";
import type { RunIo } from "../session-control/slash-commands.js";
import { parseSlashCommand } from "../session-control/slash-commands.js";
import type { TurnPreparationStep } from "../session-control/turn-state.js";
import { readWorkerRunResultFacts } from "../session-control/worker-run-results.js";
import type { JobOperations } from "../tools/job-types.js";
import { createBackgroundCallTracker } from "./background-calls.js";
import type { ChatPanel } from "./chat-panel.js";
import { createChatPanel } from "./chat-panel.js";
import type { CoalescingChatRenderer } from "./chat-renderer.js";
import { createCoalescingChatRenderer } from "./chat-renderer.js";
import type { EditorChrome } from "./clio-editor.js";
import { ClioEditor } from "./clio-editor.js";
import { createCommandOutputRunIo } from "./command-output.js";
import { createContextActivityStore, createContextProgressRail } from "./context-activity.js";
import { admissionHint } from "./context-operation-view.js";
import type { DispatchBoardView } from "./dispatch-board.js";
import {
	createDispatchBoardStore,
	createDispatchBoardView,
	dispatchStatusPresentation,
	summaryFleetRuns,
} from "./dispatch-board.js";
import { dockTop, setDockFooterRows } from "./dock.js";
import { parseEditorBashCommand } from "./editor-bash.js";
import { parseEditorSteerMention, resolveSteerTarget } from "./editor-steer.js";
import { createFleetDock } from "./fleet-dock.js";
import { readDurableFleetPlans } from "./fleet-plan-history.js";
import type { FleetPlanRunView } from "./fleet-plan-runs.js";
import { readDurableWorkerRuns, recordedRunUsage } from "./fleet-run-history.js";
import type { FollowUpQueuePanel } from "./follow-up-queue-panel.js";
import { createFollowUpQueuePanel } from "./follow-up-queue-panel.js";
import type { FooterDashboardDeps, FooterDashboardPanel } from "./footer/dashboard.js";
import { buildFooterDashboard } from "./footer/dashboard.js";
import type { ComposerKeyContext } from "./footer/key-hints.js";
import { besideCardDetail, type LiveWorkFacts, liveWorkStrip, railDetail } from "./footer/live-work.js";
import type { NotificationCenter } from "./footer/notifications.js";
import { createNotificationCenter, type Notification, routeAppliedNoticeKey } from "./footer/notifications.js";
import { routeFirstOutput } from "./footer/silence-note.js";
import type { CompactionRailFacts } from "./footer/widgets.js";
import {
	activeTaskRail,
	compactionRailLabel,
	composerPhasePresentation,
	idleReadinessPresentation,
	type RouteReadinessFacts,
	routeBlockerWords,
	type ShellSettlement,
	shellSettledPresentation,
} from "./footer/widgets.js";
import { loopSegment } from "./footer-panel.js";
import { getActiveRenderTrace } from "./interactive-shell.js";
import type { InteractiveNoticeLevel } from "./interactive-subscriptions.js";
import type { ClioKeybindingManager } from "./keybinding-manager.js";
import { createKeybindingManager, formatKeyLabel } from "./keybinding-manager.js";
import { buildLayout, preserveTranscriptScroll } from "./layout.js";
import type { QuotaProviders } from "./quota-view.js";
import type { SessionTranscript } from "./session-transcript.js";
import { createSilenceTranscriptRow } from "./silence-row.js";
import { type CompletionValue, createSlashCommandAutocompleteProvider } from "./slash-autocomplete.js";
import type { AgentStatus, StatusController, TurnSummary } from "./status/index.js";
import { createStatusController, humanWaitTotalMs } from "./status/index.js";
import type { SmoothStreamingMode } from "./stream-pacer.js";
import { processAutoPacingAllowed } from "./stream-pacing-policy.js";
import type { WorkspaceSurfaces } from "./surfaces/registry.js";
import { createDropAlerts } from "./telemetry-drops.js";
import { ACTIVITY_STEP_MS } from "./theme/glyphs.js";
import { clioTheme, GLYPH } from "./theme/index.js";
import { formatWaitClock, modelNickname } from "./theme/labels.js";
import type { WelcomeDashboardComponent } from "./welcome-dashboard.js";
import { createWelcomeDashboard } from "./welcome-dashboard.js";
import { bindWorkerResponseLimit, workerActivityWords } from "./worker-activity.js";
import type { WorkspaceFacts } from "./workspace-facts.js";

/** How long one `/skill <name>` listing serves later keystrokes. */
const SKILL_COMPLETION_TTL_MS = 2_000;

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
	/** How many of the main turn's own calls are parked on the operator. */
	getParkedCallCount?: () => number;
	getConnections?: () => { mcp: string[]; plugins: string[] };
	extensionCommands?: import("./slash-autocomplete.js").SlashAutocompleteOptions["extensionCommands"];
	getExtensionStatus?: () => ReadonlyArray<string>;
	/** What an active extension workspace draws in place of the host's parts. */
	workspaceSurfaces?: WorkspaceSurfaces;
	getLifecycleHint?: () => string | null;
	bus: TelemetryHub;
	providers: ProvidersContract;
	dispatch: Pick<DispatchContract, "snapshot">;
	telemetry: TelemetryContract;
	chat: ChatLoop;
	/** Messages waiting in the queue, which decides whether its keys are worth offering. */
	getQueuedMessageCount?: () => number;
	/** Whether the workers key reaches the workers dock rather than the Fleet Runs board. */
	workersDockAvailable?: () => boolean;
	workspaceFacts: WorkspaceFacts;
	sessionTranscript: Pick<SessionTranscript, "liveSessionTurns">;
	tui: TUI;
	terminal: { readonly columns: number; readonly rows?: number };
	mount?: (root: Component, editor: Component) => void;
	/** Stage 0's exact editor; when present no replacement editor is constructed. */
	editor?: ClioEditor;
	/** Stage 0's already-installed keybinding manager and pi-tui global. */
	keybindings?: ClioKeybindingManager;
	/** Pending boot submissions remain visible until serial admission removes them. */
	bootPending?: Component;
	getSettings?: () => Readonly<ClioSettings>;
	resources?: Pick<ResourcesContract, "skillsForDisplay" | "promptsForDisplay">;
	agents?: Pick<AgentsContract, "listSpecs">;
	session?: Pick<SessionContract, "current">;
	recordTurnHumanWait?: (fields: { turnId: string; humanWaitMs: number }) => void;
	jobs?: Pick<JobOperations, "list" | "subscribe">;
	getSessionId?: () => string | null;
	getTaskBoard?: () => TaskBoardSnapshot | null;
	getLocalCapacity?: () => LocalCapacity | null;
	userTasks?: Pick<UserTasksStore, "snapshot">;
	getTaskMemoryStatus?: () => TaskMemoryOperatorStatus;
	getTaskMemorySeedOffer?: () => { source: string; count: number } | null;
	getContextState?: (cwd?: string) => ContextState;
	/** Whether the Ctrl+G leader is armed and waiting for its next key. */
	getLeaderArmed?: () => boolean;
	/** Whether a Ctrl+C armed the double tap and its window is still open. */
	getShutdownArmed?: () => boolean | string;
	/** Whether a permission prompt owns the keyboard, for the composer's CONFIRM rail. */
	isAwaitingApproval?: () => boolean;
	/** The overlay holding the keyboard, so a dock can stop naming composer keys while it does. */
	getOverlayState?: () => string;
	/** Whether that prompt has a mutation to inspect, and whether it is open (issue #254). */
	getPermissionInspection?: () => import("./permission-hint.js").PermissionInspectionHint;
	/** Whether that prompt's terms are open, so the rail's Esc says it hides them rather than denying. */
	getPermissionTerms?: () => import("./permission-hint.js").PermissionTermsHint;
	getCwd?: () => string;
	/**
	 * True when this process resumed an existing session at boot (`--continue`,
	 * `--session <id>`). The header opens collapsed rather than showing
	 * fresh-start onboarding above a conversation that already has history.
	 */
	startsResumed?: boolean;
	resolveVisibleEventSequence?: (event: ChatLoopEvent) => number | null;
	resolveStreamIngress?: (
		event: ChatLoopEvent,
	) => { sequence: number; generation: string | number; ingressAt: number } | null;
	commitFrame?: (reason?: string) => Promise<unknown>;
	hasObservedBackpressure?: () => boolean;
	onSmoothStreamingMode?: (mode: SmoothStreamingMode, pacingActive: boolean) => void;
	scheduleInterval?: (callback: () => void, intervalMs: number) => PresentationTickerHandle;
	clearScheduledInterval?: (handle: PresentationTickerHandle) => void;
	now?: () => number;
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
	notify(level: InteractiveNoticeLevel, text: string, key?: string, ttlMs?: number): void;
	dismissContextBootstrapNotices(): void;
	announceTaskMemorySeedOffer(): void;
	collapseWelcomeDashboard(): void;
	editor: ClioEditor;
	editorChrome: EditorChrome;
	dispatchBoard: DispatchBoardView;
	chatRenderer: CoalescingChatRenderer;
	io: RunIo;
	root: Component;
	changeOutputStyle(mutation: () => void): void;
	announceSettingChanges(): void;
	setLocalBashRunning(running: boolean, command?: string, settled?: ShellSettlement): void;
	/** The operator asked the running shell line to stop; it has not necessarily gone yet. */
	setLocalBashCancelling(): void;
	getQuotaSnapshots(): QuotaProviders;
	/** Fold one raw chat event into the ephemeral throughput shown only while this turn is active. */
	recordChatEvent(event: ChatLoopEvent): void;
	recordToolStart(toolCallId: string, toolName: string): void;
	recordToolEnd(result: PresentationToolEnd): void;
	/** The same accumulated tool counts shown by the footer. */
	toolCounts(): ReadonlyMap<string, number>;
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

/** A draft whose Enter is not a message: Clio runs it, wherever a turn is. */
function draftOperator(text: string): "command" | "shell" | null {
	if (parseEditorBashCommand(text)) return "shell";
	const kind = parseSlashCommand(text.trim()).kind;
	return kind === "unknown" || kind === "empty" ? null : "command";
}

/** What Enter does with this draft, for the hint row. An empty composer has nothing to say about Enter. */
function draftKeyContext(
	text: string,
	streaming: boolean,
	holding: boolean,
	localShell: boolean,
	runsCommand: (token: string) => boolean = () => false,
): ComposerKeyContext {
	const empty = text.trim().length === 0;
	if (parseEditorBashCommand(text)) {
		if (streaming || localShell) return "shell-refused";
		return holding ? "hold" : "send-shell";
	}
	if (!empty && draftOperator(text) === "command") {
		const parsed = parseSlashCommand(text.trim());
		const name = truncateToWidth(text.trim().split(/\s+/u)[0] ?? "", 24, GLYPH.ellipsis, false);
		if (parsed.kind === "usage-error") return `usage:${name}`;
		// The parser knows only built-in commands; an installed extension's command runs too, and saying
		// Enter only "checks" it read as if the command were not there.
		if (parsed.kind === "unknown-command" && !runsCommand(parsed.token)) return `check:${name}`;
		return streaming ? `run-command:${name}` : `command:${name}`;
	}
	if (streaming) return empty ? "steer-empty" : "steer";
	if (holding) return empty ? "hold-empty" : "hold";
	if (localShell) return "shell";
	return empty ? "idle" : "send";
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
/** A step this short would flash a word nobody can read, so the rail keeps to `is preparing` until one lasts. */
const PREPARATION_WORTH_NAMING_MS = 1000;
const PREPARATION_STEP_WORDS: Readonly<Record<TurnPreparationStep, string>> = {
	capabilities: "asking the target about the model",
	"prompt-hook": "running your prompt hook",
	images: "describing the attached images",
	"turn-control": "reading turn controls",
	"turn-start": "running turn-start steps",
	compile: "compiling the prompt",
};

export function createInteractivePresentation(deps: InteractivePresentationDeps): InteractivePresentation {
	const factories = { ...DEFAULT_FACTORIES, ...deps.factories };
	const getCwd = deps.getCwd ?? (() => process.cwd());
	const now = deps.now ?? performance.now.bind(performance);
	const requestRender = (): void => deps.tui.requestRender();
	const sessionId = (): string | null => deps.session?.current()?.id ?? deps.getSessionId?.() ?? null;
	let loopSessionId = sessionId();
	const loopJobs = new Map<string, JobRecord>();
	let loopSnapshot: readonly JobRecord[] = [];
	const updateLoopSnapshot = (): void => {
		loopSnapshot = [...loopJobs.values()].sort((left, right) => {
			const priority = (job: JobRecord): number =>
				job.cancelRequested || job.active !== null || job.delivery?.state === "running"
					? 0
					: job.state === "paused"
						? 2
						: 1;
			return priority(left) - priority(right) || (left.nextDueAt ?? Infinity) - (right.nextDueAt ?? Infinity);
		});
	};
	const resetLoopJobs = (): void => {
		loopSessionId = sessionId();
		loopJobs.clear();
		for (const job of deps.jobs?.list() ?? []) {
			if (job.owner.sessionId === loopSessionId && !jobIsComplete(job)) loopJobs.set(job.id, job);
		}
		updateLoopSnapshot();
	};
	resetLoopJobs();
	const unsubscribeLoops = deps.jobs?.subscribe((job) => {
		if (loopSessionId !== sessionId()) resetLoopJobs();
		if (job.owner.sessionId !== loopSessionId) return;
		if (jobIsComplete(job)) loopJobs.delete(job.id);
		else loopJobs.set(job.id, job);
		updateLoopSnapshot();
		requestRender();
	});
	const settings = deps.getSettings?.() ?? structuredClone(DEFAULT_SETTINGS);
	// Read per render, so a limit changed in /settings is the one a silent worker's words name.
	bindWorkerResponseLimit(() => {
		const seconds = (deps.getSettings?.() ?? settings).safety.limits.workerResponseSeconds;
		return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
	});
	const keybindings = deps.keybindings ?? factories.createKeybindings(settings);
	const { getExtensionStats, getLiveWorkspaceSnapshot, getWorkspaceSnapshot, refreshLiveWorkspaceGit } =
		deps.workspaceFacts;
	/**
	 * The submit binding as the operator has it, or null when it is unbound or
	 * disabled. The header prints a key only when pressing it would actually
	 * submit, so a rebound or removed binding silently drops the hint instead of
	 * advertising a default that does nothing.
	 */
	const effectiveSubmitKeyLabel = (): string | null => {
		if (keybindings.isDisabled("tui.input.submit")) return null;
		const key = keybindings.getKeys("tui.input.submit")[0];
		return key === undefined || key.length === 0 ? null : formatKeyLabel(key, "");
	};

	const quotaSummary = createQuotaSummaryFeed({
		onUpdate: () => {
			footer?.refresh();
			requestRender();
		},
	});
	const announcedPreloadCwds = new Set<string>();
	const banner = factories.createBanner({
		providers: deps.providers,
		getTerminalRows: () => (deps.tui as Partial<Pick<TUI, "terminal">>).terminal?.rows,
		...(deps.agents ? { getAgentCount: () => deps.agents?.listSpecs().filter(isUserVisibleAgent).length ?? 0 } : {}),
		getWorkspaceSnapshot,
		// The authoritative project-context reader. It is synchronous on a cache
		// miss, so the banner refreshes it off the frame rather than calling it
		// during render; the frame that shows the result is asked for below.
		...(deps.getContextState ? { getContextState: deps.getContextState } : {}),
		getProjectPreload: (cwd) => {
			const current = deps.getSettings?.();
			const capabilities = resolveModelRuntimeCapabilitiesForProviders(
				deps.providers,
				current?.chat?.target,
				current?.chat?.model,
			)?.capabilities;
			const preload = selectProjectPreload(renderPromptContext(cwd), capabilities?.tools ?? null, { cwd }).classification;
			// Coverage is a session fact, not something to put in the operator's face: one short footer
			// notice per workspace that expires, with /context holding the detail. The welcome shows nothing.
			if (preload.mode === "partial" && !announcedPreloadCwds.has(cwd)) {
				announcedPreloadCwds.add(cwd);
				const file = /^([^:]+):/u.exec(preload.label)?.[1] ?? "project instructions";
				queueMicrotask(() =>
					notifications.add({
						level: "info",
						text: `${file} is only partly loaded · /context for details`,
						key: "project-preload",
						ttlMs: 8_000,
					}),
				);
			}
			return null;
		},
		getSubmitKeyLabel: () => effectiveSubmitKeyLabel(),
		getKeyLabel: (action) => {
			const key = keybindings.isDisabled(action) ? undefined : keybindings.getKeys(action)[0];
			return key ? formatKeyLabel(key, "") : null;
		},
		onFactsRefreshed: requestRender,
		// Subscription usage is read lazily off the render path and cached, so the
		// banner reads a string and never awaits a provider.
		getQuotaSummary: () => quotaSummary.peek(),
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
	});
	// A boot-time `--continue`/`--session` resume opens onto an existing
	// conversation, so the launchpad's fresh-start onboarding would be a lie
	// before the operator has typed anything.
	if (deps.startsResumed === true) banner.collapseToSessionHeader();
	const renderTrace = getActiveRenderTrace();
	const chatPanel = factories.createChatPanel({
		getRunTarget: () => deps.chat.lastRunSnapshot?.()?.targetId ?? null,
		...(deps.telemetry.read ? { getTelemetry: () => deps.telemetry.read?.live() ?? null } : {}),
		getOutputStyle: () => deps.getSettings?.().interface.outputDetail ?? "standard",
		getTerminalRows: () => process.stdout.rows ?? 40,
		getStopRequestedAt: () => {
			const status = statusController.current();
			return status.phase === "cancelling" ? (status.cancelRequestedAt ?? null) : null;
		},
		getHumanWaitMs: () => humanWaitTotalMs(statusController.current(), Date.now()),
		...(deps.recordTurnHumanWait ? { recordTurnHumanWait: deps.recordTurnHumanWait } : {}),
		requestRender,
		...(renderTrace ? { onRenderMetrics: (metrics) => renderTrace.recordPanelRender(metrics) } : {}),
		// Rendering ahead yields to input between steps and waits out a stream.
		scheduleIdle: (step) => {
			const run = (): void => {
				if (tickersStopped) return;
				if (deps.chat.isStreaming()) {
					setTimeout(run, 250).unref();
					return;
				}
				if (step()) setImmediate(run).unref();
			};
			setImmediate(run).unref();
		},
	});
	const followUpQueuePanel = factories.createFollowUpQueuePanel({
		getDequeueKey: () => {
			return keybindings.actionLabel("clio-coder.message.dequeue");
		},
		getNavigateKey: () => keybindings.actionLabel("clio-coder.queue.open"),
		getSendNowKey: () => keybindings.actionLabel("clio-coder.message.interrupt"),
		...(deps.getOverlayState ? { getOverlayState: deps.getOverlayState } : {}),
		isHeld: () => !deps.chat.isStreaming() && deps.chat.turnPreparation().phase === "idle",
	});
	const statusController = factories.createStatusController({
		chat: deps.chat,
		providers: deps.providers,
		bus: deps.bus,
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
	});
	const unbindRunReaders = deps.telemetry.bindRunReaders({
		dispatchSnapshot: () => deps.dispatch.snapshot(),
		readRunResult: (runId) => readWorkerRunResultFacts(runId),
	});
	const dispatchBoardStore = factories.createDispatchBoardStore(
		deps.telemetry,
		() => readDurableFleetPlans(getCwd(), deps.getSettings?.().fleet.worktrees.root),
		() => readDurableWorkerRuns(getCwd(), deps.getSettings?.().fleet.worktrees.root),
		recordedRunUsage,
	);
	const contextActivityStore = factories.createContextActivityStore(deps.bus, () => deps.chat.getSessionId());

	const footerToolCounts = new Map<string, number>();
	const footerActiveTools = new Set<string>();
	let footerToolErrors = 0;
	let footerToolTruncatedResults = 0;
	let lastTurnSummary: TurnSummary | null = null;
	let telemetrySnapshot = deps.telemetry.snapshot();
	const generationTiming = createAssistantGenerationTiming();
	let liveGeneration = false;
	/** Routes that streamed reasoning this session, which the thinking rail then cannot deny. */
	const reasoningRoutes = new Set<string>();
	const routeKey = (target: string | null | undefined, model: string | null | undefined): string =>
		`${target ?? ""}#${model ?? ""}`;
	/** Route and asked level pairs a turn already ran under, so a level the route cannot honor is news once. */
	const thinkingNotesDelivered = new Set<string>();
	const thinkingNoteKey = (): string => {
		const chat = deps.getSettings?.()?.chat;
		return `${routeKey(chat?.target, chat?.model)}#${chat?.thinkingLevel ?? "off"}`;
	};
	const recordReasoningRoute = (event: ChatLoopEvent): void => {
		if (event.type !== "thinking_delta" || event.delta.length === 0) return;
		const current = deps.getSettings?.();
		const key = routeKey(current?.chat?.target, current?.chat?.model);
		if (reasoningRoutes.has(key)) return;
		reasoningRoutes.add(key);
		deps.tui.requestRender();
	};
	const recordChatEvent = (event: ChatLoopEvent): void => {
		generationTiming.record(event, now());
		if (event.type === "agent_start") {
			liveGeneration = true;
			thinkingNotesDelivered.add(thinkingNoteKey());
		}
		if (event.type === "agent_end") liveGeneration = false;
		recordReasoningRoute(event);
	};
	const currentLiveThroughput = (): TokenThroughputSnapshot | null => {
		if (!liveGeneration) return null;
		const timing = generationTiming.snapshot(now());
		if (!timing) return null;
		const { outputTokens, estimated } = generationTiming.output();
		if (outputTokens <= 0) return null;
		const { durationMs } = timing;
		// Zero reads as no rate; the output count still shows while the window is too short to divide (RATE_MIN_WINDOW_MS).
		const tokensPerSecond = durationMs >= RATE_MIN_WINDOW_MS ? outputTokens / (durationMs / 1000) : 0;
		return { tokensPerSecond, outputTokens, estimated, durationMs };
	};
	let footer: FooterDashboardPanel;
	const backgroundCalls = createBackgroundCallTracker(deps.bus, () => {
		footer?.refresh();
		requestRender();
	});
	/** A notice about the session's route stops the moment the route moves on, or the fault it reported clears. */
	const routeNoticeStands = (notice: Notification): boolean => {
		if (!notice.key?.startsWith("route-applied:")) return true;
		const route = deps.getSettings?.().chat;
		if (notice.key !== routeAppliedNoticeKey(route?.target, route?.model)) return false;
		if (notice.level !== "warning") return true;
		return deps.providers.list().find((status) => status.target.id === route?.target)?.health.status === "down";
	};
	const notifications = factories.createNotificationCenter({
		onChange: () => {
			footer?.refresh();
			requestRender();
		},
		stillTrue: routeNoticeStands,
	});
	const notify = (level: InteractiveNoticeLevel, text: string, key?: string, ttlMs?: number): void => {
		notifications.add({ level, text, ...(key ? { key } : {}), ...(ttlMs === undefined ? {} : { ttlMs }) });
	};
	const dismissContextBootstrapNotices = (): void => {
		for (const notice of notifications.list()) {
			if (
				/^(?:clio-coder|clio): (No CLIO(?:-CODER)?\.md detected|malformed CLIO(?:-CODER)?\.md ignored|Imported agent context changed)/.test(
					notice.text,
				)
			) {
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

	let localBashStartedAt: number | null = null;
	// The footer composes once before the editor exists; until then no list can be open.
	let composerEditor: ClioEditor | null = null;
	let localBashCommand: string | null = null;
	let localBashCancelledAt: number | null = null;
	/** The last direct shell line, until a model turn settles after it; idle leads with it while it is the newest event. */
	let lastShell: ShellSettlement | null = null;
	const footerDeps: FooterDashboardDeps = {
		getWelcomeVisible: () => banner.isLaunchpadVisible?.() === true,
		providers: deps.providers,
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		...(deps.getConnections ? { getConnections: deps.getConnections } : {}),
		getAgentStatus: () => {
			const status = statusController.current();
			if (localBashStartedAt === null || (status.phase !== "idle" && status.phase !== "ended")) return status;
			return {
				...status,
				phase: localBashCancelledAt === null ? "tool_running" : "cancelling",
				since: localBashStartedAt,
				lastMeaningfulAt: Math.max(status.lastMeaningfulAt, localBashStartedAt),
				toolStartedAt: localBashStartedAt,
				activeTools: [],
				...(localBashCancelledAt === null ? {} : { cancelRequestedAt: localBashCancelledAt }),
				tool: {
					toolName: "bash",
					toolPreview: "local shell",
					startedAt: localBashStartedAt,
					operatorShell: true,
					...(localBashCommand === null ? {} : { toolSubject: localBashCommand }),
				},
			};
		},
		getTerminalColumns: () => deps.terminal.columns,
		getTerminalRows: () => deps.terminal.rows ?? process.stdout.rows ?? 40,
		onHeightChange: (rows) => {
			if (setDockFooterRows(deps.tui, rows)) requestRender();
		},
		...(deps.telemetry.read ? { getTelemetry: () => deps.telemetry.read?.live() ?? null } : {}),
		getTokenThroughput: () => (liveGeneration ? currentLiveThroughput() : null),
		getQuotaSnapshots: () => {
			quotaSummary.peekSnapshots();
			return deps.telemetry.read?.quota().providers ?? [];
		},
		getContextUsage: () => deps.chat.contextUsage(),
		getContextLedger: () => deps.chat.contextLedger(),
		getDispatchRows: () => dispatchBoardStore.rows(),
		...(deps.getTaskBoard ? { getTaskBoard: deps.getTaskBoard } : {}),
		...(deps.getLocalCapacity ? { getLocalCapacity: deps.getLocalCapacity } : {}),
		...(deps.getTaskMemoryStatus ? { getTaskMemoryStatus: deps.getTaskMemoryStatus } : {}),
		getContextActivity: () => contextActivityStore.current(),
		...(deps.getLeaderArmed ? { getLeaderArmed: deps.getLeaderArmed } : {}),
		...(deps.getShutdownArmed ? { getShutdownArmed: deps.getShutdownArmed } : {}),
		getActiveSkillSurface: () => deps.chat.activeSkillSurface(),
		getActiveEggs: () => deps.chat.activeEggs?.() ?? [],
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
		...(deps.getExtensionStatus ? { getExtensionStatus: deps.getExtensionStatus } : {}),
		...(deps.workspaceSurfaces
			? {
					getExtensionFacts: (width: number) => deps.workspaceSurfaces?.statusFacts(width) ?? [],
					getWorkspaceLine: (width: number) => deps.workspaceSurfaces?.footerLine(width) ?? null,
				}
			: {}),
		...(deps.getLifecycleHint ? { getLifecycleHint: deps.getLifecycleHint } : {}),
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
		getEndedNotifications: () => notifications.ended(),
		getBackgroundCalls: () => backgroundCalls.active(),
		getKeyContext: () => {
			if (dockTop(deps.tui) !== null || composerEditor?.isShowingAutocomplete()) return "surface";
			const text = composerEditor?.getText() ?? "";
			// The rail under a draft addressed to a worker already names its Enter and Esc.
			if (composerEditor?.steerTarget(text)) return "surface";
			// A stop already asked for owns an empty composer's hint until the work has exited.
			const stopping =
				localBashCancelledAt !== null ||
				(footerDeps.getAgentStatus?.() ?? statusController.current()).phase === "cancelling";
			if (stopping && text.trim().length === 0) return "stopping";
			const context = draftKeyContext(
				text,
				deps.chat.isStreaming(),
				deps.chat.turnPreparation().phase !== "idle",
				localBashStartedAt !== null,
				(token) => deps.extensionCommands?.().some((row) => row.available && row.invocation === token) ?? false,
			);
			// A failed turn is the newest thing on screen until a shell line or another turn follows it.
			return context === "idle" && lastShell === null && lastTurnSummary?.stopReason === "error" ? "recover" : context;
		},
		getKeyHintFacts: () => {
			const current = deps.getSettings?.();
			const mechanism = resolveModelRuntimeCapabilitiesForProviders(
				deps.providers,
				current?.chat?.target,
				current?.chat?.model,
				current?.chat?.thinkingLevel ?? "off",
			)?.thinking.mechanism;
			return {
				...(deps.getQueuedMessageCount ? { queued: deps.getQueuedMessageCount() } : {}),
				workers: dispatchBoardStore.rows().length,
				...(deps.workersDockAvailable ? { workersDock: deps.workersDockAvailable() } : {}),
				thinkingCycles: mechanism === "effort-levels" || mechanism === "budget-tokens",
			};
		},
		get dismissKeyLabel() {
			return keybindings.actionLabel("clio-coder.notifications.dismiss");
		},
	};
	footer = factories.buildFooter(footerDeps);
	const unsubscribeProjection = deps.telemetry.subscribe((snapshot) => {
		telemetrySnapshot = snapshot;
		footer.refresh();
		requestRender();
	});
	// Spend repaints on persisted batches only, coalesced to 10 Hz by the read model; never per token (#434 §11.3).
	// One listener for every topic, so an update naming several repaints once.
	const repaintSpend = () => {
		footer.refresh();
		requestRender();
	};
	const unsubscribeTelemetry = (["session", "calls", "cost", "runs", "quota"] as const).map(
		(topic) => deps.telemetry.read?.subscribe(topic, repaintSpend) ?? (() => {}),
	);
	// A journal that loses records raises one notice per owner a minute; a rise held by the window is checked when
	// the window ends, so it is never left unreported (#434 §14).
	const dropAlerts = createDropAlerts();
	let dropCheck: NodeJS.Timeout | undefined;
	const checkDrops = () => {
		const readModel = deps.telemetry.read;
		if (!readModel) return;
		const now = Date.now();
		const alerts = dropAlerts.observe(readModel.health(), now);
		for (const alert of alerts) notify("warning", alert.text, alert.key);
		if (alerts.length > 0) requestRender();
		if (dropCheck) clearTimeout(dropCheck);
		dropCheck = undefined;
		const due = dropAlerts.nextCheckAt();
		if (due === null) return;
		dropCheck = setTimeout(checkDrops, Math.max(0, due - now));
		dropCheck.unref();
	};
	unsubscribeTelemetry.push(deps.telemetry.read?.subscribe("health", checkDrops) ?? (() => {}));

	/** What a running plan is doing in rail words: the step it runs now, or that it is stopping. */
	const planRailWords = (plan: FleetPlanRunView): string => {
		const running = plan.steps.filter((step) => step.state === "running").map((step) => step.stepId);
		const done = plan.steps.filter((step) => step.state === "passed" || step.state === "replayed").length;
		const count = `${done}/${plan.requiredStepCount} steps`;
		if (plan.state === "cancelling") return `stopping ${running.join(", ") || "its steps"}`;
		return running.length > 0 ? `running ${running.join(", ")} · ${count}` : count;
	};
	/** The model the rail names for a phase: once a request is out, the model it went to, whatever route was picked since. */
	const phaseModelName = (status: AgentStatus): string => {
		const out = status.phase === "preparing" ? undefined : status.modelRequest?.modelId;
		return modelNickname(out ?? deps.getSettings?.().chat?.model);
	};
	const currentLiveWork = (): LiveWorkFacts => {
		const status = footerDeps.getAgentStatus?.() ?? statusController.current();
		return {
			// The strip over a dock reads the phase with the rail's own name and compaction facts, so the two cannot disagree (F2).
			actor: phaseModelName(status),
			...(deps.getSettings?.().chat?.target ? { target: deps.getSettings?.().chat?.target ?? "" } : {}),
			status,
			compaction: runningCompaction(),
			// A running plan is work too: with only the workers counted the rail read ready while a plan step ran (HS10).
			workers: summaryFleetRuns(dispatchBoardStore.liveRows?.() ?? dispatchBoardStore.activeRows()),
			background: backgroundCalls.active(),
			workerActivity: (row, room) =>
				row.plan !== undefined
					? planRailWords(row.plan)
					: // A queued run's progress reads `starting`, which it is not until it has a slot.
						row.status === "enqueued"
						? "waiting for a slot"
						: // Its last phase reads `finishing`, which is work ending on its own; the board says `stopping`.
							row.status === "cancelling"
							? "stopping"
							: row.progress
								? workerActivityWords(row.progress, { room, history: row.routeFirstOutput ?? null })
								: dispatchStatusPresentation(row.status).label,
			now: Date.now(),
		};
	};
	const runningCompaction = (): CompactionRailFacts | null => {
		const activity = contextActivityStore.current();
		return activity?.kind === "compaction" && activity.completedAtMs === null
			? { phase: activity.phase, startedAtMs: activity.startedAtMs }
			: null;
	};
	const editorChrome: EditorChrome = {
		getLoopRail: (width) => loopSegment(loopSnapshot, width, Date.now()),
		getTaskRail: (room) => {
			const board = deps.getTaskBoard?.();
			if (!board) return null;
			const status = footerDeps.getAgentStatus?.() ?? statusController.current();
			return activeTaskRail(clioTheme(), board, room, status.phase !== "idle" && status.phase !== "ended");
		},
		getModelLabel: () => {
			const route = deps.getSettings?.().chat;
			// A route with no model of its own runs on its target's default, which the rail has to name.
			const modelId =
				route?.model ?? deps.providers.list().find((entry) => entry.target.id === route?.target)?.target.defaultModel;
			// Keep raw fields separate through the terminal-lease proxy until render knows its width.
			return { targetId: route?.target, modelId };
		},
		getThinkingLabel: () => editorChrome.getThinking?.().label ?? "off",
		getHarnessStatus: (width, reserved = 0) => {
			const status = footerDeps.getAgentStatus?.() ?? statusController.current();
			const detail = railDetail(currentLiveWork(), width);
			const route = deps.getSettings?.().chat;
			if (status.phase !== "idle") {
				const name = phaseModelName(status);
				// With room to spare the phase gives up its lesser facts to the work beside it: the rail dropped a whole
				// `verifier waiting for a slot` to keep `requested by Judge-model` (HS10). A narrow rail keeps the phase whole.
				// The subject competes inside the fitter, so nothing is reserved for it here.
				const beside = detail !== null && width >= 80 ? visibleWidth(detail) + 3 : 0;
				const presented = composerPhasePresentation(
					status,
					width,
					Date.now(),
					name,
					undefined,
					reserved + beside,
					runningCompaction(),
					route?.target ?? undefined,
				);
				return {
					...(name !== modelNickname(route?.model) ? { subject: name } : {}),
					...presented,
					...(detail ? { detail } : {}),
				};
			}
			const target = deps.providers.list().find((candidate) => candidate.target.id === route?.target);
			if (!target || !route?.target) {
				return detail ? { glyph: GLYPH.queued, label: "is idle", token: "counter", live: false, detail } : null;
			}
			const last = lastTurnSummary;
			const onRoute = last !== null && last.targetId === route.target && last.modelId === route.model;
			const routeFacts: RouteReadinessFacts = {
				targetId: route.target,
				available: target.available,
				reason: target.reason,
				health: target.health.status,
				lastStop: onRoute ? last.stopReason : null,
				workerAnswered:
					(routeFirstOutput(deps.telemetry.read?.live() ?? null, route.target, route.model, "worker")?.calls ?? 0) > 0,
				...(onRoute && last.failure !== undefined ? { lastFailure: last.failure } : {}),
			};
			if (lastShell !== null && !detail) {
				const blocker = routeBlockerWords(routeFacts);
				return shellSettledPresentation(
					lastShell,
					width,
					reserved,
					blocker === null ? null : `${phaseModelName(status)} ${blocker}`,
				);
			}
			const readiness = idleReadinessPresentation(routeFacts, width, reserved, phaseModelName(status));
			if (!detail) return readiness;
			// Beside running work a healthy route's small print gives way; a blocker or a doubt still reads first.
			const quiet = readiness.glyph === GLYPH.queued && target.health.status === "healthy";
			return { ...readiness, ...(quiet ? { label: "is idle" } : {}), detail };
		},
		getLiveWorkStrip: (width, escVerb) => liveWorkStrip(clioTheme(), currentLiveWork(), width, escVerb),
		getBesideCard: (room) =>
			besideCardDetail(currentLiveWork(), room, {
				streaming: deps.chat.isStreaming(),
				parked: (deps.getParkedCallCount?.() ?? 0) > 0,
			}),
		...(deps.workspaceSurfaces
			? { getWorkspaceRail: (width: number) => deps.workspaceSurfaces?.rail(width) ?? null }
			: {}),
		getContextUsage: () => {
			const usage = deps.chat.contextUsage();
			return {
				used: usage.tokens,
				contextWindow: usage.contextWindow,
				toolSchemaTokens: usage.breakdown?.toolSchemaTokens ?? null,
				breakdown: usage.breakdown ?? null,
				ledger: usage.revision ? null : deps.chat.contextLedger(),
				...(usage.revision
					? {
							budget: {
								revision: usage.revision,
								historical: usage.historical ?? true,
								inputSource: usage.inputSource ?? "unknown",
							},
						}
					: {}),
			};
		},
		getThinking: () => {
			const current = deps.getSettings?.();
			const thinking = resolveModelRuntimeCapabilitiesForProviders(
				deps.providers,
				current?.chat?.target,
				current?.chat?.model,
				current?.chat?.thinkingLevel ?? "off",
			)?.thinking;
			// A route with no thinking control can still send reasoning, and what it sent outranks what its catalog row says.
			if (thinking?.mechanism === "none" && reasoningRoutes.has(routeKey(current?.chat?.target, current?.chat?.model))) {
				return { label: "off", hasLevels: false, supportedLevels: [], note: "model reasons anyway" };
			}
			// Before the first probe answers, a local or gateway route's capabilities are guesses: `model has no thinking` showed
			// on the first frame of a route about to say `think on`. Until then the rail says what was asked for and no more.
			const asked = current?.chat?.thinkingLevel ?? "off";
			if (asked !== "off") {
				const status = deps.providers.list().find((candidate) => candidate.target.id === current?.chat?.target);
				if (status?.health.status === "unknown" && status.discoveredModelsSource !== "runtime") {
					return { label: asked, hasLevels: false };
				}
			}
			// The rail states what the model will do. A setting the model cannot honor
			// says so in words, where `low→off` left the reader to decode the arrow (F13).
			const note = thinking ? railThinkingNote(thinking) : null;
			return {
				label:
					note !== null && thinking
						? thinking.display
						: thinking?.mechanism === "none"
							? "unavailable"
							: (thinking?.requestedDisplay ?? current?.chat?.thinkingLevel ?? "off"),
				hasLevels: thinking?.mechanism === "effort-levels" || thinking?.mechanism === "budget-tokens",
				supportedLevels: thinking?.supportedLevels ?? [],
				...(note !== null ? { note } : {}),
				// A route with no thinking control has no setting to read. The rail speaks up only while a level
				// the operator chose is news: the default is nobody's request, and a turn under it ends the news.
				...(thinking?.mechanism === "none" &&
				(note === null || asked === DEFAULT_SETTINGS.chat.thinkingLevel || thinkingNotesDelivered.has(thinkingNoteKey()))
					? { quiet: true }
					: {}),
			};
		},
		getOutputStyle: () => deps.getSettings?.().interface.outputDetail ?? "standard",
		getMotionEnabled: () => deps.getSettings?.().interface.demo !== false,
		isStreaming: () => deps.chat.isStreaming(),
		getAutonomy: () => deps.getSettings?.().safety.autonomy ?? "default",
		...(deps.isAwaitingApproval ? { isAwaitingApproval: deps.isAwaitingApproval } : {}),
		...(deps.getPermissionInspection ? { getPermissionInspection: deps.getPermissionInspection } : {}),
		...(deps.getPermissionTerms ? { getPermissionTerms: deps.getPermissionTerms } : {}),
		getTurnPreparation: () => deps.chat.turnPreparation().phase,
		getCompactionLabel: (room) => compactionRailLabel(runningCompaction(), room, Date.now()),
		getPreparationDetail: () => {
			const { phase, since, stage } = deps.chat.turnPreparation();
			if (phase !== "preparing" || since <= 0) return null;
			const now = Date.now();
			if (now - since < PREPARATION_WORTH_NAMING_MS) return null;
			const held = formatWaitClock(now - since);
			return stage && now - stage.since >= PREPARATION_WORTH_NAMING_MS
				? `${held} · ${PREPARATION_STEP_WORDS[stage.step]}`
				: held;
		},
		willEnterSteer: (text) => willEnterSteerActiveWork(deps, text),
		getDraftOperator: draftOperator,
		getSteerRecipient: (token) => {
			try {
				const running = deps.dispatch.snapshot().running.map((run) => ({
					runId: run.runId,
					agentId: run.agentId,
					...(run.outcomePhase === "queued" ? { queued: true } : {}),
				}));
				const resolved = resolveSteerTarget(token, running);
				return resolved.kind === "match" ? { agentId: resolved.run.agentId, queued: resolved.run.queued === true } : null;
			} catch {
				// The rail repaints every frame; an unreadable fleet just leaves it unlabelled.
				return null;
			}
		},
		getSubmitKeyLabel: () => formatKeyLabel(keybindings.getKeys("tui.input.submit")[0], "Enter"),
		getNewlineKeyLabel: () => formatKeyLabel(keybindings.getKeys("tui.input.newLine")[0], "Ctrl+J"),
	};
	const editor = deps.editor ?? factories.createEditor(deps.tui, editorChrome);
	composerEditor = editor;
	// The setting the operator chose, not the rail's reading of it: a capability probe landing after launch moved the
	// label and announced `Think Off` as if someone had changed it (F5).
	const readSettingState = () => ({
		thinking: deps.getSettings?.()?.chat?.thinkingLevel ?? "off",
		output: editorChrome.getOutputStyle?.() ?? "standard",
		autonomy: editorChrome.getAutonomy?.() ?? "default",
	});
	let lastSettingState = readSettingState();
	const announceSettingChanges = (): void => {
		const next = readSettingState();
		const previous = lastSettingState;
		lastSettingState = next;
		const changes: string[] = [];
		if (next.thinking !== previous.thinking) changes.push(`Thinking set to ${next.thinking}`);
		if (next.output !== previous.output)
			changes.push(
				`Transcript detail set to ${{ compact: "minimal", standard: "default", detailed: "detailed" }[next.output]}`,
			);
		if (next.autonomy !== previous.autonomy)
			changes.push(`Autonomy set to ${next.autonomy === "yolo" ? "YOLO" : next.autonomy}`);
		if (changes.length)
			notifications.add({
				level: "info",
				text: changes.join(" · "),
				key: "settings:feedback",
				presentation: "setting",
				ttlMs: 3_000,
			});
	};
	editor.focused = true;
	let skillCompletions: { cwd: string; at: number; items: CompletionValue[] } | undefined;
	const autocomplete: AutocompleteProvider = factories.createAutocomplete({
		isTurnInFlight: () => deps.chat.isStreaming(),
		// Completion runs per keystroke and only names templates, so it reads the
		// committed plugin snapshot; submitting one verifies its tree first.
		promptTemplates: () => deps.resources?.promptsForDisplay(getCwd()).items ?? [],
		...(deps.extensionCommands ? { extensionCommands: deps.extensionCommands } : {}),
		completionSources: {
			agents: async () =>
				(deps.agents?.listSpecs() ?? []).filter(isUserVisibleAgent).map((agent) => ({
					id: agent.id,
					value: agent.id,
					label: agent.id,
					description: agent.description,
				})),
			targets: async () =>
				deps.providers.list().map(({ target, reason }) => ({
					id: target.id,
					value: target.id,
					label: target.id,
					description: reason,
				})),
			models: async () =>
				deps.providers.list().flatMap(({ target, discoveredModels, discoveredModelLabels }) =>
					[
						...new Set([
							...(target.defaultModel ? [target.defaultModel] : []),
							...(target.wireModels ?? []),
							...discoveredModels,
						]),
					].map((model) => ({
						id: `${target.id}/${model}`,
						value: model,
						label: discoveredModelLabels?.[model] ?? model,
						description: target.id,
					})),
				),
			// Runs per keystroke while `/skill <name>` is typed. It only names skills, so
			// it skips the tree digest, and the short memo spares a large catalog a rescan
			// per key. A skill added or reloaded shows within SKILL_COMPLETION_TTL_MS.
			skills: async () => {
				const cwd = getCwd();
				const now = Date.now();
				if (skillCompletions?.cwd === cwd && now - skillCompletions.at < SKILL_COMPLETION_TTL_MS)
					return skillCompletions.items;
				const items = (deps.resources?.skillsForDisplay(cwd).items ?? []).map((skill) => ({
					id: skill.name,
					value: skill.name,
					label: skill.name,
					description: skill.description,
				}));
				skillCompletions = { cwd, at: now, items };
				return items;
			},
			tasks: async ({ subcommand }) =>
				(deps.userTasks?.snapshot() ?? [])
					.filter((task) =>
						subcommand === "hand"
							? task.status === "open"
							: task.status === "open" || task.status === "handed" || task.status === "picked",
					)
					.map((task) => ({
						id: task.id,
						value: task.id,
						label: task.title,
						description: task.status,
					})),
			// Other slots remain empty when this presentation has no read-only catalog for them.
		},
	});
	editor.setAutocompleteProvider(autocomplete);

	const dispatchBoard = factories.createDispatchBoardView(
		() => dispatchBoardStore.rows(),
		() => telemetrySnapshot,
	);
	const chatRenderer = factories.createChatRenderer({
		chatPanel,
		requestRender,
		...(deps.resolveStreamIngress && deps.getSettings
			? {
					streamIngress: deps.resolveStreamIngress,
					getSmoothStreamingMode: () => {
						const current = deps.getSettings?.();
						const mode = current?.interface.demo === false ? "off" : (current?.interface.smoothStreaming ?? "off");
						const autoAllowed = processAutoPacingAllowed(deps.hasObservedBackpressure?.() ?? false);
						deps.onSmoothStreamingMode?.(mode, mode === "on" || (mode === "auto" && autoAllowed));
						return mode;
					},
					isAutoPacingAllowed: () => processAutoPacingAllowed(deps.hasObservedBackpressure?.() ?? false),
					...(deps.commitFrame ? { commitFrame: deps.commitFrame } : {}),
				}
			: {}),
		...(renderTrace
			? {
					visibleEventSequence: (event) => deps.resolveVisibleEventSequence?.(event) ?? null,
					onQueue: (eventSeq, action) => renderTrace.recordQueue(eventSeq, action),
					onPanelApplied: (eventSeq) => renderTrace.recordPanelApplied(eventSeq),
				}
			: {}),
	});
	const io = factories.createIo({
		appendReplayBlock: (renderBlock) =>
			chatRenderer.mutate(() => chatPanel.appendReplayBlock(renderBlock), "command-output"),
		requestRender: () => {},
	});
	const pending: Component = deps.bootPending
		? {
				render: (width) => [...(deps.bootPending?.render(width) ?? []), ...followUpQueuePanel.render(width)],
				invalidate: () => {
					deps.bootPending?.invalidate();
					followUpQueuePanel.invalidate();
				},
			}
		: followUpQueuePanel;
	let transcriptView: ScrollView | undefined;
	const root = factories.buildLayout(
		{
			banner: deps.workspaceSurfaces ? deps.workspaceSurfaces.banner(banner) : banner,
			chat: chatPanel,
			...(deps.workspaceSurfaces ? { workspace: deps.workspaceSurfaces.board } : {}),
			pending,
			fleet: createFleetDock({
				getRows: () => dispatchBoardStore.liveRows?.() ?? dispatchBoardStore.activeRows(),
				getQuotaSnapshots: () => {
					quotaSummary.peekSnapshots();
					return deps.telemetry.read?.quota().providers ?? [];
				},
				...(deps.getTaskBoard ? { getTaskBoard: deps.getTaskBoard } : {}),
				isFooterExpanded: () => footer.isExpanded(),
				isFleetBoardOpen: () => deps.getOverlayState?.() === "dispatch-board",
				getTerminalRows: () => deps.terminal.rows ?? process.stdout.rows ?? 40,
			}),
			editor,
			contextProgress: createContextProgressRail(
				() => contextActivityStore.current(),
				(activity) =>
					admissionHint(activity, {
						streaming: deps.chat.isStreaming(),
						preparation: deps.chat.turnPreparation().phase,
					}),
			),
			footer: footer.view,
		},
		{
			mode: settings.interface?.mode ?? "regular",
			fullscreenScrollbar: settings.interface?.fullscreenScrollbar ?? "auto",
			onTranscript: (view) => {
				transcriptView = view;
			},
		},
	);
	deps.mount?.(root, editor);

	const scheduleInterval = deps.scheduleInterval ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
	const clearScheduledInterval =
		deps.clearScheduledInterval ??
		((handle: PresentationTickerHandle): void => clearInterval(handle as ReturnType<typeof setInterval>));
	// Counters need only second resolution. The composer rail's spinner steps faster while the model, a tool or the
	// harness is working; a wait on the operator holds a still mark, so it needs no frames at all.
	const awaitingOperator = (): boolean =>
		deps.isAwaitingApproval?.() === true || dockTop(deps.tui)?.frame.dockAwaitingInput?.() === true;
	const workIsMoving = (): boolean => {
		if (awaitingOperator()) return false;
		if (deps.chat.isStreaming() || deps.chat.turnPreparation().phase !== "idle" || localBashStartedAt !== null)
			return true;
		const phase = statusController.current().phase;
		return phase !== "idle" && phase !== "ended" && phase !== "tool_blocked";
	};
	const presentationInterval = (): number =>
		deps.getSettings?.().interface.demo !== false && motionEnabled() && workIsMoving() ? ACTIVITY_STEP_MS : 1_000;
	let tickerInterval = presentationInterval();
	// A minute of silence on a model call earns a transcript row that outlives the rail's escalation (F8).
	const silenceRow = createSilenceTranscriptRow({
		append: (render, isLive) => chatPanel.appendReplayBlock((width) => render(width), isLive),
		modelName: (status) => modelNickname(status.modelRequest?.modelId ?? deps.getSettings?.().chat?.model),
	});
	let lastActivitySecond = -1;
	let tickersStopped = false;
	const tickPresentation = (): void => {
		if (tickersStopped) return;
		const nextInterval = presentationInterval();
		if (nextInterval !== tickerInterval) {
			clearScheduledInterval(footerTicker);
			tickerInterval = nextInterval;
			footerTicker = scheduleInterval(tickPresentation, tickerInterval);
			footerTicker.unref?.();
		}
		let needsRender = tickerInterval === ACTIVITY_STEP_MS;
		const second = Math.floor(performance.now() / 1_000);
		if (second !== lastActivitySecond) {
			lastActivitySecond = second;
			silenceRow.observe(statusController.current(), Date.now());
			const statusActive =
				!["idle", "ended"].includes(statusController.current().phase) ||
				localBashStartedAt !== null ||
				backgroundCalls.active().length > 0 ||
				dispatchBoardStore.rows().some((row) => row.status === "running");
			if (deps.chat.isStreaming() || statusActive || loopSnapshot.some((job) => job.nextDueAt !== null)) {
				footer.refresh();
				needsRender = true;
			}
		}
		if (needsRender) requestRender();
	};
	let footerTicker = scheduleInterval(tickPresentation, tickerInterval);
	footerTicker.unref?.();
	const workspaceTicker = scheduleInterval(() => {
		refreshLiveWorkspaceGit(true);
		footer.refresh();
		requestRender();
	}, 5_000);
	workspaceTicker.unref?.();

	let beforeStatusDisposed = false;
	let statusDisposed = false;
	const stopTickers = (): void => {
		if (tickersStopped) return;
		tickersStopped = true;
		clearScheduledInterval(footerTicker);
		clearScheduledInterval(workspaceTicker);
	};
	const disposeBeforeStatus = (): void => {
		if (beforeStatusDisposed) return;
		beforeStatusDisposed = true;
		// Before the subscriptions go: a project-context refresh already in flight
		// must not land afterwards and ask a torn-down presentation for a frame.
		quotaSummary.dispose();
		banner.dispose();
		footer.dispose();
		unsubscribeProjection();
		for (const off of unsubscribeTelemetry) off();
		if (dropCheck) clearTimeout(dropCheck);
		contextActivityStore.unsubscribe();
		unsubscribeLoops?.();
		backgroundCalls.dispose();
		dispatchBoardStore.unsubscribe();
		unbindRunReaders();
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
		editorChrome,
		dispatchBoard,
		chatRenderer,
		io,
		root,
		setLocalBashRunning(running, command, settled) {
			lastShell = running ? null : (settled ?? null);
			localBashStartedAt = running ? Date.now() : null;
			localBashCommand = running ? (command ?? null) : null;
			localBashCancelledAt = null;
			footer.refresh();
			requestRender();
		},
		setLocalBashCancelling() {
			if (localBashStartedAt === null) return;
			localBashCancelledAt = Date.now();
			footer.refresh();
			requestRender();
		},
		changeOutputStyle: (mutation) =>
			chatRenderer.mutate(() => preserveTranscriptScroll(transcriptView, deps.terminal.columns, mutation), "output-style"),
		announceSettingChanges,
		getQuotaSnapshots: () => {
			quotaSummary.peekSnapshots();
			return deps.telemetry.read?.quota().providers ?? [];
		},
		recordChatEvent,
		recordToolStart: (toolCallId, toolName) => {
			footerActiveTools.add(toolCallId);
			footerToolCounts.set(toolName, (footerToolCounts.get(toolName) ?? 0) + 1);
		},
		recordToolEnd: ({ toolCallId, isError, truncated }) => {
			if (!footerActiveTools.delete(toolCallId)) return;
			if (isError) footerToolErrors += 1;
			if (truncated) footerToolTruncatedResults += 1;
		},
		toolCounts: () => footerToolCounts,
		setLastTurnSummary: (summary) => {
			lastTurnSummary = summary;
			lastShell = null;
		},
		resetForNewSession: () => {
			resetLoopJobs();
			banner.resetToLaunchpad();
			footerToolCounts.clear();
			footerActiveTools.clear();
			footerToolErrors = 0;
			footerToolTruncatedResults = 0;
			lastTurnSummary = null;
			lastShell = null;
			liveGeneration = false;
			statusController.reset();
			// A timed notice spoke about a moment in the session that just ended; a pinned one states a condition still true.
			for (const notice of notifications.list()) if (notice.expiresAt !== null) notifications.dismiss(notice.id);
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
