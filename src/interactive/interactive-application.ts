import type { PermissionRequestedPayload } from "../core/bus-events.js";
import type { ClioSettings } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { expandInlineFileReferencesAsync } from "../core/file-references.js";
import type { PendingSkillRequest } from "../core/skill-activation.js";
import { clioStateDir } from "../core/xdg.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import type { ClioKeybinding } from "../domains/config/keybindings.js";
import type { ContextState } from "../domains/context/index.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { ExtensionsContract } from "../domains/extensions/index.js";
import type { InteropContract } from "../domains/interop/index.js";
import type { TaskMemoryOperatorStatus } from "../domains/memory/index.js";
import { openDetachedBatchViews } from "../domains/middleware/index.js";
import type { MuxContract } from "../domains/mux/index.js";
import type { PanesOperations, PanesWatchController } from "../domains/mux/operations.js";
import type { ObservabilityContract } from "../domains/observability/index.js";
import type { ProvidersContract, ThinkingLevel } from "../domains/providers/index.js";
import type { ResourcesContract } from "../domains/resources/index.js";
import type { FleetNodeSnapshot } from "../domains/scheduling/cluster.js";
import type { SchedulingContract } from "../domains/scheduling/contract.js";
import type { DecisionLedgerEntry } from "../domains/session/entries.js";
import type { SessionContract, SessionEntry, TaskBoardSnapshot } from "../domains/session/index.js";
import type { ShareContract } from "../domains/share/index.js";
import type { UserTasksStore } from "../domains/user-tasks/store.js";
import { createAgentProgress } from "../engine/tui.js";
import type { ImageContent } from "../engine/types.js";
import type { AskUserHandler } from "../tools/ask-user.js";
import type { ToolRegistry } from "../tools/registry.js";
import { APPLICATION_DOUBLE_TAP_MS, type ApplicationController } from "./application-controller.js";
import type { ChatLoop, ChatLoopEvent } from "./chat-loop.js";
import { emitCommandNotice } from "./command-fallbacks.js";
import { appendNotice } from "./command-output.js";
import { dispatchCouncilThroughRegistry } from "./council-dispatch.js";
import { createDispatchSteering } from "./dispatch-steering.js";
import { createEditorSubmitController } from "./editor-submit.js";
import { createInteractiveDesktopNotifications } from "./footer/notifications.js";
import { createInteractiveEventProjection } from "./interactive-event-projection.js";
import { createInteractiveInputRuntime } from "./interactive-input-runtime.js";
import { createInteractivePresentation } from "./interactive-presentation.js";
import { createProcessInteractiveShell, getActiveRenderTrace } from "./interactive-shell.js";
import { createInteractiveSlashRuntime, resolveAvailableThinkingLevels } from "./interactive-slash-runtime.js";
import { createInteractiveSubscriptions } from "./interactive-subscriptions.js";
import { createInteractiveTickers } from "./interactive-tickers.js";
import type { createMuxBridge } from "./mux-bridge.js";
import { createOverlayLifecycle, type OverlayLifecycleController, type OverlayState } from "./overlay-lifecycle.js";
import { interopOverlaySurface } from "./overlays/interop.js";
import { paneWatchDecision } from "./pane-policy.js";
import { writeInputWedgeDump } from "./render-trace.js";
import { settleChatBeforeSessionSwitch } from "./session-switch-settlement.js";
import { createSessionTranscript } from "./session-transcript.js";
import type {
	ContextClearCommandOptions,
	InitCommandOptions,
	RunIo,
	SettingsAreaId,
	TaskMemorySeedCommandResult,
} from "./slash-commands.js";
import { processAutoPacingAllowed, resolveSmoothStreamingMode } from "./stream-pacing-policy.js";
import type { TerminalLease } from "./terminal-lease.js";
import type { createWatchPaneController } from "./watch-pane.js";
import { createWorkspaceFacts } from "./workspace-facts.js";
import type { createYaziBridge, YaziBridge } from "./yazi-bridge.js";

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
	/** Session budget state `/fleet run` shows as the ceiling a plan is admitted under. */
	scheduling?: SchedulingContract;
	observability: ObservabilityContract;
	chat: ChatLoop;
	/** Fired once after the first real TUI render transaction issued all of its terminal writes. */
	onFirstFrameCommit?: (frameId: number) => void;
	/** Existing Stage 0 owner to hydrate in place. */
	terminalLease?: TerminalLease;
	/** Fired after the first committed frame containing the hydrated Stage 1 root. */
	onHydratedFrameCommit?: (frameId: number | null) => void;
	/** Startup notices collected before the TUI is ready; rendered in the transcript. */
	initialNotices?: ReadonlyArray<string>;
	resources?: ResourcesContract;
	extensions?: ExtensionsContract;
	interop?: InteropContract;
	share?: ShareContract;
	/**
	 * Pane layer. A `none` contract still reaches the interactive surface so the
	 * files preset can use its terminal chooser; every mux operation remains
	 * best-effort and never reaches a dispatch or a turn.
	 */
	mux?: MuxContract;
	/**
	 * Pane-layer operations behind `/panes` and the `panes` tool. Built by the
	 * composition root so the tool registry and this surface drive one instance.
	 */
	panes?: PanesOperations;
	/**
	 * Factory seam for the dispatch-to-pane bridge, so a contract test can drive
	 * it without a TUI. Production leaves it unset and gets `createMuxBridge`.
	 */
	createMuxBridge?: typeof createMuxBridge;
	/** Bind the file-pane return path after the composer and TUI exist. */
	attachYaziBridge?: (bridge: YaziBridge) => () => void;
	/**
	 * Watch-pane factory from the `--with-panes` composition root; absent on a
	 * plain boot. The controller it builds backs Enter in the workers view.
	 */
	createWatchPane?: typeof createWatchPaneController;
	/** Bind the watch controller into the shared PanesOperations for `/panes show`. */
	attachWatchPane?: (controller: PanesWatchController) => () => void;
	/**
	 * File-pane factory. Supplied by the `--with-panes` composition root (or a
	 * contract test); absent on a plain boot, which therefore loads no yazi code.
	 */
	createYaziBridge?: typeof createYaziBridge;
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
	/** Settled interview snapshots folded from the active session branch. */
	getDecisionBoard?: () => ReadonlyArray<DecisionLedgerEntry>;
	/** Append an acknowledged operator-authored decision revision. */
	supersedeDecision?: (interviewId: string, key: string, correction?: string) => unknown;
	/** Project-scoped operator task inbox used by `/tasks` subcommands. */
	userTasks?: UserTasksStore;
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
	/** Live CLIO-CODER.md and memory state for the footer Context quadrant. */
	getContextState?: (cwd?: string) => ContextState;
	/**
	 * Persist a thinking level set by `/thinking <level>` or `/model <pattern>:<level>`.
	 * Scope "session" leaves settings.yaml alone; omitted means the historical
	 * write-through, which is what the Shift+Tab cycle and `/thinking` still want.
	 */
	onSetThinkingLevel?: (level: ThinkingLevel, scope?: "session" | "global") => void;
	/** Persist the next thinking level when Shift+Tab is pressed. */
	onCycleThinking?: () => void;
	/**
	 * Apply the orchestrator target selected in /model at the scope the operator
	 * chose. "session" routes this session only and never touches settings.yaml.
	 */
	onSelectModel?: (ref: { target: string; model: string }, scope: "session" | "global") => void;
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
	 * Run `/context compact` for the current session. Resolves the compaction model
	 * (settings.context.compaction.model with fallback to the chat target),
	 * reads session entries, streams a summary via the session compaction
	 * engine, and persists a compactionSummary entry.
	 */
	onCompact?: (instructions: string | undefined) => Promise<void>;
	/** Run /context init for the current working directory. */
	onInit?: (options: InitCommandOptions, io?: RunIo) => Promise<void>;
	/** Run /context reset for the current working directory. */
	onContextClear?: (options: ContextClearCommandOptions) => Promise<void>;
	/** Run /context refresh: re-index codewiki and refresh .clio-coder state without touching CLIO-CODER.md. */
	onContextRefresh?: () => Promise<void>;
	/**
	 * Advance the orchestrator target one step forward through `provider.scope`.
	 * False means nothing moved, which the UI answers with a notice: the keys are
	 * documented in the help center and a silent no-op reads as a dropped key.
	 */
	onCycleScopedModelForward?: () => boolean;
	/** Advance the orchestrator target one step backward through `provider.scope`. */
	onCycleScopedModelBackward?: () => boolean;
	/**
	 * Convert the newest attached `dispatch` call into a detached batch. The
	 * outcome carries the line to render: `ok: false` covers both "nothing is
	 * running" and a topology that refuses the conversion, and both read better
	 * as a notice than as a keypress that changes no pixel.
	 */
	onBackgroundDispatch?: () => { ok: boolean; message: string };
	onShutdown: () => Promise<void>;
}

