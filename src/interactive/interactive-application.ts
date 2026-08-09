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
import type { ObservabilityContract, ObservabilitySnapshot } from "../domains/observability/index.js";
import {
	type ProvidersContract,
	resolveModelRuntimeCapabilitiesForProviders,
	type ThinkingLevel,
} from "../domains/providers/index.js";
import type { ResourcesContract } from "../domains/resources/index.js";
import { getMarketplaceSkills } from "../domains/resources/skills/marketplace.js";
import type { FleetNodeSnapshot } from "../domains/scheduling/cluster.js";
import type { SessionContract, SessionEntry, TaskBoardSnapshot } from "../domains/session/index.js";
import type { ShareContract } from "../domains/share/index.js";
import { createAgentProgress, isKeyRelease, matchesKey } from "../engine/tui.js";
import type { ImageContent } from "../engine/types.js";
import type { AskUserHandler } from "../tools/ask-user.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ChatLoop } from "./chat-loop.js";
import { createChatPanel } from "./chat-panel.js";
import { createCoalescingChatRenderer } from "./chat-renderer.js";
import { ClioEditor } from "./clio-editor.js";
import { emitCommandNotice } from "./command-fallbacks.js";
import { appendNotice, createCommandOutputRunIo } from "./command-output.js";
import { createContextActivityStore } from "./context-activity.js";
import { createDispatchBoardStore, createDispatchBoardView } from "./dispatch-board.js";
import { createDispatchSteering } from "./dispatch-steering.js";
import { createEditorSubmitController } from "./editor-submit.js";
import { createFollowUpQueuePanel } from "./follow-up-queue-panel.js";
import { buildFooterDashboard, type FooterDashboardPanel } from "./footer/dashboard.js";
import { createNotificationCenter } from "./footer/notifications.js";
import { createInteractiveEventProjection } from "./interactive-event-projection.js";
import { createProcessInteractiveShell } from "./interactive-shell.js";
import { createInteractiveSlashRuntime } from "./interactive-slash-runtime.js";
import { createInteractiveSubscriptions } from "./interactive-subscriptions.js";
import { createInteractiveTickers } from "./interactive-tickers.js";
import { createKeybindingManager } from "./keybinding-manager.js";
import { buildLayout } from "./layout.js";
import { createLeaderKeyController } from "./leader-key.js";
import {
	createOverlayLifecycle,
	isEscapeKey,
	type OverlayLifecycleController,
	type OverlayState,
	overlayOwnsInput,
	routeOverlayKey,
} from "./overlay-lifecycle.js";
import { resolveAvailableThinkingLevels } from "./overlays/thinking-selector.js";
import type { TargetsHubNoticeLevel } from "./providers-overlay.js";
import { createSessionTranscript } from "./session-transcript.js";
import { createSlashCommandAutocompleteProvider } from "./slash-autocomplete.js";
import type {
	ContextClearCommandOptions,
	InitCommandOptions,
	RunIo,
	TaskMemorySeedCommandResult,
} from "./slash-commands.js";
import { createStatusController, type TurnSummary } from "./status/index.js";
import { abbreviateModelId } from "./theme/index.js";
import { createWelcomeDashboard } from "./welcome-dashboard.js";
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
	 * Resolver for the current `workers.default` block. `/run` uses this to
	 * short-circuit with an actionable error when no provider is configured
	 * instead of letting the dispatch throw with no config context.
	 */
	getWorkerDefault?: () => { target?: string; model?: string } | undefined;
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

function isCtrlCKey(data: string): boolean {
	return matchesKey(data, "ctrl+c") && !isKeyRelease(data);
}

