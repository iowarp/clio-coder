import type { PermissionRequestedPayload } from "../core/bus-events.js";
import type { ClioSettings } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { expandInlineFileReferencesAsync } from "../core/file-references.js";
import type { PendingSkillRequest } from "../core/skill-activation.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import type { ClioKeybinding } from "../domains/config/keybindings.js";
import type { ContextState } from "../domains/context/index.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { ExtensionsContract } from "../domains/extensions/index.js";
import type { TaskMemoryOperatorStatus } from "../domains/memory/index.js";
import type { ObservabilityContract } from "../domains/observability/index.js";
import type { ProvidersContract, ThinkingLevel } from "../domains/providers/index.js";
import type { ResourcesContract } from "../domains/resources/index.js";
import type { FleetNodeSnapshot } from "../domains/scheduling/cluster.js";
import type { SessionContract, SessionEntry, TaskBoardSnapshot } from "../domains/session/index.js";
import type { ShareContract } from "../domains/share/index.js";
import { createAgentProgress } from "../engine/tui.js";
import type { ImageContent } from "../engine/types.js";
import type { AskUserHandler } from "../tools/ask-user.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ApplicationController } from "./application-controller.js";
import type { ChatLoop } from "./chat-loop.js";
import { emitCommandNotice } from "./command-fallbacks.js";
import { appendNotice } from "./command-output.js";
import { createDispatchSteering } from "./dispatch-steering.js";
import { createEditorSubmitController } from "./editor-submit.js";
import { createInteractiveEventProjection } from "./interactive-event-projection.js";
import { createInteractiveInputRuntime } from "./interactive-input-runtime.js";
import { createInteractivePresentation } from "./interactive-presentation.js";
import { createProcessInteractiveShell } from "./interactive-shell.js";
import { createInteractiveSlashRuntime } from "./interactive-slash-runtime.js";
import { createInteractiveSubscriptions } from "./interactive-subscriptions.js";
import { createInteractiveTickers } from "./interactive-tickers.js";
import { createOverlayLifecycle, type OverlayLifecycleController, type OverlayState } from "./overlay-lifecycle.js";
import { resolveAvailableThinkingLevels } from "./overlays/thinking-selector.js";
import { createSessionTranscript } from "./session-transcript.js";
import type {
	ContextClearCommandOptions,
	InitCommandOptions,
	RunIo,
	TaskMemorySeedCommandResult,
} from "./slash-commands.js";
import { createWorkspaceFacts } from "./workspace-facts.js";

export {
	IDLE_LEADER_STATE,
	LEADER_TIMEOUT_MS,
	type LeaderKeyController,
	type LeaderKeyControllerDeps,
	type LeaderKeyRouteDeps,
	type LeaderKeyRouteResult,
	type LeaderKeyState,
	type LeaderTarget,
	routeLeaderKey,
} from "./leader-key.js";
export * from "./overlay-lifecycle.js";
// Re-exports preserve the public surface for diag scripts that import these
// names from "interactive/index.js"; the implementations live in
// slash-commands.ts.
export {
	BUILTIN_SLASH_COMMANDS,
	type BuiltinSlashCommand,
	type ContextClearCommandOptions,
	dispatchSlashCommand,
	type HandleRunDeps,
	handleRun,
	type InitCommandOptions,
	parseSlashCommand,
	type RunIo,
	type SlashCommand,
	type SlashCommandContext,
	type SlashCommandKind,
} from "./slash-commands.js";

export function shouldAnnouncePermissionRequest(
	seenRequestIds: Set<string>,
	requestId: string,
	maxSize = 2048,
): boolean {
	if (seenRequestIds.has(requestId)) return false;
	seenRequestIds.add(requestId);
	if (seenRequestIds.size > maxSize) {
		const oldest = seenRequestIds.values().next().value;
		if (oldest !== undefined) seenRequestIds.delete(oldest);
	}
	return true;
}