export const ENTER = "\r";
export const ESC = "\x1b";

export interface InteractiveSubmitExpansion {
	text: string;
	images: ImageContent[];
	workingContextPaths: string[];
	pendingSkillRequests: PendingSkillRequest[];
}

async function expandInteractiveSubmitAsync(
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
	 * CLIO_KEYBINDINGS; user overrides from settings.interface.keybindings. Tests may
	 * substitute a narrower matcher via createKeybindingManagerForTesting.
	 */
	matches: (data: string, id: ClioKeybinding) => boolean;
	/** App exit follows pi's editor rule: Ctrl+D exits only when the editor is empty. */
	canExit?: () => boolean;
	cycleThinking: () => void;
	requestShutdown: () => void;
	toggleStatus: () => void;
	toggleDispatchBoard: () => void;
	openTasks: () => void;
	openDecisions: () => void;
	backgroundDispatch: () => void;
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
	interruptWithMessage: () => void;
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
	if (deps.lastCtrlCAt > 0 && deps.now - deps.lastCtrlCAt <= APPLICATION_DOUBLE_TAP_MS) {
		return "shutdown";
	}
	if (deps.streaming) return "cancel-stream";
	if (deps.editorText.length > 0) return "clear-editor";
	return "arm-shutdown";
}

function dispatchInteractiveAction(id: ClioKeybinding, deps: KeyBindingDeps): boolean {
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
		case "clio.message.interrupt":
			deps.interruptWithMessage();
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
		case "clio.tasks.open":
			deps.openTasks();
			return true;
		case "clio.decisions.open":
			deps.openDecisions();
			return true;
		case "clio.dispatch.background":
			deps.backgroundDispatch();
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
		"clio.tasks.open",
		"clio.decisions.open",
		"clio.dispatch.background",
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
	const initialSmoothStreaming = resolveSmoothStreamingMode(deps.getSettings?.().interface.smoothStreaming ?? "off");
	const initialAutoPacingAllowed = processAutoPacingAllowed(false);
	const lease = deps.terminalLease;
	const shell =
		lease?.shell ??
		createProcessInteractiveShell({
			tuiMode: deps.getSettings?.().interface.mode ?? "regular",
			streamPacingActive:
				initialSmoothStreaming === "on" || (initialSmoothStreaming === "auto" && initialAutoPacingAllowed),
			...(deps.onFirstFrameCommit ? { onFirstFrameCommit: deps.onFirstFrameCommit } : {}),
		});
	const { terminal, tui } = shell;
	const renderTrace = getActiveRenderTrace();
	// SIGTERM is the kill an operator reaches for when a pane stops answering, so
	// it is where the always-on input-wedge ring has to land (#224). It writes
	// synchronously from its own listener rather than from a termination hook: a
	// session wedged badly enough to be killed may never reach the coordinator's
	// asynchronous drain, and this dump has to survive that.
	const dumpInputWedgeOnTerminate = renderTrace
		? (): void => {
				try {
					writeInputWedgeDump(clioStateDir(), renderTrace.snapshotInputWedge());
				} catch {
					// Best effort. The process is ending either way.
				}
			}
		: null;
	if (dumpInputWedgeOnTerminate) process.on("SIGTERM", dumpInputWedgeOnTerminate);
	const visibleEventIngress = new WeakMap<
		object,
		{ sequence: number; traceSequence: number; generation: number; ingressAt: number }
	>();
	let visibleEventSequence = 0;
	let visibleEventGeneration = 0;
	const recordChatEventIngress = (event: ChatLoopEvent): void => {
		if (event.type === "agent_start") {
			visibleEventGeneration += 1;
			renderTrace?.beginGeneration();
			return;
		}
		if (event.type !== "text_delta" && event.type !== "thinking_delta") return;
		visibleEventSequence += 1;
		const ingress = {
			sequence: visibleEventSequence,
			traceSequence: visibleEventSequence,
			generation: visibleEventGeneration,
			ingressAt: performance.now(),
		};
		visibleEventIngress.set(event, ingress);
		if (renderTrace) {
			ingress.traceSequence = renderTrace.recordVisibleEvent({
				kind: event.type === "text_delta" ? "text" : "thinking",
				contentIndex: event.contentIndex,
				delta: event.delta,
			});
		}
	};
	let applicationController: ApplicationController;
	const workspaceFacts = createWorkspaceFacts({
		cwd: process.cwd(),
		getSessionWorkspace: () => deps.session?.current()?.workspace ?? null,
		// The workspace probe lands after first paint now; ask for the frame that
		// shows the branch chip once it does.
		onRefreshed: () => tui.requestRender(),
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
	/**
	 * Ctrl+G armed the leader and is waiting for the next key. Owned here because
	 * the footer reads it and the input runtime that flips it is built later.
	 */
	let leaderArmed = false;
	/**
	 * A Ctrl+C armed the double tap and its 500ms window is still open. Owned
	 * here for the same reason as the leader flag above.
	 */
	let shutdownArmed = false;
	/**
	 * Assigned after the presentation because it renders into it. The composer
	 * rail reads it through the optional chain before then as "no prompt".
	 */
	let overlayLifecycle: OverlayLifecycleController;
	const presentation = createInteractivePresentation({
		bus: deps.bus,
		getLeaderArmed: () => leaderArmed,
		getShutdownArmed: () => shutdownArmed,
		isAwaitingApproval: () => overlayLifecycle?.getState() === "permission-confirm",
		getPermissionInspection: () => {
			if (overlayLifecycle === undefined || overlayLifecycle === null) return "none";
			if (!overlayLifecycle.canInspectMutation()) return "none";
			return overlayLifecycle.isInspectingMutation() ? "open" : "closed";
		},
		resolveVisibleEventSequence: (event) => visibleEventIngress.get(event)?.traceSequence ?? null,
		resolveStreamIngress: (event) => visibleEventIngress.get(event) ?? null,
		commitFrame: (reason) => shell.commitCurrentFrame(reason === "teardown" ? 300 : 30_000),
		hasObservedBackpressure: () => shell.hasObservedBackpressure(),
		onSmoothStreamingMode: (_mode, pacingActive) => shell.setStreamPacingActive(pacingActive),
		providers: deps.providers,
		dispatch: deps.dispatch,
		observability: deps.observability,
		chat: deps.chat,
		workspaceFacts,
		sessionTranscript,
		tui,
		terminal,
		...(!lease ? { mount: (root, editor) => shell.mount(root, editor) } : {}),
		...(lease
			? {
					editor: lease.editor,
					keybindings: lease.keybindings,
					bootPending: lease.pending,
				}
			: {}),
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
	// The factory arrives only from an active `--with-panes` boot (or a test); a
	// plain session has no deps.panes and no factory, and loads no yazi code.
	const yaziBridge =
		deps.panes && deps.createYaziBridge
			? deps.createYaziBridge({
					...(deps.mux ? { mux: deps.mux } : {}),
					getDraft: () => editor.getText(),
					setDraft: (text) => editor.setText(text),
					requestRender: () => tui.requestRender(),
					notice: (level, text) => notify(level, text, `yazi:${level}`),
					getCwd: () => process.cwd(),
					getSettings: () =>
						deps.getSettings?.().interface.panes.files ?? {
							mode: "companion",
							profile: "managed",
							followCwd: true,
						},
					stopUi: () => tui.stop(),
					startUi: () => {
						tui.start();
						tui.requestRender(true);
					},
				})
			: null;
	const detachYaziBridge = yaziBridge ? deps.attachYaziBridge?.(yaziBridge) : undefined;
	refreshPresentationFooter = () => footer.refresh();
	const agentProgress = createAgentProgress(terminal);
	// Desktop notifications are a protocol write on the terminal owner, issued
	// outside any render transaction, so the sequence carries frameId null and
	// never lands inside a frame. A non-TTY process never emits one even when
	// `CLIO_CODER_INTERACTIVE=1` forced the interactive surface on.
	const desktopNotifications = createInteractiveDesktopNotifications({
		write: (data) => terminal.write(data),
		enabled: () => deps.getSettings?.().interface.desktopNotifications ?? false,
		interactiveTty: () => process.stdout.isTTY === true,
		getOpenBatches: () => openDetachedBatchViews(deps.dispatch),
	});
	const busNoticeSink = {
		appendReplayBlock: (renderBlock: Parameters<typeof chatPanel.appendReplayBlock>[0]) =>
			chatRenderer.mutate(() => chatPanel.appendReplayBlock(renderBlock), "bus-notice"),
		requestRender: () => {},
	};
	const eventProjection = createInteractiveEventProjection({
		bus: deps.bus,
		chat: deps.chat,
		status: statusController,
		...(deps.initialNotices ? { initialNotices: deps.initialNotices } : {}),
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		getTerminalColumns: () => terminal.columns,
		onChatEventIngress: (event) => {
			recordChatEventIngress(event);
			presentation.recordChatEvent(event);
		},
		applyChatEvent: (event) => chatRenderer.applyEvent(event),
		setFollowUpMessages: (messages) => followUpQueuePanel.setMessages(messages),
		isAskUserWaiting: () => overlayLifecycle.isAskUserWaiting(),
		closeAskUserSession: () => overlayLifecycle.closeAskUserSession(),
		resetAskUserCancellation: () => overlayLifecycle.resetAskUserCancellation(),
		recordToolStart: (toolName, toolCallId) => presentation.recordToolStart(toolCallId, toolName),
		recordToolEnd: (_toolName, toolCallId, isError, truncated) =>
			presentation.recordToolEnd({ toolCallId, isError, truncated }),
		setStatusLine: (line) => chatPanel.setStatusLine(line),
		setLiveReasoning: (view) => chatPanel.setLiveReasoning(view),
		setLastTurnSummary: (summary) => presentation.setLastTurnSummary(summary),
		startTerminalProgress: () => agentProgress.start(),
		stopTerminalProgress: () => agentProgress.stop(),
		onTurnEnded: () => desktopNotifications.turnEnded(),
		refreshLiveWorkspaceGit,
		refreshFooter: () => footer.refresh(),
		requestRender: () => tui.requestRender(),
		notify,
		dismissNotification: (key) => notifications.dismiss(key),
		appendTranscriptNotice: (level, text) => appendNotice(level, text, busNoticeSink),
		refreshSettingsOverlay: () => overlayLifecycle.refreshSettingsOverlay(),
		onConfigHotReload: (settings) => {
			const mode = resolveSmoothStreamingMode(settings.interface.smoothStreaming);
			const autoAllowed = processAutoPacingAllowed(shell.hasObservedBackpressure());
			chatRenderer.setSmoothStreamingMode(mode);
			shell.setStreamPacingActive(mode === "on" || (mode === "auto" && autoAllowed));
		},
	});
	// The overlay reads the report this process already produced at boot; it
	// never probes on a keystroke.
	const interop = deps.interop;
	// `/council` reaches execution only through the tool registry, so the
	// approval overlay this application already installs on it is the same one an
	// operator-typed council parks.
	const toolRegistry = deps.toolRegistry;
	const interopSurface = interop ? interopOverlaySurface(interop, (level, text) => notify(level, text)) : null;
	const slashRuntime = createInteractiveSlashRuntime({
		io,
		bus: deps.bus,
		dispatch: deps.dispatch,
		...(deps.session ? { session: deps.session } : {}),
		providers: deps.providers,
		chat: deps.chat,
		chatPanel: {
			appendReplayBlock: (...args) => chatRenderer.mutate(() => chatPanel.appendReplayBlock(...args), "slash-output"),
			appendUser: (text, status) => chatRenderer.mutate(() => chatPanel.appendUser(text, status), "user-submit"),
			clearFoldOverrides: () => chatRenderer.mutate(() => chatPanel.clearFoldOverrides(), "output-detail"),
		},
		beforeSemanticSubmit: () => chatRenderer.flush(),
		settleVisibleFrame: (reason) => chatRenderer.flushAndCommit(reason),
		...(deps.resources ? { resources: deps.resources } : {}),
		...(deps.extensions ? { extensions: deps.extensions } : {}),
		...(interopSurface ? { interop: interopSurface } : {}),
		...(deps.agents ? { agents: deps.agents } : {}),
		...(deps.share ? { share: deps.share } : {}),
		...(deps.userTasks ? { userTasks: deps.userTasks } : {}),
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		...(deps.writeSettings ? { writeSettings: deps.writeSettings } : {}),
		...(deps.commitSetting ? { commitSetting: deps.commitSetting } : {}),
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
		openSkillsHub: (tab) => openSkillsHubState(tab),
		openCost: () => openCostOverlayState(),
		openSideQuestion: (question) => openSideQuestionOverlayState(question),
		startHandoff: (goal) => startHandoffState(goal),
		startFleetRun: (name, vars) => startFleetRunState(name, vars),
		openFleetRuns: () => toggleDispatchBoardOverlay(),
		...(toolRegistry ? { runCouncilDispatch: (args) => dispatchCouncilThroughRegistry(toolRegistry, args) } : {}),
		openContextView: () => openContextViewOverlayState(),
		openTasks: () => openTasksOverlayState(),
		openDecisions: () => openDecisionsOverlayState(),
		openMemory: () => openMemoryOverlayState(),
		...(deps.seedTaskMemory ? { seedTaskMemory: deps.seedTaskMemory } : {}),
		openView: (filter) => openViewOverlayState(filter),
		...(deps.panes ? { panes: deps.panes } : {}),
		openModel: () => openModelOverlayState(),
		openModelScope: (ref) => openModelScopeState(ref),
		openSettings: (area, group) => {
			if (!area) return openSettingsOverlayState();
			// Compatibility adapter until the seven-area Settings shell replaces
			// the legacy section ids. Slash grammar never exposes these old names.
			if (area === "chat" && group === "model-picker") return openSettingsOverlayState("models", "scope");
			const section = {
				chat: "orchestrator",
				fleet: "fleet",
				targets: "targets",
				context: "compaction",
				safety: "safety",
				interface: "terminal",
				integrations: "advanced",
			} satisfies Record<SettingsAreaId, Parameters<typeof openSettingsOverlayState>[0]>;
			openSettingsOverlayState(section[area]);
		},
		openResume: () => openResumeOverlayState(),
		startNewSession: () => startNewSession(),
		openTree: () => openTreeOverlayState(),
		openMessagePicker: () => openMessagePickerOverlayState(),
		openHelp: (query) => openHelpOverlayState(query),
		openAgents: () => openAgentsOverlayState(),
		openPrompts: () => openPromptsOverlayState(),
		openExtensions: () => openExtensionsOverlayState(),
		openInterop: () => openInteropOverlayState(),
		openContextReset: () => openContextResetOverlayState(),
		setEditorText: (text) => editor.setText(text),
		// What the operator can share is what the operator can see: the panel's
		// blocks, live or replayed, rather than the reducer's routing table.
		listWorkerRuns: () => chatPanel.workerStates(),
	});

	const editorSubmit = createEditorSubmitController({
		editor,
		ui: tui,
		io,
		chat: deps.chat,
		dispatch: deps.dispatch,
		...(deps.session ? { session: deps.session } : {}),
		sessionTranscript,
		chatPanel: {
			appendReplayBlock: (...args) =>
				chatRenderer.mutate(() => chatPanel.appendReplayBlock(...args), "editor-command-output"),
		},
		beforeSemanticBoundary: () => chatRenderer.flush(),
		settleVisibleFrame: (reason) => chatRenderer.flushAndCommit(reason),
		dispatchCommand: slashRuntime.dispatchCommand,
		dispatchCommandAsync: slashRuntime.admitCommand,
		collapseLaunchpadBeforeSubmit: () => presentation.collapseWelcomeDashboard(),
		expandSubmit: (text) => expandInteractiveSubmitAsync(text, deps.resources),
		notify,
	});
	editor.onSubmit = editorSubmit.submitEditorText;

	const interactiveTickers = createInteractiveTickers({
		tui,
		dispatchBoardStore,
		contextActivityStore,
		getOverlayState: () => overlayLifecycle?.getState() ?? "closed",
		isFooterExpanded: () => footer.isExpanded(),
		...(deps.getTaskBoard ? { getTaskBoard: deps.getTaskBoard } : {}),
	});
	/**
	 * The one transcript reset. The chat panel and the worker fold are two views
	 * of one session, so a session change (/new, /resume, /tree, /fork) clears
	 * them together: a late event for a run of the old session then finds no
	 * entry, and bare /share cannot select the old session's result. Read lazily
	 * because the subscriptions that own the fold are built below.
	 */
	const resetTranscript = (): void => {
		chatRenderer.reset(() => {
			chatPanel.reset();
			interactiveSubscriptions.workers.reset();
		});
	};
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
		setFleetRunPhase: (runId, phase) => dispatchBoardStore.setFleetPhase(runId, phase),
		chatPanel,
		resetTranscript,
		io,
		readStructuredEntries,
		announceTaskMemorySeedOffer,
		setLastTurnSummary: (summary) => presentation.setLastTurnSummary(summary),
		keybindings,
		editor,
		getSlashContext: () => slashRuntime.context,
		// One terminal owner, so the external editor a handoff review opens gets
		// the screen the same way the composer's own `$EDITOR` opener does.
		suspendTerminal: (run) => {
			try {
				tui.stop();
				return run();
			} finally {
				tui.start();
				tui.requestRender(true);
			}
		},
		onOperatorParked: () => desktopNotifications.approvalParked(),
	});
	const {
		closeOverlay,
		openAskUserOverlayState,
		openCostOverlayState,
		openSideQuestionOverlayState,
		startHandoffState,
		startFleetRunState,
		openContextViewOverlayState,
		openContextResetOverlayState,
		openTasksOverlayState,
		openDecisionsOverlayState,
		openMemoryOverlayState,
		openViewOverlayState,
		openModelOverlayState,
		openModelScopeState,
		openSettingsOverlayState,
		openResumeOverlayState,
		openTreeOverlayState,
		openMessagePickerOverlayState,
		openHelpOverlayState,
		openAgentsOverlayState,
		openSkillsHubState,
		openPromptsOverlayState,
		openExtensionsOverlayState,
		openInteropOverlayState,
		toggleDispatchBoardOverlay,
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
		// Esc must not eat typed work: queued steers and follow-ups return to the
		// editor before the abort, the same restore the reference implementation
		// performs. cancel() then finds both queues already empty.
		const restored = deps.chat.clearQueuedFollowUps();
		if (restored.length > 0) {
			const current = editor.getText();
			editor.setText([restored.join("\n\n"), current].filter((part) => part.trim().length > 0).join("\n\n"));
		}
		chatRenderer.flush();
		deps.chat.cancel();
		deps.toolRegistry?.cancelParkedCalls("run cancelled by operator");
		footer.refresh();
		tui.requestRender();
	};

	const startNewSession = async (): Promise<void> => {
		if (!deps.onNewSession) {
			emitCommandNotice(slashRuntime.notice, "error", "new", "session contract unavailable");
			return;
		}
		const settlement = settleChatBeforeSessionSwitch(deps.chat);
		if (settlement) await settlement;
		deps.onNewSession();
		deps.observability.resetSession();
		presentation.resetForNewSession();
		resetTranscript();
		deps.chat.resetForSession(null);
		footer.refresh();
		tui.requestRender();
	};
	/**
	 * Alt+J and Alt+K with nothing to step to. The help center documents both
	 * keys, so a keypress that changes no pixel reads as a broken binding rather
	 * than as an empty set; the set itself is chosen in `/scoped-models`.
	 */
	const announceEmptyScopedSet = (): void => {
		notify(
			"info",
			"scoped models: nothing to cycle to; run /scoped-models to choose the set Alt+J and Alt+K step through",
			"scoped-models:empty",
		);
	};
	/**
	 * Alt+S / Ctrl+Alt+B. The dispatch tool owns the conversion and answers with
	 * the line to show, so the refusal a review-gated or compete call returns is
	 * rendered verbatim rather than restated here.
	 */
	const backgroundActiveDispatch = (): void => {
		const outcome = deps.onBackgroundDispatch?.() ?? {
			ok: false,
			message: "background: dispatch backgrounding is unavailable in this session",
		};
		notify(outcome.ok ? "success" : "info", outcome.message, "dispatch:background");
	};
	// Built only when a pane host answered detection, so a session with no
	// panes subscribes to nothing and the bus handlers do not exist at all.
	// The factories arrive from the `--with-panes` composition root (or a
	// test); a plain session loads none of the bridge code.
	const mux = deps.mux;
	const muxBridge =
		mux && mux.mode !== "none" && deps.createMuxBridge
			? deps.createMuxBridge({
					bus: deps.bus,
					mux,
					notificationsPolicy: () => deps.getSettings?.().interface.panes.notifications ?? "failures",
					log: (level, message) => {
						if (level === "warning") notify("warning", message, "mux:bridge");
					},
					notice: (level, text) => appendNotice(level, text, busNoticeSink),
				})
			: null;
	// The workers-view watch pane: opened on Enter over a live run, retargeted
	// by arrow keys through its selection file. `/panes show` and the panes
	// tool drive the same controller through the shared operations object.
	const watchPane =
		mux && mux.mode !== "none" && deps.createWatchPane
			? deps.createWatchPane({
					mux,
					getCwd: () => process.cwd(),
					getWorkersRatio: () => deps.getSettings?.().interface.panes.workers.ratio ?? 0.34,
				})
			: null;
	const detachWatchPane = watchPane ? deps.attachWatchPane?.(watchPane) : undefined;
	// Boot composition per `interface.panes.layout`: `workers` opens the workers
	// dock parked on "no selection"; `cockpit` adds the files dock. Fire and
	// forget, and only against a live pane host: a boot must never fall through
	// to the in-terminal chooser or block the first paint on socket traffic.
	{
		const bootSettings = deps.getSettings?.();
		const layout = bootSettings?.interface.panes.layout ?? "off";
		if (layout !== "off" && mux?.available()) {
			void watchPane?.ensureOpen();
			if (layout === "cockpit" && bootSettings?.interface.panes.files.enabled) void yaziBridge?.open();
		}
	}
	const selectedWatchableRun = (): { runId: string; agentId: string } | null => {
		if (!watchPane) return null;
		const row = dispatchBoard.selectedRow();
		if (!row) return null;
		const decision = paneWatchDecision({ source: "workers-view", runStatus: row.status });
		return decision.open ? { runId: row.runId, agentId: row.agentId } : null;
	};
	/**
	 * Enter in the workers view. True means the watch pane took the key; false
	 * (panes off, nothing watchable under the policy) falls back to the inline
	 * worker-progress detail, so a terminal run's Enter still expands its card.
	 */
	const watchSelectedDispatch = (): boolean => {
		const selected = selectedWatchableRun();
		if (!watchPane || !selected) return false;
		void watchPane.watch(selected.runId).then((result) => {
			if (result.status === "watching") {
				if (result.opened) {
					notify("success", `watching ${selected.agentId} (${selected.runId}) in a pane`, "panes:watch");
				}
			} else {
				notify("warning", result.reason, "panes:watch");
			}
			tui.requestRender();
		});
		return true;
	};
	/** Arrow keys: the watch pane follows the cursor, but only once it exists. */
	const followBoardSelection = (): void => {
		if (!watchPane?.isOpen()) return;
		const selected = selectedWatchableRun();
		if (selected) watchPane.follow(selected.runId);
	};
	const interactiveSubscriptions = createInteractiveSubscriptions({
		bus: deps.bus,
		refreshFooter: () => footer.refresh(),
		renderTaskIsland: interactiveTickers.renderTaskIsland,
		renderContextIsland: interactiveTickers.renderContextIsland,
		requestRender: () => tui.requestRender(),
		notify,
		onDispatchSettled: () => desktopNotifications.dispatchSettled(),
		// The reducer mutates one state object per assignment, so the panel is
		// handed that object rather than a copy: a streamed delta reaches the
		// screen by invalidating a cached render, not by rebuilding the entry.
		applyWorkerState: (state) => chatRenderer.mutate(() => chatPanel.applyWorkerState(state), "worker-state"),
		recordWorkerRun: (fields) => {
			// A `/run` is an operator action that produced durable state, so it
			// opens a session the same way a local `!bash` line does. Persistence
			// is best effort: a failure here costs the block on the next resume,
			// and must not cost the block on screen now.
			try {
				sessionTranscript.ensureSessionForLocalEntry();
				if (!deps.session?.current()) return;
				deps.session.appendEntry({ ...fields, parentTurnId: deps.session.tree().leafId ?? null });
			} catch {
				// Best effort; the live block already rendered.
			}
		},
	});

	applicationController = createInteractiveInputRuntime({
		keybindings,
		dispatchAction: dispatchInteractiveAction,
		actions: {
			canExit: () => editor.getText().length === 0,
			availableThinkingLevels: () => availableInteractiveThinkingLevels(deps),
			onCycleThinking: () => deps.onCycleThinking?.(),
			cycleScopedModelForward: () => {
				if (deps.onCycleScopedModelForward?.() === false) announceEmptyScopedSet();
			},
			cycleScopedModelBackward: () => {
				if (deps.onCycleScopedModelBackward?.() === false) announceEmptyScopedSet();
			},
			backgroundActiveDispatch,
		},
		overlay: overlayLifecycle,
		refreshFooter: () => footer.refresh(),
		onLeaderStateChange: (pending) => {
			leaderArmed = pending;
		},
		onShutdownArmedChange: (armed) => {
			shutdownArmed = armed;
		},
		dispatchBoard: {
			selectPrevious: () => {
				dispatchBoard.selectPrevious();
				followBoardSelection();
			},
			selectNext: () => {
				dispatchBoard.selectNext();
				followBoardSelection();
			},
			toggleDetail: () => dispatchBoard.toggleDetail(),
		},
		watchSelectedDispatch,
		steerSelectedDispatch,
		cancelSelectedDispatch,
		cancelActiveEditorBash: () => editorSubmit.cancelActiveEditorBash(),
		isStreaming: () => deps.chat.isStreaming(),
		cancelActiveRun,
		editor,
		editorSubmit,
		requestRender: () => tui.requestRender(),
		notifications,
		chatPanel: {
			toggleLastToolExpanded: () => chatPanel.toggleLastToolExpanded(),
			toggleAllToolsExpanded: () => chatPanel.toggleAllToolsExpanded(),
			toggleLiveToolOutput: () => chatPanel.toggleLiveToolOutput(),
			toggleLastThinking: () => {
				let changed = false;
				chatRenderer.mutate(() => {
					changed = chatPanel.toggleLastThinking();
				}, "thinking-visibility");
				return changed;
			},
			toggleAllThinking: () => {
				let changed = false;
				chatRenderer.mutate(() => {
					changed = chatPanel.toggleAllThinking();
				}, "thinking-visibility");
				return changed;
			},
		},
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
			disposeSubscriptions: () => {
				detachYaziBridge?.();
				yaziBridge?.dispose();
				detachWatchPane?.();
				watchPane?.dispose();
				muxBridge?.dispose();
				interactiveSubscriptions.dispose();
			},
		},
		beforeStopUi: (() => {
			let settlement: Promise<void> | null = null;
			return () => {
				settlement ??= chatRenderer.flushAndCommit("teardown").finally(() => chatRenderer.dispose());
				return settlement;
			};
		})(),
		stopUi: () => {
			if (lease) void lease.close();
			else shell.stop();
		},
		cancelParkedCalls: (reason) => deps.toolRegistry?.cancelParkedCalls(reason),
		onShutdown: async () => {
			try {
				if (dumpInputWedgeOnTerminate) process.off("SIGTERM", dumpInputWedgeOnTerminate);
				await deps.onShutdown();
			} finally {
				if (lease) await lease.close();
				else await shell.settle();
			}
		},
		registerInputListener: (listener) => {
			if (lease) lease.registerApplicationInput(listener);
			else tui.addInputListener(listener);
		},
		...(lease
			? {
					signals: lease.applicationSignals,
					// The lease registered its exactly-once drain before hydration.
					registerTerminalTeardown: () => {},
				}
			: {}),
		...(renderTrace
			? {
					onInputIngress: (action, data) =>
						renderTrace.recordInputIngress(action, Buffer.byteLength(data, "utf8"), action !== "no-visual-change"),
				}
			: {}),
	});

	if (lease) {
		const adopted = lease.adopt({
			root: presentation.root,
			editorChrome: presentation.editorChrome,
			admitSubmission: (submission) => editorSubmit.admitCapturedText(submission.rawText, lease.abortSignal),
			...(deps.onHydratedFrameCommit ? { onHydratedFrame: deps.onHydratedFrameCommit } : {}),
		});
		if (!adopted) void applicationController.shutdown();
	}

	return applicationController.run;
}