/** Title-case a KeyId for display, e.g. `alt+x` → `Alt+X`. Falls back to `Alt+X`. */
function formatKeyLabel(keyId: string | undefined): string {
	if (!keyId || keyId.length === 0) return "Alt+X";
	return keyId
		.split("+")
		.map((segment) => (segment.length === 0 ? segment : segment.charAt(0).toUpperCase() + segment.slice(1)))
		.join("+");
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

/**
 * Pure cancel logic for the cwd-fallback overlay. Restores the prior session
 * when one existed and differs from the just-resumed session id; otherwise
 * reopens the /resume overlay so the user can pick again. Lifted out of the
 * openCwdFallbackOverlayState closure so both Esc-via-SelectList and
 * Cancel-row-via-Enter exercise the same code path under test.
 */
export interface CwdFallbackCancelDeps {
	session: SessionContract;
	openResumeOverlay: () => void;
	onWarning: (msg: string) => void;
}

function _handleCwdFallbackCancel(preResumeSessionId: string | null, deps: CwdFallbackCancelDeps): void {
	const currentId = deps.session.current()?.id ?? null;
	if (preResumeSessionId && preResumeSessionId !== currentId) {
		try {
			deps.session.switchBranch(preResumeSessionId);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			deps.onWarning(`[cwd-fallback] could not restore prior session: ${msg}\n`);
		}
		return;
	}
	deps.openResumeOverlay();
}

export async function createInteractiveApplication(deps: InteractiveDeps): Promise<number> {
	const shell = createProcessInteractiveShell();
	const { terminal, tui } = shell;

	// Build the runtime keybinding manager from the current settings snapshot.
	// This also installs the manager as pi-tui's global (via setKeybindings)
	// so editor/select components honor overrides without explicit plumbing.
	const keybindings = createKeybindingManager(deps.getSettings?.() ?? ({ keybindings: {} } as ClioSettings));

	const workspaceFacts = createWorkspaceFacts({
		cwd: process.cwd(),
		getSessionWorkspace: () => deps.session?.current()?.workspace ?? null,
		...(deps.extensions ? { extensions: deps.extensions } : {}),
	});
	const { getExtensionStats, getLiveWorkspaceSnapshot, refreshLiveWorkspaceGit } = workspaceFacts;

	let footer: FooterDashboardPanel;
	const sessionTranscript = createSessionTranscript({
		...(deps.session ? { session: deps.session } : {}),
		...(deps.getSessionId ? { getSessionId: deps.getSessionId } : {}),
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		...(deps.readSessionEntries ? { readSessionEntries: deps.readSessionEntries } : {}),
		chat: deps.chat,
		refreshStatus: () => footer.refresh(),
	});
	const { liveSessionTurns, readStructuredEntries, recordSubmittedTurn } = sessionTranscript;

	const banner = createWelcomeDashboard({
		providers: deps.providers,
		observability: deps.observability,
		getContextUsage: () => deps.chat.contextUsage(),
		getWorkspaceSnapshot: workspaceFacts.getWorkspaceSnapshot,
		getExtensionStats,
		...(deps.getTaskMemoryStatus ? { getTaskMemoryStatus: deps.getTaskMemoryStatus } : {}),
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
	});
	const chatPanel = createChatPanel({
		// Surface the bound `clio.tool.expand` key on collapsed tool sublines so
		// users can discover the Ctrl+O toggle. Pulls from the keybindings
		// manager on every render so user rebinds flow through; the first bound
		// key wins when multiple are configured.
		getToolExpandKey: () => {
			const keys = keybindings.getKeys("clio.tool.expand");
			const first = keys[0];
			return typeof first === "string" && first.length > 0 ? first : undefined;
		},
		getOutputVerbosity: () => deps.getSettings?.().terminal.outputVerbosity ?? "default",
	});
	const followUpQueuePanel = createFollowUpQueuePanel({
		getDequeueKey: () => {
			const keys = keybindings.getKeys("clio.message.dequeue");
			const first = keys[0];
			return typeof first === "string" && first.length > 0 ? first : undefined;
		},
	});
	const statusController = createStatusController({
		chat: deps.chat,
		providers: deps.providers,
		bus: deps.bus,
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
	});
	const dispatchBoardStore = createDispatchBoardStore(deps.bus, () => deps.dispatch.snapshot());
	const contextActivityStore = createContextActivityStore(deps.bus);
	const footerToolCounts = new Map<string, number>();
	const footerActiveTools = new Set<string>();
	let footerToolErrors = 0;
	let footerToolTruncatedResults = 0;
	// Metrics for the most recent completed turn. The faint per-turn summary no
	// longer prints under the assistant reply; it lives in the footer instead so
	// the transcript stays calm and the footer carries the live telemetry.
	let lastTurnSummary: TurnSummary | null = null;
	// Dedicated harness→user surface. Boot hints and live connect/probe notices
	// route here (anchored in the footer region) instead of into the transcript,
	// so they never leak into VT scrollback.
	let lastToolExpandAtMs = 0;
	let lastThinkingExpandAtMs = 0;
	let lastNotificationDismissAtMs = 0;
	const dismissKeyLabel = formatKeyLabel(keybindings.getKeys("clio.notifications.dismiss")[0]);
	const notifications = createNotificationCenter({
		onChange: () => {
			footer?.refresh();
			tui.requestRender();
		},
	});
	const notify = (level: TargetsHubNoticeLevel, text: string, key?: string): void => {
		notifications.add(key ? { level, text, key } : { level, text });
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
	const dismissContextBootstrapNotices = (): void => {
		for (const notice of notifications.list()) {
			if (/^clio: (No CLIO\.md detected|malformed CLIO\.md ignored|Imported agent context changed)/.test(notice.text)) {
				notifications.dismiss(notice.id);
			}
		}
	};
	// Live observability projection cache. The footer's session cost/token/
	// throughput getters read this snapshot instead of the raw contract methods,
	// so the projection is the single source path; the subscription below keeps
	// it current and drives render invalidation on each coalesced update.
	let observabilitySnapshot: ObservabilitySnapshot = deps.observability.snapshot();
	footer = buildFooterDashboard({
		providers: deps.providers,
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		getAgentStatus: () => statusController.current(),
		getTerminalColumns: () => terminal.columns,
		getSessionTokens: () => observabilitySnapshot.session.tokens,
		getTokenThroughput: () => observabilitySnapshot.session.latestThroughput,
		getSessionCost: () => observabilitySnapshot.session.cost,
		getContextUsage: () => deps.chat.contextUsage(),
		getContextLedger: () => deps.chat.contextLedger(),
		getDispatchRows: () => dispatchBoardStore.rows(),
		...(deps.getTaskBoard ? { getTaskBoard: deps.getTaskBoard } : {}),
		...(deps.getTaskMemoryStatus ? { getTaskMemoryStatus: deps.getTaskMemoryStatus } : {}),
		getContextActivity: () => contextActivityStore.current(),
		getToolCounts: () => ({
			tools: Object.fromEntries(footerToolCounts),
			errors: footerToolErrors,
			active: footerActiveTools.size,
			truncatedResults: footerToolTruncatedResults,
		}),
		...(deps.getContextState
			? { getContextState: () => deps.getContextState?.(process.cwd()) ?? { clioMd: "none", memoryCount: 0 } }
			: {}),
		getWorkspaceSnapshot: getLiveWorkspaceSnapshot,
		getExtensionStats,
		getSessionInfo: () => {
			const meta = deps.session?.current();
			return {
				id: meta?.id ?? deps.getSessionId?.() ?? null,
				name: meta?.name ?? null,
				turns: liveSessionTurns(),
			};
		},
		getLastTurnSummary: () => lastTurnSummary,
		getNotifications: () => notifications.list(),
		dismissKeyLabel,
	});
	// Single observability subscription drives footer session cost/token/
	// throughput refresh. The projection coalesces the dispatch terminal channels
	// and every recordTokens/resetSession into one debounced update, so this
	// replaces the per-event footer refresh patchwork for those facts. subscribe()
	// fires immediately with the current snapshot; it is unsubscribed at shutdown.
	const unsubscribeObservability = deps.observability.subscribe((snapshot) => {
		observabilitySnapshot = snapshot;
		footer.refresh();
		tui.requestRender();
	});
	const editor = new ClioEditor(tui, {
		getModelLabel: () => {
			const settings = deps.getSettings?.();
			const model = settings?.orchestrator?.model?.trim();
			if (!model) return "no model";
			const target = settings?.orchestrator?.target?.trim();
			const abbreviated = abbreviateModelId(model);
			return target ? `${target}·${abbreviated}` : abbreviated;
		},
		getThinkingLabel: () => {
			const settings = deps.getSettings?.();
			return (
				resolveModelRuntimeCapabilitiesForProviders(
					deps.providers,
					settings?.orchestrator?.target,
					settings?.orchestrator?.model,
					settings?.orchestrator?.thinkingLevel ?? "off",
				)?.thinking.display ??
				settings?.orchestrator?.thinkingLevel ??
				"off"
			);
		},
	});
	editor.focused = true;
	editor.setAutocompleteProvider(
		createSlashCommandAutocompleteProvider({
			listSkills: () => {
				const installed = deps.resources?.skills(process.cwd()).items ?? [];
				const marketplace = getMarketplaceSkills();
				return { installed, marketplace };
			},
		}),
	);

	// The permission overlay is rebuilt per open because its body depends on
	// the parked tool call.
	// The dispatch board renders live at the width the overlay actually grants;
	// the cached observability snapshot supplies each card's evidence/proof
	// state and is kept current by the single subscription above.
	const dispatchBoard = createDispatchBoardView(
		() => dispatchBoardStore.rows(),
		() => observabilitySnapshot,
	);
	const chatRenderer = createCoalescingChatRenderer({
		chatPanel,
		requestRender: () => tui.requestRender(),
	});

	const io: RunIo = createCommandOutputRunIo({
		appendReplayBlock: (renderBlock) => chatPanel.appendReplayBlock(renderBlock),
		requestRender: () => tui.requestRender(),
	});
	// OSC 9;4 indeterminate progress around each agent turn. The terminal engine
	// exposes Terminal.setProgress; the engine helper wraps it so start/stop
	// are idempotent and unit-testable.
	const agentProgress = createAgentProgress(terminal);
	// Transcript sink shared by the bus-notice subscribers below (loop guard,
	// budget alerts, safety blocks).
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
		recordToolStart: (toolName, toolCallId) => {
			footerActiveTools.add(toolCallId);
			footerToolCounts.set(toolName, (footerToolCounts.get(toolName) ?? 0) + 1);
		},
		recordToolEnd: (_toolName, toolCallId, isError, truncated) => {
			footerActiveTools.delete(toolCallId);
			if (isError) footerToolErrors += 1;
			if (truncated) footerToolTruncatedResults += 1;
		},
		setStatusLine: (line) => chatPanel.setStatusLine(line),
		setLastTurnSummary: (summary) => {
			lastTurnSummary = summary;
		},
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
		...(deps.getWorkerDefault ? { getWorkerDefault: deps.getWorkerDefault } : {}),
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		...(deps.writeSettings ? { writeSettings: deps.writeSettings } : {}),
		...(deps.onSelectModel ? { onSelectModel: deps.onSelectModel } : {}),
		...(deps.onSetThinkingLevel ? { onSetThinkingLevel: deps.onSetThinkingLevel } : {}),
		...(deps.onCompact ? { onCompact: deps.onCompact } : {}),
		...(deps.onInit ? { onInit: deps.onInit } : {}),
		...(deps.onContextClear ? { onContextClear: deps.onContextClear } : {}),
		...(deps.onContextRefresh ? { onContextRefresh: deps.onContextRefresh } : {}),
		stateDir: deps.stateDir,
		shutdown: () => shutdown(),
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
	const { openExternalEditorForInput, queueFollowUpFromEditor, restoreQueuedFollowUpsToEditor, submitEditorText } =
		editorSubmit;

	editor.onSubmit = submitEditorText;

	const root = buildLayout({ banner, chat: chatPanel, pending: followUpQueuePanel, editor, footer: footer.view });
	shell.mount(root, editor);

	let footerTicker: NodeJS.Timeout | null = null;
	footerTicker = setInterval(() => {
		const statusActive = statusController.current().phase !== "idle";
		if (!deps.chat.isStreaming() && !statusActive && !footer.isExpanded()) return;
		footer.refresh();
		tui.requestRender();
	}, 120);
	footerTicker.unref?.();

	// Running expanded/collapsed tool segments show live elapsed time; refresh
	// the transcript once per second while a turn is streaming so the elapsed
	// counter ticks without waiting for the next agent event.
	let toolElapsedTicker: NodeJS.Timeout | null = null;
	toolElapsedTicker = setInterval(() => {
		if (!deps.chat.isStreaming()) return;
		chatPanel.invalidate?.();
		tui.requestRender();
	}, 1_000);
	toolElapsedTicker.unref?.();

	let workspaceTicker: NodeJS.Timeout | null = null;
	workspaceTicker = setInterval(() => {
		refreshLiveWorkspaceGit(true);
		footer.refresh();
		tui.requestRender();
	}, 5_000);
	workspaceTicker.unref?.();

	const run = shell.anchor();

	let shuttingDown = false;
	let lastCtrlCAt = 0;
	const leaderKeys = createLeaderKeyController({
		matchesLeader: (input) => keybindings.matches(input, "clio.leader"),
		leaderTargets: () => keybindings.leaderTargets(),
		dispatchAction: (id) => dispatchInteractiveAction(id, keyActionDeps()),
		isRelease: isKeyRelease,
	});
	process.removeAllListeners("SIGINT");
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
		getObservabilitySnapshot: () => observabilitySnapshot,
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
		toggleFooterDashboardState,
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
		footerToolCounts.clear();
		footerActiveTools.clear();
		footerToolErrors = 0;
		footerToolTruncatedResults = 0;
		chatPanel.reset();
		deps.chat.resetForSession(null);
		footer.refresh();
		tui.requestRender();
	};
	const shutdown = async (): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		process.off("SIGINT", handleCtrlC);
		shell.releaseAnchor();
		if (footerTicker) clearInterval(footerTicker);
		if (toolElapsedTicker) clearInterval(toolElapsedTicker);
		if (workspaceTicker) clearInterval(workspaceTicker);
		leaderKeys.dispose();
		interactiveTickers.dispose();
		footer.dispose();
		unsubscribeObservability();
		contextActivityStore.unsubscribe();
		dispatchBoardStore.unsubscribe();
		eventProjection.disposePrimary();
		statusController.dispose();
		eventProjection.disposeRemaining();
		overlayLifecycle.dispose();
		agentProgress.stop();
		deps.chat.dispose();
		interactiveSubscriptions.dispose();
		shell.stop();
		// Drain the parked queue so any worker or agent loop still holding
		// a pending tool-execution promise sees a terminal verdict rather
		// than a promise that never settles across process exit.
		deps.toolRegistry?.cancelParkedCalls("Clio Coder shutting down");
		await deps.onShutdown();
		shell.complete(0);
	};

	const handleCtrlC = (): void => {
		const action = resolveCtrlCAction({
			overlayState: overlayLifecycle.getState(),
			streaming: deps.chat.isStreaming(),
			editorText: editor.getText(),
			lastCtrlCAt,
			now: Date.now(),
		});
		if (action === "shutdown") {
			lastCtrlCAt = 0;
			void shutdown();
			return;
		}
		lastCtrlCAt = Date.now();
		if (action === "cancel-stream") {
			cancelActiveRun();
			return;
		}
		if (action === "close-overlay") {
			// Closing a modal is not the first half of the main-editor shutdown
			// gesture. Reset the double-tap clock so a quick second Ctrl+C cannot
			// exit Clio after merely dismissing /agents or /fleet.
			lastCtrlCAt = 0;
			closeOverlay();
			return;
		}
		if (action === "clear-editor") {
			editor.setText("");
			tui.requestRender();
		}
	};
	process.on("SIGINT", handleCtrlC);

	const keyActionDeps = (): KeyBindingDeps => ({
		matches: (input, id) => keybindings.matches(input, id),
		canExit: () => editor.getText().length === 0,
		cycleThinking: () => {
			const settings = deps.getSettings?.();
			const available = settings ? resolveAvailableThinkingLevels(deps.providers, settings) : (["off"] as ThinkingLevel[]);
			if (available.length === 1 && available[0] === "off") {
				footer.refresh();
				tui.requestRender();
				return;
			}
			deps.onCycleThinking?.();
			footer.refresh();
			tui.requestRender();
		},
		requestShutdown: () => {
			void shutdown();
		},
		toggleStatus: () => {
			toggleFooterDashboardState();
		},
		toggleDispatchBoard: () => {
			toggleDispatchBoardOverlay();
		},
		openModelSelector: () => {
			openModelOverlayState();
		},
		openTree: () => {
			openTreeOverlayState();
		},
		cycleScopedModelForward: () => {
			deps.onCycleScopedModelForward?.();
			footer.refresh();
			tui.requestRender();
		},
		cycleScopedModelBackward: () => {
			deps.onCycleScopedModelBackward?.();
			footer.refresh();
			tui.requestRender();
		},
		dismissNotifications: () => {
			const nowMs = Date.now();
			const isDoubleTap = lastNotificationDismissAtMs > 0 && nowMs - lastNotificationDismissAtMs <= CTRL_C_DOUBLE_TAP_MS;
			lastNotificationDismissAtMs = nowMs;
			if (isDoubleTap) {
				notifications.dismissAll();
				return;
			}
			const first = notifications.list()[0];
			if (first) notifications.dismiss(first.id);
		},
		toggleToolExpansion: () => {
			const nowMs = Date.now();
			const isDoubleTap = lastToolExpandAtMs > 0 && nowMs - lastToolExpandAtMs <= CTRL_C_DOUBLE_TAP_MS;
			lastToolExpandAtMs = nowMs;
			const changed = isDoubleTap ? chatPanel.toggleAllToolsExpanded() : chatPanel.toggleLastToolExpanded();
			if (changed) tui.requestRender();
		},
		toggleAllToolExpansion: () => {
			if (chatPanel.toggleAllToolsExpanded()) tui.requestRender();
		},
		toggleLiveToolOutput: () => {
			chatPanel.toggleLiveToolOutput();
			tui.requestRender();
		},
		toggleThinkingExpansion: () => {
			const nowMs = Date.now();
			const isDoubleTap = lastThinkingExpandAtMs > 0 && nowMs - lastThinkingExpandAtMs <= CTRL_C_DOUBLE_TAP_MS;
			lastThinkingExpandAtMs = nowMs;
			const changed = isDoubleTap ? chatPanel.toggleAllThinking() : chatPanel.toggleLastThinking();
			if (changed) tui.requestRender();
		},
		toggleAllThinkingExpansion: () => {
			if (chatPanel.toggleAllThinking()) tui.requestRender();
		},
		openExternalEditor: () => {
			openExternalEditorForInput();
		},
		queueFollowUp: () => {
			queueFollowUpFromEditor();
		},
		restoreQueuedFollowUps: () => {
			restoreQueuedFollowUpsToEditor();
		},
	});

	const interactiveSubscriptions = createInteractiveSubscriptions({
		bus: deps.bus,
		refreshFooter: () => footer.refresh(),
		renderTaskIsland: interactiveTickers.renderTaskIsland,
		renderContextIsland: interactiveTickers.renderContextIsland,
		requestRender: () => tui.requestRender(),
		notify,
	});

	tui.addInputListener((data: string) => {
		// A modal invalidates any half-entered leader sequence. Otherwise the key
		// used to close /agents could become the first half of a shortcut after the
		// overlay closes.
		if (overlayOwnsInput(overlayLifecycle.getState()) && leaderKeys.isPending()) leaderKeys.reset();
		// A pending leader sequence belongs to the main editor, never an overlay.
		// Modal input must win before leader/agent cancellation precedence.
		if (!overlayOwnsInput(overlayLifecycle.getState()) && leaderKeys.isPending()) {
			if (leaderKeys.route(data)) return { consume: true };
		}

		if (isCtrlCKey(data)) {
			handleCtrlC();
			return { consume: true };
		}

		const overlayConsumed = routeOverlayKey(
			data,
			overlayLifecycle.getState(),
			{
				cancelPermission: () => {
					closeOverlay();
				},
				confirmPermission: () => overlayLifecycle.confirmPermission(),
				closeOverlay,
				selectPreviousDispatch: () => {
					dispatchBoard.selectPrevious();
					tui.requestRender();
				},
				selectNextDispatch: () => {
					dispatchBoard.selectNext();
					tui.requestRender();
				},
				steerSelectedDispatch,
				cancelSelectedDispatch,
				cancelAskUser: () => overlayLifecycle.cancelAskUser(),
			},
			(input, id) => keybindings.matches(input, id),
		);
		if (overlayConsumed) {
			return { consume: true };
		}
		// A false route result means the focused overlay component owns the full
		// keymap. Do not let its key fall through to editor shortcuts, bash abort,
		// or cancellation of the active agent run.
		if (overlayOwnsInput(overlayLifecycle.getState())) return undefined;

		if (overlayLifecycle.getState() === "closed") {
			if (leaderKeys.route(data)) return { consume: true };
		}

		// With no overlay, Esc cancels an active run (or an inline bash command).
		// The modal boundary above is intentional: an overlay's Esc is delivered to
		// its focused component and can never abort work behind the overlay.
		if (isEscapeKey(data) && editorSubmit.cancelActiveEditorBash()) {
			return { consume: true };
		}
		if (isEscapeKey(data) && deps.chat.isStreaming()) {
			cancelActiveRun();
			return { consume: true };
		}

		if (overlayLifecycle.getState() === "closed" && !isKeyRelease(data)) {
			for (const id of [
				"clio.notifications.dismiss",
				"clio.tool.expand",
				"clio.tool.expandAll",
				"clio.tool.liveOutput",
				"clio.editor.external",
				"clio.message.followUp",
				"clio.message.dequeue",
				"clio.thinking.expand",
				"clio.thinking.expandAll",
			] as const) {
				if (keybindings.matches(data, id)) {
					dispatchInteractiveAction(id, keyActionDeps());
					return { consume: true };
				}
			}
		}

		const consumed = routeInteractiveKey(data, keyActionDeps());
		return consumed ? { consume: true } : undefined;
	});

	return run;
}