export function isLiveWorkerEscalationRequest(payload: PermissionRequestedPayload): boolean {
	if (typeof payload.requestId !== "string") return false;
	if (payload.escalation !== true) return false;
	const origin = typeof payload.origin === "string" ? payload.origin : undefined;
	const legacyWorkerEvent = origin === undefined && typeof payload.requestedBy === "string";
	if (!(origin?.startsWith("worker:") || legacyWorkerEvent)) return false;
	const runId = typeof payload.requestedBy === "string" ? payload.requestedBy : origin?.slice("worker:".length);
	return typeof runId === "string" && runId.length > 0;
}

export interface InteractiveDeps {
	bus: SafeEventBus;
	providers: ProvidersContract;
	dispatch: DispatchContract;
	agents?: AgentsContract;
	observability: ObservabilityContract;
	chat: ChatLoop;
	/** Startup notices collected before the TUI is ready; rendered in the transcript. */
	initialNotices?: ReadonlyArray<string>;
	resources?: ResourcesContract;
	extensions?: ExtensionsContract;
	share?: ShareContract;
	/**
	 * Shared tool registry. When wired, the permission overlay opens automatically
	 * whenever a tool call is parked waiting for operator confirmation, and the
	 * confirm / cancel overlay handlers drive `resumeParkedCalls` /
	 * `cancelParkedCall` so blocked bash batches run (or reject cleanly)
	 * after the permission decision rather than stalling indefinitely.
	 */
	toolRegistry?: ToolRegistry;
	session?: SessionContract;
	/** Read current session entries for replay/context rebuilds after local non-chat entries. */
	readSessionEntries?: () => ReadonlyArray<SessionEntry>;
	/** Live session task board for the footer tasks row and the /tasks overlay. */
	getTaskBoard?: () => TaskBoardSnapshot | null;
	/** Live, read-only task-memory state for status surfaces and the /memory overlay. */
	getTaskMemoryStatus?: () => TaskMemoryOperatorStatus;
	/** Newest structured handoff available for an opt-in seed, when enabled. */
	getTaskMemorySeedOffer?: () => { source: string; count: number } | null;
	/** Merge the newest structured handoff into the current task bank. */
	seedTaskMemory?: () => TaskMemorySeedCommandResult;
	/** XDG state dir (clioStateDir()). `/view verify` reads from <stateDir>/receipts/<id>.json. */
	stateDir: string;
	/** XDG data dir (clioDataDir()). `/view` reads durable evidence bundles from <dataDir>/evidence/. */
	dataDir: string;
	/** XDG cache dir (clioCacheDir()). The Skills Hub marketplace cache lives here. */
	cacheDir: string;
	/**
	 * Resolver for current settings. Footer reads the orchestrator target
	 * (what chat actually dispatches to) rather than the providers catalog's
	 * first-available entry.
	 */
	getSettings?: () => Readonly<ClioSettings>;
	/** Live fleet node snapshots for the /fleet nodes view and node-pin editor. */
	getFleetNodes?: () => ReadonlyArray<FleetNodeSnapshot>;
	/** Optional resolver for the active session id used as the cost overlay title suffix. */
	getSessionId?: () => string | null;
	/** Install the TUI-backed ask_user handler for this interactive process. */
	registerAskUserHandler?: (handler: AskUserHandler) => () => void;
	/** Live CLIO.md and memory state for the footer Context quadrant. */
	getContextState?: (cwd?: string) => ContextState;
	/** Persist a thinking level chosen in the /thinking overlay. */
	onSetThinkingLevel?: (level: ThinkingLevel) => void;
	/** Persist the next thinking level when Shift+Tab is pressed. */
	onCycleThinking?: () => void;
	/** Persist the orchestrator target selected in /model. */
	onSelectModel?: (ref: { target: string; model: string }) => void;
	/** Persist the next `provider.scope` list committed in /scoped-models. */
	onSetScope?: (scope: string[]) => void;
	/** Write handler the /settings overlay uses to persist cycled values. */
	writeSettings?: (next: ClioSettings) => void;
	/**
	 * Scoped commit for a single /settings edit. `id` is the config-path id, `next`
	 * the effective view with that one leaf changed. scope "session" applies live
	 * only; "global" also persists it as the default. Absent ⇒ the overlay falls
	 * back to writeSettings (global-only).
	 */
	commitSetting?: (id: string, next: ClioSettings, scope: "session" | "global") => void;
	/** Resume a past session id. Called from the /resume overlay. */
	onResumeSession?: (sessionId: string) => void;
	/** Start a fresh session. Called from /new. */
	onNewSession?: () => void;
	/**
	 * Fork from a parent assistant turn picked in /fork. Default wiring
	 * delegates to session.fork(parentTurnId); the override exists so
	 * future slices can layer telemetry or settings merging on top.
	 */
	onForkSession?: (parentTurnId: string) => void;
	/**
	 * Run /compact for the current session. Resolves the compaction model
	 * (settings.compaction.model with fallback to the orchestrator target),
	 * reads session entries, streams a summary via the session compaction
	 * engine, and persists a compactionSummary entry.
	 */
	onCompact?: (instructions: string | undefined) => Promise<void>;
	/** Run /context init for the current working directory. */
	onInit?: (options: InitCommandOptions, io?: RunIo) => Promise<void>;
	/** Run /context reset for the current working directory. */
	onContextClear?: (options: ContextClearCommandOptions) => Promise<void>;
	/** Run /context refresh: re-index codewiki and refresh .clio state without touching CLIO.md. */
	onContextRefresh?: () => Promise<void>;
	/** Advance the orchestrator target one step forward through `provider.scope`. */
	onCycleScopedModelForward?: () => void;
	/** Advance the orchestrator target one step backward through `provider.scope`. */
	onCycleScopedModelBackward?: () => void;
	onShutdown: () => Promise<void>;
}

export const CTRL_C_DOUBLE_TAP_MS = 500;
export const ENTER = "\r";
export const ESC = "\x1b";

export interface InteractiveSubmitExpansion {
	text: string;
	images: ImageContent[];
	workingContextPaths: string[];
	pendingSkillRequests: PendingSkillRequest[];
}

export async function expandInteractiveSubmitAsync(
	text: string,
	resources: ResourcesContract | undefined,
	cwd = process.cwd(),
): Promise<InteractiveSubmitExpansion> {
	const parsed = resources?.parsePendingSkillRequests(text, cwd) ?? {
		text,
		pendingSkillRequests: [],
	};
	const promptExpansion = resources?.expandPromptTemplate(parsed.text, cwd);
	const promptText = promptExpansion?.expanded ? promptExpansion.text : parsed.text;
	const fileExpansion = await expandInlineFileReferencesAsync(promptText, {
		cwd,
		includeImages: true,
		missing: "leave",
	});
	return {
		text: fileExpansion.text,
		images: fileExpansion.images,
		workingContextPaths: fileExpansion.referencedPaths,
		pendingSkillRequests: parsed.pendingSkillRequests,
	};
}

function availableInteractiveThinkingLevels(deps: InteractiveDeps): ReadonlyArray<ThinkingLevel> {
	const settings = deps.getSettings?.();
	return settings ? resolveAvailableThinkingLevels(deps.providers, settings) : ["off"];
}

export interface KeyBindingDeps {
	/**
	 * Keybinding lookup injected by startInteractive. Defaults come from
	 * CLIO_KEYBINDINGS; user overrides from settings.keybindings. Tests may
	 * substitute a narrower matcher via createKeybindingManagerForTesting.
	 */
	matches: (data: string, id: ClioKeybinding) => boolean;
	/** App exit follows pi's editor rule: Ctrl+D exits only when the editor is empty. */
	canExit?: () => boolean;
	cycleThinking: () => void;
	requestShutdown: () => void;
	toggleStatus: () => void;
	toggleDispatchBoard: () => void;
	openModelSelector: () => void;
	openTree: () => void;
	cycleScopedModelForward: () => void;
	cycleScopedModelBackward: () => void;
	dismissNotifications: () => void;
	toggleToolExpansion: () => void;
	toggleAllToolExpansion: () => void;
	toggleLiveToolOutput: () => void;
	toggleThinkingExpansion: () => void;
	toggleAllThinkingExpansion: () => void;
	openExternalEditor: () => void;
	queueFollowUp: () => void;
	restoreQueuedFollowUps: () => void;
}

export type CtrlCAction = "cancel-stream" | "close-overlay" | "clear-editor" | "arm-shutdown" | "shutdown";

export interface CtrlCActionDeps {
	overlayState: OverlayState;
	streaming: boolean;
	editorText: string;
	lastCtrlCAt: number;
	now: number;
}

export function resolveCtrlCAction(deps: CtrlCActionDeps): CtrlCAction {
	// A modal is an input boundary. Never let a global double-tap or an active
	// run escape through it; Ctrl+C cancels/closes the focused overlay instead.
	if (deps.overlayState !== "closed") return "close-overlay";
	if (deps.lastCtrlCAt > 0 && deps.now - deps.lastCtrlCAt <= CTRL_C_DOUBLE_TAP_MS) {
		return "shutdown";
	}
	if (deps.streaming) return "cancel-stream";
	if (deps.editorText.length > 0) return "clear-editor";
	return "arm-shutdown";
}

export function dispatchInteractiveAction(id: ClioKeybinding, deps: KeyBindingDeps): boolean {
	switch (id) {
		case "clio.notifications.dismiss":
			deps.dismissNotifications();
			return true;
		case "clio.tool.expand":
			deps.toggleToolExpansion();
			return true;
		case "clio.tool.expandAll":
			deps.toggleAllToolExpansion();
			return true;
		case "clio.tool.liveOutput":
			deps.toggleLiveToolOutput();
			return true;
		case "clio.editor.external":
			deps.openExternalEditor();
			return true;
		case "clio.message.followUp":
			deps.queueFollowUp();
			return true;
		case "clio.message.dequeue":
			deps.restoreQueuedFollowUps();
			return true;
		case "clio.thinking.expand":
			deps.toggleThinkingExpansion();
			return true;
		case "clio.thinking.expandAll":
			deps.toggleAllThinkingExpansion();
			return true;
		case "clio.status.toggle":
			deps.toggleStatus();
			return true;
		case "clio.thinking.cycle":
			deps.cycleThinking();
			return true;
		case "clio.session.tree":
			deps.openTree();
			return true;
		case "clio.dispatchBoard.toggle":
			deps.toggleDispatchBoard();
			return true;
		case "clio.model.select":
			deps.openModelSelector();
			return true;
		case "clio.model.cycleBackward":
			deps.cycleScopedModelBackward();
			return true;
		case "clio.model.cycleForward":
			deps.cycleScopedModelForward();
			return true;
		case "clio.exit":
			if (deps.canExit && !deps.canExit()) return false;
			deps.requestShutdown();
			return true;
		case "clio.leader":
			return false;
	}
}

/** Pure key router: returns true when the input was consumed. */
export function routeInteractiveKey(data: string, deps: KeyBindingDeps): boolean {
	const order: ClioKeybinding[] = [
		"clio.status.toggle",
		"clio.thinking.cycle",
		"clio.session.tree",
		"clio.dispatchBoard.toggle",
		"clio.model.select",
		// Match cycleBackward before cycleForward so a user rebind where one key
		// is a prefix of the other resolves to the more specific binding first.
		// The defaults (alt+k / alt+j) do not prefix-match each other.
		"clio.model.cycleBackward",
		"clio.model.cycleForward",
		"clio.exit",
	];
	for (const id of order) {
		if (deps.matches(data, id)) return dispatchInteractiveAction(id, deps);
	}
	return false;
}

export async function createInteractiveApplication(deps: InteractiveDeps): Promise<number> {
	const shell = createProcessInteractiveShell();
	const { terminal, tui } = shell;
	let applicationController: ApplicationController;
	const workspaceFacts = createWorkspaceFacts({
		cwd: process.cwd(),
		getSessionWorkspace: () => deps.session?.current()?.workspace ?? null,
		...(deps.extensions ? { extensions: deps.extensions } : {}),
	});
	const { refreshLiveWorkspaceGit } = workspaceFacts;
	let refreshPresentationFooter = (): void => {};
	const sessionTranscript = createSessionTranscript({
		...(deps.session ? { session: deps.session } : {}),
		...(deps.getSessionId ? { getSessionId: deps.getSessionId } : {}),
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		...(deps.readSessionEntries ? { readSessionEntries: deps.readSessionEntries } : {}),
		chat: deps.chat,
		refreshStatus: () => refreshPresentationFooter(),
	});
	const { readStructuredEntries, recordSubmittedTurn } = sessionTranscript;
	const presentation = createInteractivePresentation({
		bus: deps.bus,
		providers: deps.providers,
		dispatch: deps.dispatch,
		observability: deps.observability,
		chat: deps.chat,
		workspaceFacts,
		sessionTranscript,
		tui,
		terminal,
		mount: (root, editor) => shell.mount(root, editor),
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		...(deps.resources ? { resources: deps.resources } : {}),
		...(deps.session ? { session: deps.session } : {}),
		...(deps.getSessionId ? { getSessionId: deps.getSessionId } : {}),
		...(deps.getTaskBoard ? { getTaskBoard: deps.getTaskBoard } : {}),
		...(deps.getTaskMemoryStatus ? { getTaskMemoryStatus: deps.getTaskMemoryStatus } : {}),
		...(deps.getTaskMemorySeedOffer ? { getTaskMemorySeedOffer: deps.getTaskMemorySeedOffer } : {}),
		...(deps.getContextState ? { getContextState: deps.getContextState } : {}),
	});
	const {
		keybindings,
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
		editor,
		dispatchBoard,
		chatRenderer,
		io,
	} = presentation;
	refreshPresentationFooter = () => footer.refresh();
	const agentProgress = createAgentProgress(terminal);
	const busNoticeSink = {
		appendReplayBlock: (renderBlock: Parameters<typeof chatPanel.appendReplayBlock>[0]) =>
			chatPanel.appendReplayBlock(renderBlock),
		requestRender: () => tui.requestRender(),
	};
	const eventProjection = createInteractiveEventProjection({
		bus: deps.bus,
		chat: deps.chat,
		status: statusController,
		...(deps.initialNotices ? { initialNotices: deps.initialNotices } : {}),
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		getTerminalColumns: () => terminal.columns,
		applyChatEvent: (event) => chatRenderer.applyEvent(event),
		setFollowUpMessages: (messages) => followUpQueuePanel.setMessages(messages),
		isAskUserWaiting: () => overlayLifecycle.isAskUserWaiting(),
		closeAskUserSession: () => overlayLifecycle.closeAskUserSession(),
		resetAskUserCancellation: () => overlayLifecycle.resetAskUserCancellation(),
		recordToolStart: (toolName, toolCallId) => presentation.recordToolStart(toolCallId, toolName),
		recordToolEnd: (_toolName, toolCallId, isError, truncated) =>
			presentation.recordToolEnd({ toolCallId, isError, truncated }),
		setStatusLine: (line) => chatPanel.setStatusLine(line),
		setLastTurnSummary: (summary) => presentation.setLastTurnSummary(summary),
		startTerminalProgress: () => agentProgress.start(),
		stopTerminalProgress: () => agentProgress.stop(),
		refreshLiveWorkspaceGit,
		refreshFooter: () => footer.refresh(),
		requestRender: () => tui.requestRender(),
		notify,
		dismissNotification: (key) => notifications.dismiss(key),
		appendTranscriptNotice: (level, text) => appendNotice(level, text, busNoticeSink),
		refreshSettingsOverlay: () => overlayLifecycle.refreshSettingsOverlay(),
	});
	const slashRuntime = createInteractiveSlashRuntime({
		io,
		bus: deps.bus,
		dispatch: deps.dispatch,
		providers: deps.providers,
		chat: deps.chat,
		chatPanel,
		...(deps.resources ? { resources: deps.resources } : {}),
		...(deps.extensions ? { extensions: deps.extensions } : {}),
		...(deps.agents ? { agents: deps.agents } : {}),
		...(deps.share ? { share: deps.share } : {}),
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		...(deps.writeSettings ? { writeSettings: deps.writeSettings } : {}),
		...(deps.onSelectModel ? { onSelectModel: deps.onSelectModel } : {}),
		...(deps.onSetThinkingLevel ? { onSetThinkingLevel: deps.onSetThinkingLevel } : {}),
		...(deps.onCompact ? { onCompact: deps.onCompact } : {}),
		...(deps.onInit ? { onInit: deps.onInit } : {}),
		...(deps.onContextClear ? { onContextClear: deps.onContextClear } : {}),
		...(deps.onContextRefresh ? { onContextRefresh: deps.onContextRefresh } : {}),
		stateDir: deps.stateDir,
		shutdown: () => applicationController.shutdown(),
		requestRender: () => tui.requestRender(),
		refreshFooter: () => footer.refresh(),
		dismissContextBootstrapNotices,
		recordSubmittedTurn,
		readStructuredEntries,
		expandSubmit: (text) => expandInteractiveSubmitAsync(text, deps.resources),
		openAskUser: (questions, options) => openAskUserOverlayState(questions, options),
		openSkillsHub: () => openSkillsHubState(),
		openProviders: () => openProvidersOverlayState(),
		openCost: () => openCostOverlayState(),
		openContextView: () => openContextViewOverlayState(),
		openFleet: () => openFleetOverlayState(),
		openTasks: () => openTasksOverlayState(),
		openMemory: () => openMemoryOverlayState(),
		...(deps.seedTaskMemory ? { seedTaskMemory: deps.seedTaskMemory } : {}),
		openView: (filter) => openViewOverlayState(filter),
		openThinking: () => openThinkingOverlayState(),
		openModel: () => openModelOverlayState(),
		openScopedModels: () => openScopedModelsOverlayState(),
		openSettings: () => openSettingsOverlayState(),
		openResume: () => openResumeOverlayState(),
		startNewSession: () => startNewSession(),
		openTree: () => openTreeOverlayState(),
		openMessagePicker: () => openMessagePickerOverlayState(),
		openHelp: (query) => openHelpOverlayState(query),
		openAgents: () => openAgentsOverlayState(),
		openPrompts: () => openPromptsOverlayState(),
		openExtensions: () => openExtensionsOverlayState(),
		openContextReset: () => openContextResetOverlayState(),
		setEditorText: (text) => editor.setText(text),
	});

	const editorSubmit = createEditorSubmitController({
		editor,
		ui: tui,
		io,
		chat: deps.chat,
		dispatch: deps.dispatch,
		...(deps.session ? { session: deps.session } : {}),
		sessionTranscript,
		chatPanel,
		dispatchCommand: slashRuntime.dispatchCommand,
		expandSubmit: (text) => expandInteractiveSubmitAsync(text, deps.resources),
		notify,
	});
	editor.onSubmit = editorSubmit.submitEditorText;

	let overlayLifecycle: OverlayLifecycleController;
	const interactiveTickers = createInteractiveTickers({
		tui,
		dispatchBoardStore,
		contextActivityStore,
		getOverlayState: () => overlayLifecycle?.getState() ?? "closed",
		isFooterExpanded: () => footer.isExpanded(),
	});
	overlayLifecycle = createOverlayLifecycle({
		app: deps,
		tui,
		footer,
		interactiveTickers,
		busNoticeSink,
		chatRenderer,
		notify,
		terminal,
		dispatchBoard,
		getObservabilitySnapshot: presentation.getObservabilitySnapshot,
		chatPanel,
		io,
		readStructuredEntries,
		announceTaskMemorySeedOffer,
		keybindings,
		editor,
		getSlashContext: () => slashRuntime.context,
	});
	const {
		closeOverlay,
		openAskUserOverlayState,
		openProvidersOverlayState,
		openCostOverlayState,
		openContextViewOverlayState,
		openContextResetOverlayState,
		openTasksOverlayState,
		openMemoryOverlayState,
		openFleetOverlayState,
		openViewOverlayState,
		openThinkingOverlayState,
		openModelOverlayState,
		openScopedModelsOverlayState,
		openSettingsOverlayState,
		openResumeOverlayState,
		openTreeOverlayState,
		openMessagePickerOverlayState,
		openHelpOverlayState,
		openAgentsOverlayState,
		openSkillsHubState,
		openPromptsOverlayState,
		openExtensionsOverlayState,
	} = overlayLifecycle;

	const dispatchSteering = createDispatchSteering({
		getSelectedRow: () => dispatchBoard.selectedRow(),
		notify,
		abortDispatch: (runId) => deps.dispatch.abort(runId),
		editor,
		closeOverlay,
		requestRender: () => tui.requestRender(),
	});
	const { cancelSelectedDispatch, steerSelectedDispatch } = dispatchSteering;

	const cancelActiveRun = (): void => {
		deps.chat.cancel();
		deps.toolRegistry?.cancelParkedCalls("run cancelled by operator");
		footer.refresh();
		tui.requestRender();
	};

	const startNewSession = (): void => {
		if (!deps.onNewSession) {
			emitCommandNotice(slashRuntime.notice, "error", "new", "session contract unavailable");
			return;
		}
		deps.onNewSession();
		deps.observability.resetSession();
		presentation.resetForNewSession();
		chatPanel.reset();
		deps.chat.resetForSession(null);
		footer.refresh();
		tui.requestRender();
	};
	const interactiveSubscriptions = createInteractiveSubscriptions({
		bus: deps.bus,
		refreshFooter: () => footer.refresh(),
		renderTaskIsland: interactiveTickers.renderTaskIsland,
		renderContextIsland: interactiveTickers.renderContextIsland,
		requestRender: () => tui.requestRender(),
		notify,
	});

	applicationController = createInteractiveInputRuntime({
		keybindings,
		dispatchAction: dispatchInteractiveAction,
		actions: {
			canExit: () => editor.getText().length === 0,
			availableThinkingLevels: () => availableInteractiveThinkingLevels(deps),
			onCycleThinking: () => deps.onCycleThinking?.(),
			cycleScopedModelForward: () => deps.onCycleScopedModelForward?.(),
			cycleScopedModelBackward: () => deps.onCycleScopedModelBackward?.(),
		},
		overlay: overlayLifecycle,
		refreshFooter: () => footer.refresh(),
		dispatchBoard,
		steerSelectedDispatch,
		cancelSelectedDispatch,
		cancelActiveEditorBash: () => editorSubmit.cancelActiveEditorBash(),
		isStreaming: () => deps.chat.isStreaming(),
		cancelActiveRun,
		editor,
		editorSubmit,
		requestRender: () => tui.requestRender(),
		notifications,
		chatPanel,
		shutdown: {
			stopTickers: presentation.stopTickers,
			disposeInteractiveTickers: interactiveTickers.dispose,
			disposeBeforeStatus: presentation.disposeBeforeStatus,
			disposeProjectionPrimary: eventProjection.disposePrimary,
			disposeStatus: presentation.disposeStatus,
			disposeProjectionRemaining: eventProjection.disposeRemaining,
			disposeOverlay: overlayLifecycle.dispose,
			stopAgentProgress: agentProgress.stop,
			disposeChat: () => deps.chat.dispose(),
			disposeSubscriptions: interactiveSubscriptions.dispose,
		},
		stopUi: () => shell.stop(),
		cancelParkedCalls: (reason) => deps.toolRegistry?.cancelParkedCalls(reason),
		onShutdown: deps.onShutdown,
		registerInputListener: (listener) => tui.addInputListener(listener),
	});

	return applicationController.run;
}
