import { exec } from "node:child_process";
import { resolve } from "node:path";
import { runBashCommand } from "../core/bash-exec.js";
import { BusChannels } from "../core/bus-events.js";
import type { ClioSettings } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { expandInlineFileReferences, expandInlineFileReferencesAsync } from "../core/file-references.js";
import { type SkillActivation, skillActivationFromSource } from "../core/skill-activation.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import { isUserVisibleAgent } from "../domains/agents/spec.js";
import type { ClioKeybinding } from "../domains/config/keybindings.js";
import type { ContextState } from "../domains/context/index.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { ExtensionsContract } from "../domains/extensions/index.js";
import type { ObservabilityContract } from "../domains/observability/index.js";
import {
	getRuntimeRegistry,
	type ProvidersContract,
	resolveModelRuntimeCapabilitiesForProviders,
	resolveProviderReference,
	type ThinkingLevel,
	targetRequiresAuth,
} from "../domains/providers/index.js";
import type { ResourcesContract } from "../domains/resources/index.js";
import type { ClassifierCall } from "../domains/safety/action-classifier.js";
import type { SafetyDecision } from "../domains/safety/contract.js";
import { resolveSessionCwd } from "../domains/session/cwd-fallback.js";
import type { SessionContract, SessionEntry } from "../domains/session/index.js";
import { probeGit, probeWorkspace } from "../domains/session/workspace/index.js";
import type { ShareContract } from "../domains/share/index.js";
import type { OAuthSelectPrompt } from "../engine/oauth.js";
import { openSession } from "../engine/session.js";
import {
	createAgentProgress,
	isKeyRelease,
	type KeyId,
	matchesKey,
	ProcessTerminal,
	type SelectItem,
	Text,
	TUI,
	visibleWidth,
} from "../engine/tui.js";
import type { ImageContent } from "../engine/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ChatLoop } from "./chat-loop.js";
import { createChatPanel } from "./chat-panel.js";
import {
	buildReplayAgentMessagesFromTurns,
	createCoalescingChatRenderer,
	rehydrateChatPanelFromTurns,
	renderBashExecutionEntry,
} from "./chat-renderer.js";
import { ClioEditor } from "./clio-editor.js";
import { createCommandOutputRunIo } from "./command-output.js";
import { openContextOverlay } from "./context-overlay.js";
import { openCostOverlay } from "./cost-overlay.js";
import { createDispatchBoardStore, formatDispatchBoardLines, formatTaskIslandLines } from "./dispatch-board.js";
import { bashExecutionEntryInput, parseEditorBashCommand } from "./editor-bash.js";
import { editTextExternally, resolveExternalEditor } from "./external-editor.js";
import { createFollowUpQueuePanel } from "./follow-up-queue-panel.js";
import { buildFooterDashboard, type FooterDashboardPanel } from "./footer/dashboard.js";
import { classifyNoticeLevel, createNotificationCenter } from "./footer/notifications.js";
import { createKeybindingManager } from "./keybinding-manager.js";
import { buildLayout } from "./layout.js";
import { showClioOverlayFrame } from "./overlay-frame.js";
import { openAuthDialog } from "./overlays/auth-dialog.js";
import { openAuthSelectorOverlay } from "./overlays/auth-selector.js";
import { openCwdFallbackOverlay } from "./overlays/cwd-fallback.js";
import { openHotkeysOverlay } from "./overlays/hotkeys.js";
import { openMessagePickerOverlay } from "./overlays/message-picker.js";
import { openModelOverlay } from "./overlays/model-selector.js";
import { extractScopeFromSettings, openScopedOverlay } from "./overlays/scoped-models.js";
import { openSessionOverlay } from "./overlays/session-selector.js";
import { openSettingsOverlay } from "./overlays/settings.js";
import {
	openThinkingOverlay,
	readThinkingLevel,
	resolveAvailableThinkingLevels,
	resolveThinkingCapability,
	resolveThinkingLabeler,
} from "./overlays/thinking-selector.js";
import { openTreeOverlay } from "./overlays/tree-selector.js";
import { createPermissionOverlayBody, PERMISSION_OVERLAY_WIDTH, permissionOverlayTitle } from "./permission-overlay.js";
import { openProvidersOverlay } from "./providers-overlay.js";
import { openReceiptsOverlay, verifyReceiptFile } from "./receipts-overlay.js";
import { createSlashCommandAutocompleteProvider } from "./slash-autocomplete.js";
import {
	type ContextClearCommandOptions,
	dispatchSlashCommand,
	type InitCommandOptions,
	parseSlashCommand,
	type RunIo,
	type SlashCommandContext,
} from "./slash-commands.js";
import { createStatusController, resolveInlineVerb, spinnerFrame, type TurnSummary } from "./status/index.js";
import { abbreviateModelId } from "./theme/index.js";
import { createWelcomeDashboard } from "./welcome-dashboard.js";

// Re-exports preserve the public surface for diag scripts that import these
// names from "interactive/index.js". Slice 2.6 relocated the implementations
// into slash-commands.ts.
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
	 * `cancelParkedCalls` so blocked bash batches run (or reject cleanly)
	 * after the permission decision rather than stalling indefinitely.
	 */
	toolRegistry?: ToolRegistry;
	session?: SessionContract;
	/** Read current session entries for replay/context rebuilds after local non-chat entries. */
	readSessionEntries?: () => ReadonlyArray<SessionEntry>;
	/** XDG data dir (clioDataDir()). `/receipts verify` reads from <dataDir>/receipts/<id>.json. */
	dataDir: string;
	/**
	 * Resolver for the current `workers.default` block. `/run` uses this to
	 * short-circuit with an actionable error when no provider is configured
	 * instead of letting the dispatch throw with no config context.
	 */
	getWorkerDefault?: () => { endpoint?: string; model?: string } | undefined;
	/**
	 * Resolver for current settings. Footer reads the orchestrator target
	 * (what chat actually dispatches to) rather than the providers catalog's
	 * first-available entry.
	 */
	getSettings?: () => Readonly<ClioSettings>;
	/** Optional resolver for the active session id used as the cost overlay title suffix. */
	getSessionId?: () => string | null;
	/** Live CLIO.md and memory state for the footer Context quadrant. */
	getContextState?: (cwd?: string) => ContextState;
	/** Persist a thinking level chosen in the /thinking overlay. */
	onSetThinkingLevel?: (level: ThinkingLevel) => void;
	/** Persist the next thinking level when Shift+Tab is pressed. */
	onCycleThinking?: () => void;
	/** Persist the orchestrator target selected in /model. */
	onSelectModel?: (ref: { endpoint: string; model: string }) => void;
	/** Persist the next `provider.scope` list committed in /scoped-models. */
	onSetScope?: (scope: string[]) => void;
	/** Write handler the /settings overlay uses to persist cycled values. */
	writeSettings?: (next: ClioSettings) => void;
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
	 * engine, and persists a compactionSummary entry. Slice 12c ships the
	 * hook; 12d adds the auto-trigger and overflow-recovery path.
	 */
	onCompact?: (instructions: string | undefined) => Promise<void>;
	/** Run /context-init for the current working directory. */
	onInit?: (options: InitCommandOptions) => Promise<void>;
	/** Run /context-clear for the current working directory. */
	onContextClear?: (options: ContextClearCommandOptions) => Promise<void>;
	/** Advance the orchestrator target one step forward through `provider.scope`. */
	onCycleScopedModelForward?: () => void;
	/** Advance the orchestrator target one step backward through `provider.scope`. */
	onCycleScopedModelBackward?: () => void;
	onShutdown: () => Promise<void>;
}

export const CTRL_C_DOUBLE_TAP_MS = 500;
export const ENTER = "\r";
export const ESC = "\x1b";
const EDITOR_BASH_TIMEOUT_MS = 300_000;

export interface InteractiveSubmitExpansion {
	text: string;
	images: ImageContent[];
	skillActivations: SkillActivation[];
}

export function expandInteractiveSubmit(
	text: string,
	resources: ResourcesContract | undefined,
	cwd = process.cwd(),
): InteractiveSubmitExpansion {
	const skillExpansion = resources?.expandSkillInvocation(text, cwd);
	const skillText = skillExpansion?.expanded ? skillExpansion.text : text;
	const skillActivations = skillExpansion?.expanded
		? [skillActivationFromSource(skillExpansion.skill, "slash-command")]
		: [];
	const promptExpansion = resources?.expandPromptTemplate(skillText, cwd);
	const promptText = promptExpansion?.expanded ? promptExpansion.text : skillText;
	const fileExpansion = expandInlineFileReferences(promptText, { cwd, includeImages: true, missing: "leave" });
	return { text: fileExpansion.text, images: fileExpansion.images, skillActivations };
}

export async function expandInteractiveSubmitAsync(
	text: string,
	resources: ResourcesContract | undefined,
	cwd = process.cwd(),
): Promise<InteractiveSubmitExpansion> {
	const skillExpansion = resources?.expandSkillInvocation(text, cwd);
	const skillText = skillExpansion?.expanded ? skillExpansion.text : text;
	const skillActivations = skillExpansion?.expanded
		? [skillActivationFromSource(skillExpansion.skill, "slash-command")]
		: [];
	const promptExpansion = resources?.expandPromptTemplate(skillText, cwd);
	const promptText = promptExpansion?.expanded ? promptExpansion.text : skillText;
	const fileExpansion = await expandInlineFileReferencesAsync(promptText, {
		cwd,
		includeImages: true,
		missing: "leave",
	});
	return { text: fileExpansion.text, images: fileExpansion.images, skillActivations };
}

export function expandInteractiveSubmitText(
	text: string,
	resources: ResourcesContract | undefined,
	cwd = process.cwd(),
): string {
	return expandInteractiveSubmit(text, resources, cwd).text;
}

export type OverlayState =
	| "closed"
	| "permission-confirm"
	| "dispatch-board"
	| "providers"
	| "auth"
	| "cost"
	| "context-view"
	| "receipts"
	| "thinking"
	| "model"
	| "scoped-models"
	| "settings"
	| "resume"
	| "tree"
	| "message-picker"
	| "cwd-fallback"
	| "hotkeys";

export interface KeyBindingDeps {
	/**
	 * Keybinding lookup injected by startInteractive. Defaults come from
	 * CLIO_KEYBINDINGS; user overrides from settings.keybindings. Tests may
	 * substitute a narrower matcher via createKeybindingManagerForTesting.
	 */
	matches: (data: string, id: ClioKeybinding) => boolean;
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
	toggleThinkingExpansion: () => void;
	openExternalEditor: () => void;
	queueFollowUp: () => void;
	restoreQueuedFollowUps: () => void;
}

export interface LeaderTarget {
	key: string;
	id: ClioKeybinding;
}

export type LeaderKeyState = { status: "idle" } | { status: "pending"; expiresAt: number };

export interface LeaderKeyDeps extends KeyBindingDeps {
	matchesLeader: (data: string) => boolean;
	leaderTargets: ReadonlyArray<LeaderTarget>;
	now: number;
	timeoutMs?: number;
	isRelease?: (data: string) => boolean;
}

export interface LeaderKeyRouteResult {
	state: LeaderKeyState;
	consumed: boolean;
}

export const LEADER_TIMEOUT_MS = 1500;
export const IDLE_LEADER_STATE: LeaderKeyState = { status: "idle" };

export interface PermissionOverlayKeyDeps {
	cancelPermission: () => void;
	confirmPermission: () => void;
}

export interface DispatchBoardOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface StatusOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface ProvidersOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface AuthOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface CostOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface ReceiptsOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface ThinkingOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface ModelOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface ScopedModelsOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface SettingsOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface ResumeOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface TreeOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface MessagePickerOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface CwdFallbackOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface HotkeysOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface OverlayKeyDeps
	extends PermissionOverlayKeyDeps,
		DispatchBoardOverlayKeyDeps,
		ProvidersOverlayKeyDeps,
		AuthOverlayKeyDeps,
		CostOverlayKeyDeps,
		ReceiptsOverlayKeyDeps,
		ThinkingOverlayKeyDeps,
		ModelOverlayKeyDeps,
		ScopedModelsOverlayKeyDeps,
		SettingsOverlayKeyDeps,
		ResumeOverlayKeyDeps,
		TreeOverlayKeyDeps,
		MessagePickerOverlayKeyDeps,
		CwdFallbackOverlayKeyDeps,
		HotkeysOverlayKeyDeps {
	requestShutdown: () => void;
}

export type CtrlCAction = "cancel-stream" | "close-overlay" | "clear-editor" | "arm-shutdown" | "shutdown";

export interface CtrlCActionDeps {
	overlayState: OverlayState;
	streaming: boolean;
	editorText: string;
	lastCtrlCAt: number;
	now: number;
}

export function isCtrlCKey(data: string): boolean {
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
	if (deps.lastCtrlCAt > 0 && deps.now - deps.lastCtrlCAt <= CTRL_C_DOUBLE_TAP_MS) {
		return "shutdown";
	}
	if (deps.streaming) return "cancel-stream";
	if (deps.overlayState !== "closed") return "close-overlay";
	if (deps.editorText.length > 0) return "clear-editor";
	return "arm-shutdown";
}

function baseLetterFromInput(data: string): string | null {
	if (data.length === 1) {
		const lower = data.toLowerCase();
		return lower >= "a" && lower <= "z" ? lower : null;
	}
	for (let code = 97; code <= 122; code += 1) {
		const key = String.fromCharCode(code) as KeyId;
		if (matchesKey(data, key) || matchesKey(data, `shift+${key}` as KeyId)) return key;
	}
	return null;
}

export function dispatchInteractiveAction(id: ClioKeybinding, deps: KeyBindingDeps): boolean {
	switch (id) {
		case "clio.notifications.dismiss":
			deps.dismissNotifications();
			return true;
		case "clio.tool.expand":
			deps.toggleToolExpansion();
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

/** Pure leader-key router: returns the next leader state and whether input was swallowed. */
export function routeLeaderKey(data: string, state: LeaderKeyState, deps: LeaderKeyDeps): LeaderKeyRouteResult {
	const timeoutMs = deps.timeoutMs ?? LEADER_TIMEOUT_MS;
	if (state.status === "pending") {
		if (deps.now > state.expiresAt) return { state: IDLE_LEADER_STATE, consumed: true };
		if (deps.isRelease?.(data) ?? false) return { state, consumed: true };
		if (matchesKey(data, "escape")) return { state: IDLE_LEADER_STATE, consumed: true };
		const base = baseLetterFromInput(data);
		const target = base ? deps.leaderTargets.find((entry) => entry.key === base) : undefined;
		if (target) {
			dispatchInteractiveAction(target.id, deps);
			return { state: IDLE_LEADER_STATE, consumed: true };
		}
		return { state: IDLE_LEADER_STATE, consumed: true };
	}
	if (deps.isRelease?.(data) ?? false) return { state, consumed: false };
	if (!deps.matchesLeader(data)) return { state, consumed: false };
	return { state: { status: "pending", expiresAt: deps.now + timeoutMs }, consumed: true };
}

/** Pure permission overlay key router: returns true when the input was consumed. */
export function routePermissionOverlayKey(data: string, deps: PermissionOverlayKeyDeps): boolean {
	if (data === ENTER) {
		deps.confirmPermission();
		return true;
	}
	if (data === ESC) {
		deps.cancelPermission();
		return true;
	}
	return false;
}

/** Pure overlay key router for the dispatch board. */
export function routeDispatchBoardOverlayKey(data: string, deps: DispatchBoardOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/** Legacy pure router for the retired status overlay shape. Runtime /status now toggles the footer dashboard. */
export function routeStatusOverlayKey(data: string, deps: StatusOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/** Pure overlay key router for the target status overlay. Esc closes; everything else is swallowed. */
export function routeProvidersOverlayKey(data: string, deps: ProvidersOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/** Pure overlay key router for auth overlays. Esc closes; input handles Enter itself. */
export function routeAuthOverlayKey(data: string, deps: AuthOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/** Pure overlay key router for the /cost overlay. Esc closes; everything else is swallowed. */
export function routeCostOverlayKey(data: string, deps: CostOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/**
 * Pure overlay key router for the /receipts overlay. Esc closes. Every other
 * key is left untouched so the Box-wrapped SelectList can handle Up/Down/Enter
 * through the TUI's focused-component pipeline.
 */
export function routeReceiptsOverlayKey(data: string, deps: ReceiptsOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/**
 * Pure overlay key router for the /thinking overlay. Same policy as receipts:
 * Esc closes; arrows and Enter fall through to the focused SelectList.
 */
export function routeThinkingOverlayKey(data: string, deps: ThinkingOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/**
 * Pure overlay key router for the /model overlay. Same policy as thinking:
 * Esc closes; arrows and Enter fall through to the focused SelectList.
 */
export function routeModelOverlayKey(data: string, deps: ModelOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/**
 * Pure overlay key router for the /scoped-models overlay. Esc closes; Space
 * toggles inclusion and Enter commits, both handled inside ScopedOverlayBox.
 */
export function routeScopedModelsOverlayKey(data: string, deps: ScopedModelsOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/**
 * Pure overlay key router for the /settings overlay. Esc closes; every other
 * key falls through to the focused SettingsList for cycling and search.
 */
export function routeSettingsOverlayKey(data: string, deps: SettingsOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/**
 * Pure overlay key router for the /resume overlay. The session selector owns
 * Esc because it buffers raw escape bytes long enough to distinguish a real
 * Escape key from a latency-split arrow sequence.
 */
export function routeResumeOverlayKey(_data: string, _deps: ResumeOverlayKeyDeps): boolean {
	return false;
}

/**
 * Pure overlay key router for the /tree overlay. Esc is intentionally NOT
 * consumed here because the overlay runs in three submodes (browse,
 * edit-label, confirm-delete) and Esc cancels a submode before it closes the
 * overlay. TreeOverlayBox.handleInput calls the onClose dep itself when Esc
 * is pressed in browse mode; every other key also falls through to the Box.
 */
export function routeTreeOverlayKey(_data: string, _deps: TreeOverlayKeyDeps): boolean {
	return false;
}

/**
 * Pure overlay key router for the /fork message-picker. Esc closes; arrows
 * and Enter fall through to the focused SelectList (same policy as /resume).
 */
export function routeMessagePickerOverlayKey(data: string, deps: MessagePickerOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/**
 * Pure overlay key router for the cwd-fallback overlay. Esc is intentionally
 * NOT consumed here: the SelectList inside the overlay owns its own
 * cancel-on-Esc handling and routes it through onCancel, which restores the
 * prior session via switchBranch (or reopens /resume when there was no prior
 * session). Intercepting Esc at the router level bypassed that path and left
 * the user inside the broken-cwd session; the SelectList's handler is the
 * single source of truth for Cancel. Mirrors routeTreeOverlayKey.
 */
export function routeCwdFallbackOverlayKey(_data: string, _deps: CwdFallbackOverlayKeyDeps): boolean {
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

export function handleCwdFallbackCancel(preResumeSessionId: string | null, deps: CwdFallbackCancelDeps): void {
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

/** Pure overlay key router for the /hotkeys overlay. Esc closes; list keys fall through to the focused view. */
export function routeHotkeysOverlayKey(data: string, deps: HotkeysOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return false;
}

/** Overlay inputs always stay inside the overlay except for the exit keybinding (default ctrl+d). */
export function routeOverlayKey(
	data: string,
	overlayState: OverlayState,
	deps: OverlayKeyDeps,
	matches: (data: string, id: ClioKeybinding) => boolean,
): boolean {
	if (overlayState === "closed") return false;
	if (matches(data, "clio.exit")) {
		deps.requestShutdown();
		return true;
	}
	if (overlayState === "permission-confirm") {
		routePermissionOverlayKey(data, deps);
		return true;
	}
	if (overlayState === "providers") {
		routeProvidersOverlayKey(data, deps);
		return true;
	}
	if (overlayState === "auth") {
		return routeAuthOverlayKey(data, deps);
	}
	if (overlayState === "cost") {
		routeCostOverlayKey(data, deps);
		return true;
	}
	if (overlayState === "context-view") {
		// Read-only overlay; same policy as /cost: Esc closes, all else swallowed.
		routeCostOverlayKey(data, deps);
		return true;
	}
	if (overlayState === "receipts") {
		// Do not swallow arrow keys or Enter; the focused SelectList needs them.
		return routeReceiptsOverlayKey(data, deps);
	}
	if (overlayState === "thinking") {
		// Same policy as receipts: the Box forwards unconsumed input to the SelectList.
		return routeThinkingOverlayKey(data, deps);
	}
	if (overlayState === "model") {
		// Same policy as thinking: the Box forwards unconsumed input to the SelectList.
		return routeModelOverlayKey(data, deps);
	}
	if (overlayState === "scoped-models") {
		// The ScopedOverlayBox owns Space and Enter; route only Esc here.
		return routeScopedModelsOverlayKey(data, deps);
	}
	if (overlayState === "settings") {
		// SettingsList owns Enter/Space/search; route only Esc here.
		return routeSettingsOverlayKey(data, deps);
	}
	if (overlayState === "resume") {
		// Session selector owns Esc, arrows, Enter, and search input.
		return routeResumeOverlayKey(data, deps);
	}
	if (overlayState === "tree") {
		// TreeOverlayBox owns its full keymap including Esc (submode-aware);
		// routeTreeOverlayKey is a no-op stub kept for shape symmetry.
		return routeTreeOverlayKey(data, deps);
	}
	if (overlayState === "message-picker") {
		// SelectList owns arrows and Enter; route only Esc here.
		return routeMessagePickerOverlayKey(data, deps);
	}
	if (overlayState === "cwd-fallback") {
		// SelectList owns its full keymap including Esc (cancel parity);
		// routeCwdFallbackOverlayKey is a no-op stub kept for shape symmetry.
		return routeCwdFallbackOverlayKey(data, deps);
	}
	if (overlayState === "hotkeys") {
		return routeHotkeysOverlayKey(data, deps);
	}
	// Dispatch-board branch (fall-through). The overlay has no focused
	// child that needs arrow/Enter, so we consume the dispatchBoard.toggle
	// keybinding here as "close" so Ctrl+B works as a symmetric toggle,
	// and Esc still closes via routeDispatchBoardOverlayKey.
	if (matches(data, "clio.dispatchBoard.toggle")) {
		deps.closeOverlay();
		return true;
	}
	routeDispatchBoardOverlayKey(data, deps);
	return true;
}

export async function startInteractive(deps: InteractiveDeps): Promise<number> {
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);

	// Build the runtime keybinding manager from the current settings snapshot.
	// This also installs the manager as pi-tui's global (via setKeybindings)
	// so editor/select components honor overrides without explicit plumbing.
	const keybindings = createKeybindingManager(deps.getSettings?.() ?? ({ keybindings: {} } as ClioSettings));

	const bootWorkspace = probeWorkspace(process.cwd());
	let liveWorkspaceSnapshot: ReturnType<typeof probeWorkspace> = deps.session?.current()?.workspace ?? bootWorkspace;
	let lastWorkspaceProbeAt = 0;
	const refreshLiveWorkspaceGit = (force = false): void => {
		const base = deps.session?.current()?.workspace ?? bootWorkspace;
		if (!force && Date.now() - lastWorkspaceProbeAt < 5_000) return;
		lastWorkspaceProbeAt = Date.now();
		if (!base.isGit) {
			liveWorkspaceSnapshot = base;
			return;
		}
		const git = probeGit(base.cwd);
		liveWorkspaceSnapshot = {
			...base,
			branch: git.branch,
			dirty: git.dirty,
			ahead: git.ahead,
			behind: git.behind,
			recentCommits: git.recentCommits,
		};
	};
	const getLiveWorkspaceSnapshot = (): typeof liveWorkspaceSnapshot => {
		const base = deps.session?.current()?.workspace ?? bootWorkspace;
		if (liveWorkspaceSnapshot.cwd !== base.cwd || liveWorkspaceSnapshot.capturedAt !== base.capturedAt) {
			liveWorkspaceSnapshot = base;
			refreshLiveWorkspaceGit(true);
		}
		return liveWorkspaceSnapshot;
	};
	refreshLiveWorkspaceGit(true);

	let sessionCounter = {
		id: deps.session?.current()?.id ?? deps.getSessionId?.() ?? null,
		baseTurns: deps.session?.current()?.messageCount ?? 0,
		submittedTurns: 0,
	};
	const syncSessionCounter = (): void => {
		const meta = deps.session?.current();
		const id = meta?.id ?? deps.getSessionId?.() ?? null;
		if (id === sessionCounter.id) return;
		const baseTurns = meta?.messageCount ?? 0;
		const previousProjected = sessionCounter.baseTurns + sessionCounter.submittedTurns;
		const carryPending = sessionCounter.id === null ? Math.max(0, previousProjected - baseTurns) : 0;
		sessionCounter = { id, baseTurns, submittedTurns: carryPending };
	};
	const recordSubmittedTurn = (): void => {
		syncSessionCounter();
		sessionCounter = { ...sessionCounter, submittedTurns: sessionCounter.submittedTurns + 1 };
	};
	const liveSessionTurns = (): number | null => {
		syncSessionCounter();
		const metaTurns = deps.session?.current()?.messageCount;
		const projected = sessionCounter.baseTurns + sessionCounter.submittedTurns;
		return typeof metaTurns === "number" ? Math.max(metaTurns, projected) : projected > 0 ? projected : null;
	};

	const banner = createWelcomeDashboard({
		providers: deps.providers,
		observability: deps.observability,
		getContextUsage: () => deps.chat.contextUsage(),
		getWorkspaceSnapshot: () => deps.session?.current()?.workspace ?? bootWorkspace,
		getExtensionStats: () => {
			const items = deps.extensions?.list(process.cwd(), { all: true }) ?? [];
			return {
				active: items.filter((entry) => entry.enabled && entry.effective).length,
				installed: items.length,
			};
		},
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
	const dispatchBoardStore = createDispatchBoardStore(deps.bus);
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
	let footer: FooterDashboardPanel;
	const dismissKeyLabel = formatKeyLabel(keybindings.getKeys("clio.notifications.dismiss")[0]);
	const notifications = createNotificationCenter({
		onChange: () => {
			footer?.refresh();
			tui.requestRender();
		},
	});
	const notify = (level: "info" | "warning" | "error", text: string, key?: string): void => {
		notifications.add(key ? { level, text, key } : { level, text });
	};
	footer = buildFooterDashboard({
		providers: deps.providers,
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		getAgentStatus: () => statusController.current(),
		getTerminalColumns: () => terminal.columns,
		getSessionTokens: () => deps.observability.sessionTokens(),
		getTokenThroughput: () => deps.observability.latestTokenThroughput(),
		getSessionCost: () => deps.observability.sessionCost(),
		getContextUsage: () => deps.chat.contextUsage(),
		getContextLedger: () => deps.chat.contextLedger(),
		getDispatchRows: () => dispatchBoardStore.rows(),
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
		getExtensionStats: () => {
			const items = deps.extensions?.list(process.cwd(), { all: true }) ?? [];
			return {
				active: items.filter((entry) => entry.enabled && entry.effective).length,
				installed: items.length,
			};
		},
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
	const editor = new ClioEditor(tui, {
		getModelLabel: () => {
			const settings = deps.getSettings?.();
			const model = settings?.orchestrator?.model?.trim();
			if (!model) return "no model";
			const endpoint = settings?.orchestrator?.endpoint?.trim();
			const abbreviated = abbreviateModelId(model);
			return endpoint ? `${endpoint}·${abbreviated}` : abbreviated;
		},
		getThinkingLabel: () => {
			const settings = deps.getSettings?.();
			return (
				resolveModelRuntimeCapabilitiesForProviders(
					deps.providers,
					settings?.orchestrator?.endpoint,
					settings?.orchestrator?.model,
					settings?.orchestrator?.thinkingLevel ?? "off",
				)?.thinking.display ??
				settings?.orchestrator?.thinkingLevel ??
				"off"
			);
		},
	});
	editor.focused = true;
	editor.setAutocompleteProvider(createSlashCommandAutocompleteProvider());

	// The permission overlay is rebuilt per open because its body depends on
	// the parked tool call.
	const dispatchBoard = new Text(formatDispatchBoardLines(dispatchBoardStore.rows(), 76).join("\n"), 0, 0);
	const taskIsland = new Text("", 0, 0);
	const taskIslandWidth = formatTaskIslandLines([]).reduce((max, line) => Math.max(max, visibleWidth(line)), 0);

	const chatRenderer = createCoalescingChatRenderer({
		chatPanel,
		requestRender: () => tui.requestRender(),
	});

	const io: RunIo = createCommandOutputRunIo({
		appendReplayBlock: (renderBlock) => chatPanel.appendReplayBlock(renderBlock),
		requestRender: () => tui.requestRender(),
	});
	// Boot hints (CLIO.md state, keybinding diagnostics) route into the
	// NotificationCenter, not the transcript, so they stay out of scrollback.
	for (const notice of deps.initialNotices ?? []) {
		const text = notice.trim();
		if (text.length === 0) continue;
		const key = text.toLowerCase().includes("keybinding notice") ? "startup:keybinding-notice" : text;
		notify(classifyNoticeLevel(text), text, key);
	}
	const unsubscribeChat = deps.chat.onEvent((event) => {
		if (event.type === "queue_update") {
			followUpQueuePanel.setMessages(event.followUp);
			tui.requestRender();
			return;
		}
		if (event.type === "tool_execution_start") {
			if (event.toolName.toLowerCase() === "dispatch") {
				chatRenderer.applyEvent(event);
				return;
			}
			footerActiveTools.add(event.toolCallId);
			const current = footerToolCounts.get(event.toolName) ?? 0;
			footerToolCounts.set(event.toolName, current + 1);
			footer.refresh();
		} else if (event.type === "tool_execution_end") {
			if (event.toolName.toLowerCase() === "dispatch") {
				chatRenderer.applyEvent(event);
				return;
			}
			footerActiveTools.delete(event.toolCallId);
			if (event.isError) footerToolErrors += 1;
			const summary = (event as { resultSummary?: { truncated?: unknown } }).resultSummary;
			if (summary?.truncated === true) footerToolTruncatedResults += 1;
			footer.refresh();
		}
		chatRenderer.applyEvent(event);
	});
	let statusInlineFrame = 0;
	const unsubscribeStatus = statusController.subscribe((status) => {
		if (status.phase === "idle") {
			chatPanel.setStatusLine(null);
		} else if (status.phase === "ended") {
			// Park the completed turn's metrics on the footer rather than printing
			// a faint summary line under the reply. Keeps the transcript calm.
			chatPanel.setStatusLine(null);
			if (status.summary) lastTurnSummary = status.summary;
		} else {
			const verb = resolveInlineVerb(status, Date.now(), terminal.columns);
			if (verb) {
				const frame = terminal.columns < 30 ? "" : `${spinnerFrame(statusInlineFrame)} `;
				chatPanel.setStatusLine({ phase: status.phase, verb: `${frame}${verb.text}`, toneHint: verb.toneHint });
				statusInlineFrame = (statusInlineFrame + 1) % 10;
			} else {
				chatPanel.setStatusLine(null);
			}
		}
		footer.refresh();
		tui.requestRender();
	});
	// OSC 9;4 indeterminate progress around each agent turn. pi-tui 0.78.1
	// exposes Terminal.setProgress; the engine helper wraps it so start/stop
	// are idempotent and unit-testable.
	const agentProgress = createAgentProgress(terminal);
	const unsubscribeProgress = deps.chat.onEvent((event) => {
		const settings = deps.getSettings?.();
		const showProgress = settings?.terminal.showTerminalProgress ?? false;
		if (event.type === "agent_start" && showProgress) agentProgress.start();
		else if (event.type === "agent_end") agentProgress.stop();
	});
	const unsubscribeAbortedProgress = deps.bus.on(BusChannels.RunAborted, () => {
		agentProgress.stop();
	});
	// Repaint the footer whenever an assistant message completes so the
	// running `in:/out:` token counters reflect the latest usage. The
	// existing 120ms ticker only refreshes while streaming, which means the
	// final frame after a turn ends would otherwise be stale.
	const unsubscribeFooterTokens = deps.chat.onEvent((event) => {
		if (event.type !== "message_end" && event.type !== "agent_end") return;
		if (event.type === "agent_end") refreshLiveWorkspaceGit(true);
		footer.refresh();
		tui.requestRender();
	});
	const unsubscribeContextPressure = deps.bus.on(BusChannels.ContextWarning, () => {
		footer.refresh();
		tui.requestRender();
	});
	const unsubscribeContextPruned = deps.bus.on(BusChannels.ContextPruned, () => {
		footer.refresh();
		tui.requestRender();
	});

	let activeEditorBash: AbortController | null = null;

	const ensureSessionForLocalEntry = (): void => {
		if (!deps.session || deps.session.current()) return;
		const settings = deps.getSettings?.();
		const input: { cwd: string; endpoint?: string; model?: string } = { cwd: process.cwd() };
		if (settings?.orchestrator.endpoint) input.endpoint = settings.orchestrator.endpoint;
		if (settings?.orchestrator.model) input.model = settings.orchestrator.model;
		deps.session.create(input);
	};

	const refreshChatContextFromSession = (leafTurnId: string | null): void => {
		if (!deps.readSessionEntries) return;
		const turns = deps.readSessionEntries();
		deps.chat.resetForSession(leafTurnId, buildReplayAgentMessagesFromTurns(turns));
		footer.refresh();
	};

	const runEditorBash = (text: string): boolean => {
		const parsed = parseEditorBashCommand(text);
		if (!parsed) return false;
		if (deps.chat.isStreaming()) {
			io.stderr("[bash] response in progress. Press Esc to cancel the active run before running a local command.\n");
			return true;
		}
		if (activeEditorBash) {
			io.stderr("[bash] command already running. Press Esc to cancel it first.\n");
			return true;
		}
		const abort = new AbortController();
		activeEditorBash = abort;
		let parentTurnId: string | null = null;
		try {
			ensureSessionForLocalEntry();
			parentTurnId = deps.session?.tree().leafId ?? null;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			io.stderr(`[bash] session setup failed: ${msg}\n`);
			activeEditorBash = null;
			return true;
		}

		void (async () => {
			try {
				const result = await runBashCommand(parsed.command, {
					cwd: process.cwd(),
					timeoutMs: EDITOR_BASH_TIMEOUT_MS,
					signal: abort.signal,
				});
				const input = bashExecutionEntryInput({
					command: parsed.command,
					result,
					parentTurnId,
					excludeFromContext: parsed.excludeFromContext,
					timeoutMs: EDITOR_BASH_TIMEOUT_MS,
				});
				const entry = deps.session?.current()
					? deps.session.appendEntry(input)
					: ({ ...input, turnId: "local-bash-preview", timestamp: new Date().toISOString() } as SessionEntry);
				if (entry.kind === "bashExecution") {
					chatPanel.appendReplayBlock((width) => renderBashExecutionEntry(entry, width));
				}
				refreshChatContextFromSession(parentTurnId);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				io.stderr(`[bash] ${msg}\n`);
			} finally {
				if (activeEditorBash === abort) activeEditorBash = null;
				tui.requestRender();
			}
		})();
		return true;
	};

	const openExternalEditorForInput = (): void => {
		const command = resolveExternalEditor();
		if (!command) {
			io.stderr("[editor] no external editor configured; set VISUAL or EDITOR\n");
			return;
		}
		const currentText = editor.getText();
		let result: ReturnType<typeof editTextExternally>;
		try {
			tui.stop();
			result = editTextExternally(currentText, command);
		} finally {
			tui.start();
			tui.requestRender(true);
		}
		if (result.ok) {
			editor.setText(result.text ?? "");
		} else if (result.error) {
			io.stderr(`[editor] ${result.error}\n`);
		}
		tui.requestRender(true);
	};

	const slashCtx: SlashCommandContext = {
		io,
		dispatch: deps.dispatch,
		bus: deps.bus,
		dataDir: deps.dataDir,
		workerDefault: () => deps.getWorkerDefault?.(),
		shutdown: () => {
			void shutdown();
		},
		listPrompts: () => deps.resources?.prompts(process.cwd()) ?? { items: [], diagnostics: [] },
		listSkills: () => deps.resources?.skills(process.cwd()) ?? { items: [], diagnostics: [] },
		listExtensions: () => deps.extensions?.list(process.cwd(), { all: true }) ?? [],
		listAgents: () => deps.agents?.listSpecs().filter(isUserVisibleAgent) ?? [],
		listDelegationAgents: () => deps.getSettings?.().delegation.agents ?? [],
		exportShareArchive: (outPath) => {
			if (!deps.share) throw new Error("share domain is not loaded");
			const path = resolve(outPath);
			const archive = deps.share.writeArchive(path, { scope: "project" });
			return { fileCount: archive.files.length, path };
		},
		importShareArchive: (archivePath, options) => {
			if (!deps.share) {
				return {
					archive: null,
					actions: [],
					diagnostics: [{ type: "error", message: "share domain is not loaded" }],
				};
			}
			const importOptions = {
				...(options.dryRun ? { dryRun: true } : {}),
				...(options.force ? { force: true } : {}),
			};
			return options.dryRun
				? deps.share.planImport(resolve(archivePath), importOptions)
				: deps.share.importArchive(resolve(archivePath), importOptions);
		},
		openProviders: () => openProvidersOverlayState(),
		openConnect: (target) => openConnectOverlayState(target),
		openDisconnect: (target) => openDisconnectOverlayState(target),
		openCost: () => openCostOverlayState(),
		openContextView: () => openContextViewOverlayState(),
		openStatus: () => toggleStatusFooterState(),
		openReceipts: () => openReceiptsOverlayState(),
		openThinking: () => openThinkingOverlayState(),
		openModel: () => openModelOverlayState(),
		providers: deps.providers,
		applyModelRef: (ref) => {
			deps.onSelectModel?.({ endpoint: ref.endpoint, model: ref.model });
			if (ref.thinkingLevel) deps.onSetThinkingLevel?.(ref.thinkingLevel);
			tui.requestRender();
		},
		openScopedModels: () => openScopedModelsOverlayState(),
		openSettings: () => openSettingsOverlayState(),
		openResume: () => openResumeOverlayState(),
		startNewSession: () => startNewSession(),
		openTree: () => openTreeOverlayState(),
		openMessagePicker: () => openMessagePickerOverlayState(),
		openHotkeys: () => openHotkeysOverlayState(),
		runCompact: (instructions) => {
			if (!deps.onCompact) {
				io.stderr("[/compact] compaction not wired; pass onCompact to startInteractive\n");
				return;
			}
			const task = deps.onCompact(instructions);
			void task.catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				io.stderr(`[/compact] ${msg}\n`);
			});
		},
		runInit: (options) => {
			if (!deps.onInit) {
				io.stderr("[/context-init] context-init not wired; pass onInit to startInteractive\n");
				return;
			}
			void deps
				.onInit(options)
				.catch((err) => {
					const msg = err instanceof Error ? err.message : String(err);
					io.stderr(`[/context-init] ${msg}\n`);
				})
				.finally(() => tui.requestRender());
		},
		runContextClear: (options) => {
			if (!deps.onContextClear) {
				io.stderr("[/context-clear] context clear not wired; pass onContextClear to startInteractive\n");
				return;
			}
			if (options.confirmed !== true) {
				const suffix = options.all === true ? " --all --confirm --confirm-all" : " --confirm";
				io.stdout(`[/context-clear] rerun /context-clear${suffix} to remove accumulated context artifacts.\n`);
				return;
			}
			void deps
				.onContextClear(options)
				.catch((err) => {
					const msg = err instanceof Error ? err.message : String(err);
					io.stderr(`[/context-clear] ${msg}\n`);
				})
				.finally(() => tui.requestRender());
		},
		verifyReceipt: (runId) => verifyReceiptFile(deps.dataDir, runId),
		submitChat: (text) => {
			void (async () => {
				try {
					const submitted = await expandInteractiveSubmitAsync(text, deps.resources);
					recordSubmittedTurn();
					footer.refresh();
					chatPanel.appendUser(submitted.text);
					tui.requestRender();
					await deps.chat.submit(submitted.text, {
						...(submitted.images.length > 0 ? { images: submitted.images } : {}),
						...(submitted.skillActivations.length > 0 ? { skillActivations: submitted.skillActivations } : {}),
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					io.stderr(`[interactive] chat failed: ${msg}\n`);
				} finally {
					tui.requestRender();
				}
			})();
		},
		render: () => tui.requestRender(),
	};

	const submitEditorText = (text: string): void => {
		const trimmed = text.trim();
		if (trimmed.length === 0) return;
		const bashCommand = parseEditorBashCommand(text);
		if (bashCommand) {
			if (!deps.chat.isStreaming() && !activeEditorBash) editor.setText("");
			if (runEditorBash(text)) tui.requestRender();
			return;
		}
		editor.setText("");
		dispatchSlashCommand(parseSlashCommand(trimmed), slashCtx);
		tui.requestRender();
	};

	const queueFollowUpFromEditor = (): void => {
		const text = editor.getText().trim();
		if (text.length === 0) return;
		if (!deps.chat.isStreaming()) {
			editor.setText("");
			submitEditorText(text);
			tui.requestRender();
			return;
		}
		void (async () => {
			const submitted = await expandInteractiveSubmitAsync(text, deps.resources);
			if (submitted.images.length > 0) {
				io.stderr("[follow-up] image references cannot be queued while a response is streaming\n");
				return;
			}
			if (!deps.chat.queueFollowUp(submitted.text)) {
				io.stderr("[follow-up] no active response to queue against\n");
				return;
			}
			editor.addToHistory(text);
			editor.setText("");
			tui.requestRender();
		})().catch((err) => {
			const msg = err instanceof Error ? err.message : String(err);
			io.stderr(`[follow-up] ${msg}\n`);
		});
	};

	const restoreQueuedFollowUpsToEditor = (): void => {
		const restored = deps.chat.clearQueuedFollowUps();
		if (restored.length === 0) {
			io.stderr("[follow-up] no queued messages to restore\n");
			return;
		}
		const currentText = editor.getText();
		const queuedText = restored.join("\n\n");
		editor.setText([queuedText, currentText].filter((part) => part.trim().length > 0).join("\n\n"));
		tui.requestRender();
	};

	editor.onSubmit = submitEditorText;

	const root = buildLayout({ banner, chat: chatPanel, pending: followUpQueuePanel, editor, footer: footer.view });
	tui.addChild(root);
	tui.setFocus(editor);
	tui.start();

	let footerTicker: NodeJS.Timeout | null = null;
	footerTicker = setInterval(() => {
		const statusActive = statusController.current().phase !== "idle";
		if (!deps.chat.isStreaming() && !statusActive && !footer.isExpanded()) return;
		footer.refresh();
		tui.requestRender();
	}, 120);
	footerTicker.unref?.();

	let workspaceTicker: NodeJS.Timeout | null = null;
	workspaceTicker = setInterval(() => {
		refreshLiveWorkspaceGit(true);
		footer.refresh();
		tui.requestRender();
	}, 5_000);
	workspaceTicker.unref?.();

	let resolveRun: (code: number) => void = () => {};
	const run = new Promise<number>((resolve) => {
		resolveRun = resolve;
	});

	// Anchor the Node event loop while the TUI is alive. Piped or /dev/null
	// stdin (used by diag harnesses) can close early, which would otherwise
	// let the process exit before the termination coordinator runs.
	const keepAlive = setInterval(() => {}, 1 << 30);

	let overlayState: OverlayState = "closed";
	let overlayHandle: ReturnType<TUI["showOverlay"]> | null = null;
	let authDialogDismiss: (() => void) | null = null;
	let dispatchBoardTicker: ReturnType<typeof setInterval> | null = null;
	let shuttingDown = false;
	let lastCtrlCAt = 0;
	let leaderState: LeaderKeyState = IDLE_LEADER_STATE;
	let leaderTimer: ReturnType<typeof setTimeout> | null = null;
	const setLeaderState = (next: LeaderKeyState): void => {
		leaderState = next;
		if (leaderTimer) {
			clearTimeout(leaderTimer);
			leaderTimer = null;
		}
		if (next.status !== "pending") return;
		leaderTimer = setTimeout(
			() => {
				leaderState = IDLE_LEADER_STATE;
				leaderTimer = null;
			},
			Math.max(0, next.expiresAt - Date.now()),
		);
		leaderTimer.unref?.();
	};
	let pendingPermission: { call: ClassifierCall; decision: SafetyDecision } | null = null;
	let permissionConfirmJustFired = false;
	process.removeAllListeners("SIGINT");
	const taskIslandHandle = tui.showOverlay(taskIsland, {
		anchor: "top-right",
		width: taskIslandWidth,
		margin: { top: 1, right: 1 },
		nonCapturing: true,
		visible: (width, height) => width >= 80 && height >= 18,
	});
	taskIslandHandle.setHidden(true);

	const renderDispatchBoard = (): void => {
		dispatchBoard.setText(formatDispatchBoardLines(dispatchBoardStore.rows(), 76).join("\n"));
		dispatchBoard.invalidate();
	};

	const renderTaskIsland = (): void => {
		const rows = dispatchBoardStore.activeRows();
		taskIslandHandle.setHidden(overlayState !== "closed" || footer.isExpanded() || rows.length === 0);
		taskIsland.setText(formatTaskIslandLines(rows).join("\n"));
		taskIsland.invalidate();
	};

	const stopDispatchBoardTicker = (): void => {
		if (!dispatchBoardTicker) return;
		clearInterval(dispatchBoardTicker);
		dispatchBoardTicker = null;
	};

	const startDispatchBoardTicker = (): void => {
		stopDispatchBoardTicker();
		dispatchBoardTicker = setInterval(() => {
			if (overlayState !== "dispatch-board") return;
			renderDispatchBoard();
			tui.requestRender();
		}, 250);
	};

	const closeOverlay = (): void => {
		if (overlayState === "closed") return;
		const leaving = overlayState;
		if (overlayState === "auth") {
			authDialogDismiss?.();
			authDialogDismiss = null;
		}
		overlayState = "closed";
		stopDispatchBoardTicker();
		overlayHandle?.hide();
		overlayHandle = null;
		if (leaving === "permission-confirm") {
			const permission = pendingPermission;
			const confirmed = permissionConfirmJustFired;
			pendingPermission = null;
			permissionConfirmJustFired = false;
			if (confirmed && permission) {
				deps.bus.emit(BusChannels.PermissionResolved, {
					status: "granted",
					tool: permission.call.tool,
					actionClass: permission.decision.classification.actionClass,
					requestedBy: "tool",
					at: Date.now(),
				});
				void deps.toolRegistry?.resumeParkedCalls({
					actionClass: permission.decision.classification.actionClass,
					requestedBy: "tool:one_shot",
				});
			} else {
				deps.bus.emit(BusChannels.PermissionResolved, {
					status: "denied",
					...(permission ? { tool: permission.call.tool } : {}),
					...(permission ? { actionClass: permission.decision.classification.actionClass } : {}),
					reason: "operator cancelled",
					requestedBy: "tool",
					at: Date.now(),
				});
				deps.toolRegistry?.cancelParkedCalls(
					"User cancelled this tool call from the permission confirmation prompt. Do not retry the same target via another tool. Wait for new instruction.",
				);
			}
		}
		if (overlayState === "closed" && deps.toolRegistry?.hasParkedCalls() && pendingPermission) {
			openPermissionOverlay(pendingPermission.call, pendingPermission.decision);
		}
		renderTaskIsland();
		tui.requestRender();
	};

	const cancelActiveRun = (): void => {
		deps.chat.cancel();
		footer.refresh();
		tui.requestRender();
	};

	const maybeOpenExternalUrl = (url: string): void => {
		const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
		exec(`${opener} "${url.replace(/"/g, '\\"')}"`, () => {
			// Best effort only.
		});
	};

	const resolveConnectionReference = (target: string) => {
		const settings = deps.getSettings?.();
		if (!settings) return null;
		return resolveProviderReference(
			target,
			settings,
			(runtimeId) => deps.providers.getRuntime(runtimeId) ?? getRuntimeRegistry().get(runtimeId),
		);
	};

	const performDisconnect = (target: string): void => {
		const resolved = resolveConnectionReference(target);
		if (!resolved?.endpoint) {
			notify("warning", `disconnect: unknown target ${target}`, `connect:${target}`);
			return;
		}
		const status = deps.providers.disconnectEndpoint(resolved.endpoint.id);
		if (!status) {
			notify("warning", `disconnect: unknown target ${target}`, `connect:${target}`);
			return;
		}
		notify("info", `disconnected ${status.endpoint.id}; credentials unchanged`, `connect:${status.endpoint.id}`);
		footer.refresh();
		tui.requestRender();
	};

	const openConnectFlowState = (target: string): void => {
		if (overlayState !== "closed") return;
		const resolved = resolveConnectionReference(target);
		if (!resolved?.endpoint) {
			notify("warning", `connect: unknown target ${target}. Add it with clio targets add.`, `connect:${target}`);
			return;
		}
		const endpointId = resolved.endpoint.id;
		const runtimeId = resolved.runtime.id;
		const probeTarget = async (dialog: ReturnType<typeof openAuthDialog>): Promise<void> => {
			dialog.controller.setLines([`Target: ${endpointId}`, `Runtime: ${runtimeId}`, "Checking connection..."]);
			const status = await deps.providers.probeEndpoint(endpointId);
			if (!status) {
				dialog.controller.setLines([`Target: ${endpointId}`, "Connection failed: target is not configured."]);
				notify("error", `connect: ${endpointId} is not configured`, `connect:${endpointId}`);
				return;
			}
			const health = status.health.status;
			const detail =
				status.reason ||
				status.health.lastError ||
				(status.health.latencyMs !== null ? `${status.health.latencyMs}ms` : "no details");
			dialog.controller.setLines([
				`Target: ${endpointId}`,
				`Runtime: ${runtimeId}`,
				status.available ? `Connected (${health})` : `Connection failed (${health})`,
				detail,
			]);
			notify(
				status.available ? "info" : "warning",
				status.available ? `connected ${endpointId} (${health})` : `connect ${endpointId} failed (${health})`,
				`connect:${endpointId}`,
			);
			footer.refresh();
			tui.requestRender();
		};

		const selectOAuthOption = async (
			dialog: ReturnType<typeof openAuthDialog>,
			prompt: OAuthSelectPrompt,
			prefix: ReadonlyArray<string>,
		): Promise<string | undefined> => {
			const defaultId = prompt.options[0]?.id;
			if (!defaultId) return undefined;
			const ids = new Set(prompt.options.map((option) => option.id));
			const baseLines = [
				...prefix,
				prompt.message,
				...prompt.options.map((option, index) => {
					const marker = option.id === defaultId ? "*" : " ";
					return `${marker} ${String(index + 1).padStart(2)}. ${option.label} (${option.id})`;
				}),
			];
			let errorLine: string | null = null;
			for (;;) {
				dialog.controller.setLines(errorLine ? [...baseLines, errorLine] : baseLines);
				const answer = (await dialog.controller.prompt(`Selection (number or id, q to cancel) [${defaultId}]`)).trim();
				if (answer.length === 0) return defaultId;
				if (answer === "q" || answer === "quit" || answer === "cancel") return undefined;
				const numeric = Number(answer);
				if (Number.isInteger(numeric) && numeric >= 1 && numeric <= prompt.options.length) {
					return prompt.options[numeric - 1]?.id;
				}
				if (ids.has(answer)) return answer;
				errorLine = `Unknown selection: ${answer}`;
			}
		};

		overlayState = "auth";
		const requiresManagedAuth = targetRequiresAuth(resolved.endpoint, resolved.runtime);
		const authStatus = deps.providers.auth.statusForTarget(resolved.endpoint, resolved.runtime);
		if (!requiresManagedAuth || authStatus.available) {
			const dialog = openAuthDialog(tui, `Connect ${endpointId}`, () => closeOverlay());
			overlayHandle = dialog.handle;
			void (async () => {
				try {
					await probeTarget(dialog);
				} catch (error) {
					dialog.controller.setLines([
						`Target: ${endpointId}`,
						`Connection failed: ${error instanceof Error ? error.message : String(error)}`,
					]);
					tui.requestRender();
				}
			})();
			tui.requestRender();
			return;
		}
		if (resolved.runtime.auth === "api-key") {
			const dialog = openAuthDialog(tui, `Connect ${endpointId}`, () => closeOverlay());
			overlayHandle = dialog.handle;
			authDialogDismiss = dialog.controller.dismiss;
			dialog.controller.setLines([
				`Target: ${endpointId}`,
				`Runtime: ${resolved.runtime.id}`,
				"API key required before Clio can connect to this target.",
			]);
			void (async () => {
				try {
					const apiKey = (await dialog.controller.prompt("API key")).trim();
					if (apiKey.length === 0) throw new Error("empty API key");
					deps.providers.auth.setApiKey(resolved.authTarget.providerId, apiKey);
					authDialogDismiss = null;
					await probeTarget(dialog);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (message !== "dismissed" && message !== "cancelled") {
						io.stderr(`[/connect] ${message}\n`);
					}
					authDialogDismiss = null;
					closeOverlay();
				}
			})();
			tui.requestRender();
			return;
		}
		const dialog = openAuthDialog(tui, `Connect ${endpointId}`, () => closeOverlay());
		overlayHandle = dialog.handle;
		authDialogDismiss = dialog.controller.dismiss;
		dialog.controller.setLines([
			`Target: ${endpointId}`,
			`Runtime: ${resolved.runtime.id}`,
			"Starting authorization flow...",
		]);
		void (async () => {
			let manualCodeTimer: NodeJS.Timeout | null = null;
			try {
				await deps.providers.auth.login(resolved.authTarget.providerId, {
					onAuth: ({ url, instructions }) => {
						dialog.controller.setLines(
							[
								`Open: ${url}`,
								instructions ?? "Complete sign-in in your browser.",
								"Waiting for the browser callback. A manual code prompt will appear if needed.",
							].filter(Boolean),
						);
						maybeOpenExternalUrl(url);
					},
					onDeviceCode: ({ verificationUri, userCode }) => {
						dialog.controller.setLines([
							`Open: ${verificationUri}`,
							`Enter code: ${userCode}`,
							"Waiting for authentication...",
						]);
						maybeOpenExternalUrl(verificationUri);
					},
					onPrompt: async (prompt) => (await dialog.controller.prompt(prompt.message)).trim(),
					onSelect: (prompt) =>
						selectOAuthOption(dialog, prompt, [`Target: ${endpointId}`, `Runtime: ${resolved.runtime.id}`]),
					onManualCodeInput: async () =>
						await new Promise<string>((resolve, reject) => {
							manualCodeTimer = setTimeout(() => {
								manualCodeTimer = null;
								dialog.controller
									.prompt("Verification code")
									.then((value) => resolve(value.trim()))
									.catch(reject);
							}, 10_000);
							manualCodeTimer.unref?.();
						}),
					onProgress: (message) => {
						dialog.controller.appendLine(message);
					},
				});
				authDialogDismiss = null;
				await probeTarget(dialog);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message !== "dismissed" && message !== "cancelled") {
					notify("error", `connect ${endpointId}: ${message}`, `connect:${endpointId}`);
				}
				authDialogDismiss = null;
				closeOverlay();
			} finally {
				if (manualCodeTimer) {
					clearTimeout(manualCodeTimer);
				}
			}
		})();
		tui.requestRender();
	};

	const openConnectOverlayState = (target?: string): void => {
		if (target) {
			openConnectFlowState(target);
			return;
		}
		if (overlayState !== "closed") return;
		const settings = deps.getSettings?.();
		if (!settings) return;
		const statuses = deps.providers.list();
		const targetItems: SelectItem[] = settings.endpoints.map((endpoint) => {
			const runtime = deps.providers.getRuntime(endpoint.runtime) ?? getRuntimeRegistry().get(endpoint.runtime);
			const status = statuses.find((entry) => entry.endpoint.id === endpoint.id);
			const auth =
				runtime && (runtime.auth === "oauth" || runtime.auth === "api-key")
					? deps.providers.auth.statusForTarget(endpoint, runtime)
					: null;
			const connection =
				status?.health.status && status.health.status !== "unknown"
					? status.health.status
					: auth?.available
						? auth.source
						: (status?.reason ?? "configured target");
			return {
				value: endpoint.id,
				label: `${endpoint.id}  ${runtime?.displayName ?? endpoint.runtime}`,
				description: `${connection}${endpoint.defaultModel ? `  ${endpoint.defaultModel}` : ""}`,
			};
		});
		if (targetItems.length === 0) {
			notify("warning", "connect: no targets configured. Run clio configure or clio targets add.", "connect:none");
			return;
		}
		overlayState = "auth";
		overlayHandle = openAuthSelectorOverlay(tui, {
			items: targetItems,
			onSelect: (value) => {
				closeOverlay();
				queueMicrotask(() => openConnectFlowState(value));
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openDisconnectOverlayState = (target?: string): void => {
		if (target) {
			performDisconnect(target);
			return;
		}
		if (overlayState !== "closed") return;
		const settings = deps.getSettings?.();
		if (!settings) return;
		const statuses = deps.providers.list();
		const items: SelectItem[] = settings.endpoints.map((endpoint) => {
			const runtime = deps.providers.getRuntime(endpoint.runtime) ?? getRuntimeRegistry().get(endpoint.runtime);
			const status = statuses.find((entry) => entry.endpoint.id === endpoint.id);
			const connection =
				status?.health.status && status.health.status !== "unknown"
					? status.health.status
					: (status?.reason ?? "configured target");
			return {
				value: endpoint.id,
				label: `${endpoint.id}  ${runtime?.displayName ?? endpoint.runtime}`,
				description: `${connection}${endpoint.defaultModel ? `  ${endpoint.defaultModel}` : ""}`,
			};
		});
		if (items.length === 0) {
			notify("warning", "disconnect: no targets configured. Run clio configure or clio targets add.", "connect:none");
			return;
		}
		overlayState = "auth";
		overlayHandle = openAuthSelectorOverlay(tui, {
			items,
			onSelect: (value) => {
				closeOverlay();
				queueMicrotask(() => performDisconnect(value));
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openPermissionOverlay = (call: ClassifierCall, decision: SafetyDecision): void => {
		if (overlayState !== "closed") return;
		pendingPermission = { call, decision };
		permissionConfirmJustFired = false;
		overlayState = "permission-confirm";
		overlayHandle = showClioOverlayFrame(tui, createPermissionOverlayBody(call, decision), {
			anchor: "center",
			width: PERMISSION_OVERLAY_WIDTH,
			title: permissionOverlayTitle(),
			footerHint: "[Enter] allow once    [Esc] cancel",
		});
		tui.requestRender();
	};

	const unsubscribePermissionRequired =
		deps.toolRegistry?.onPermissionRequired((call, decision) => {
			if (overlayState === "permission-confirm") return;
			pendingPermission = { call, decision };
			openPermissionOverlay(call, decision);
		}) ?? (() => {});

	const openProvidersOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "providers";
		overlayHandle = openProvidersOverlay(tui, deps.providers, { bus: deps.bus });
		tui.requestRender();
	};

	const openCostOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "cost";
		overlayHandle = openCostOverlay(tui, deps.observability, {
			bus: deps.bus,
			sessionId: deps.getSessionId?.() ?? null,
		});
		tui.requestRender();
	};

	const openContextViewOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "context-view";
		overlayHandle = openContextOverlay(tui, () => deps.chat.contextLedger(), { bus: deps.bus });
		tui.requestRender();
	};

	const toggleFooterDashboardState = (): void => {
		if (overlayState !== "closed") return;
		footer.toggleExpanded();
		renderTaskIsland();
		tui.requestRender();
	};

	const toggleStatusFooterState = (): void => {
		toggleFooterDashboardState();
	};

	const openReceiptsOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "receipts";
		overlayHandle = openReceiptsOverlay(tui, deps.dispatch);
		tui.requestRender();
	};

	const openThinkingOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "thinking";
		const settings = deps.getSettings?.();
		const current = settings
			? (resolveThinkingCapability(deps.providers, settings)?.effectiveLevel ?? readThinkingLevel(settings))
			: "off";
		const available = settings ? resolveAvailableThinkingLevels(deps.providers, settings) : (["off"] as ThinkingLevel[]);
		const thinkingOverlayDeps: Parameters<typeof openThinkingOverlay>[1] = {
			current,
			available,
			onSelect: (next) => {
				deps.onSetThinkingLevel?.(next);
				footer.refresh();
			},
			onClose: () => closeOverlay(),
			...(settings ? { labelFor: resolveThinkingLabeler(deps.providers, settings) } : {}),
		};
		overlayHandle = openThinkingOverlay(tui, thinkingOverlayDeps);
		tui.requestRender();
	};

	const openModelOverlayState = (): void => {
		if (overlayState !== "closed") return;
		const settings = deps.getSettings?.();
		if (!settings) return;
		overlayState = "model";
		overlayHandle = openModelOverlay(tui, {
			settings,
			...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
			providers: deps.providers,
			bus: deps.bus,
			onSelect: (ref) => {
				deps.onSelectModel?.(ref);
				footer.refresh();
			},
			onToggleFavorite: (ref, favorite) => {
				if (!deps.getSettings || !deps.writeSettings) return;
				const next = structuredClone(deps.getSettings()) as ClioSettings;
				const value = `${ref.endpoint}/${ref.model}`;
				const current = new Set(next.modelSelector?.favorites ?? []);
				if (favorite) current.add(value);
				else current.delete(value);
				next.modelSelector = {
					...(next.modelSelector ?? { recentLimit: 12, favorites: [] }),
					favorites: [...current],
				};
				deps.writeSettings(next);
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openScopedModelsOverlayState = (): void => {
		if (overlayState !== "closed") return;
		const settings = deps.getSettings?.();
		if (!settings) return;
		overlayState = "scoped-models";
		overlayHandle = openScopedOverlay(tui, {
			providers: deps.providers,
			currentScope: extractScopeFromSettings(settings),
			onCommit: (next) => {
				deps.onSetScope?.(next);
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openSettingsOverlayState = (): void => {
		if (overlayState !== "closed") return;
		if (!deps.getSettings || !deps.writeSettings) return;
		overlayState = "settings";
		const getSettings = deps.getSettings;
		const writeSettingsOut = deps.writeSettings;
		overlayHandle = openSettingsOverlay(tui, {
			getSettings,
			providers: deps.providers,
			keybindings,
			writeSettings: (next) => {
				writeSettingsOut(next);
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openResumeOverlayState = (): void => {
		if (overlayState !== "closed") return;
		if (!deps.session) {
			io.stderr("[/resume] session contract unavailable\n");
			return;
		}
		const sessionContract = deps.session;
		const preResumeSessionId = sessionContract.current()?.id ?? null;
		overlayState = "resume";
		overlayHandle = openSessionOverlay(tui, {
			session: sessionContract,
			onResume: (sessionId) => {
				deps.onResumeSession?.(sessionId);
				// Replay the resumed session's on-disk turns into the chat
				// panel so the user sees their prior transcript, and reset
				// chat-loop's lastTurnId + agent.state.messages so the next
				// submit parents onto the resumed leaf rather than inheriting
				// whatever state the previous session left behind. Row 51
				// regression fix.
				try {
					const turns = openSession(sessionId).turns();
					chatPanel.reset();
					rehydrateChatPanelFromTurns(chatPanel, turns);
					const replayMessages = buildReplayAgentMessagesFromTurns(turns);
					const leafTurnId = sessionContract.tree(sessionId).leafId;
					deps.chat.resetForSession(leafTurnId, replayMessages);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					io.stderr(`[/resume] transcript replay failed: ${msg}\n`);
				}
				footer.refresh();
				tui.requestRender();
			},
			onClose: () => {
				closeOverlay();
				// Post-close cwd check: if /resume landed on a session whose
				// recorded cwd is no longer valid, pop the cwd-fallback
				// overlay so the user can either continue in the terminal's
				// cwd or cancel back to the prior session. Queued as a
				// microtask so the resume overlay state machine fully
				// settles before the next overlay opens.
				queueMicrotask(() => {
					const current = sessionContract.current();
					if (!current) return;
					if (current.id === preResumeSessionId) return;
					const probe = resolveSessionCwd(current);
					if (probe.ok) return;
					openCwdFallbackOverlayState({
						sessionCwd: typeof current.cwd === "string" ? current.cwd : "",
						reason: probe.reason,
						preResumeSessionId,
					});
				});
			},
		});
		tui.requestRender();
	};

	const openTreeOverlayState = (): void => {
		if (overlayState !== "closed") return;
		if (!deps.session) {
			io.stderr("[/tree] session contract unavailable\n");
			return;
		}
		const sessionContract = deps.session;
		overlayState = "tree";
		overlayHandle = openTreeOverlay(tui, {
			session: sessionContract,
			onSwitchBranch: (sessionId) => {
				try {
					sessionContract.switchBranch(sessionId);
					const turns = openSession(sessionId).turns();
					chatPanel.reset();
					rehydrateChatPanelFromTurns(chatPanel, turns);
					const replayMessages = buildReplayAgentMessagesFromTurns(turns);
					const leafTurnId = sessionContract.tree(sessionId).leafId;
					deps.chat.resetForSession(leafTurnId, replayMessages);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					io.stderr(`[/tree] switchBranch failed: ${msg}\n`);
				}
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openMessagePickerOverlayState = (): void => {
		if (overlayState !== "closed") return;
		if (!deps.session) {
			io.stderr("[/fork] session contract unavailable\n");
			return;
		}
		const sessionContract = deps.session;
		// No-op stderr when there is no current session so the user can tell
		// the overlay is intentionally inert rather than broken.
		if (sessionContract.current() === null) {
			io.stderr("[/fork] no current session to fork from; start one with /new or /resume first\n");
			return;
		}
		overlayState = "message-picker";
		overlayHandle = openMessagePickerOverlay(tui, {
			session: sessionContract,
			onFork: (parentTurnId) => {
				try {
					if (deps.onForkSession) {
						deps.onForkSession(parentTurnId);
					} else {
						sessionContract.fork(parentTurnId);
					}
					chatPanel.reset();
					const forkedSessionId = sessionContract.current()?.id ?? null;
					if (forkedSessionId) {
						try {
							const forkedTurns = openSession(forkedSessionId).turns();
							rehydrateChatPanelFromTurns(chatPanel, forkedTurns);
							const replayMessages = buildReplayAgentMessagesFromTurns(forkedTurns);
							const leafTurnId = sessionContract.tree(forkedSessionId).leafId ?? parentTurnId;
							deps.chat.resetForSession(leafTurnId, replayMessages);
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							io.stderr(`[/fork] transcript replay failed: ${msg}\n`);
							deps.chat.resetForSession(null);
						}
					}
					if (!forkedSessionId) deps.chat.resetForSession(null);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					io.stderr(`[/fork] fork failed: ${msg}\n`);
				}
				footer.refresh();
				tui.requestRender();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const startNewSession = (): void => {
		if (!deps.onNewSession) {
			io.stderr("[/new] session contract unavailable\n");
			return;
		}
		deps.onNewSession();
		deps.observability.resetSession();
		footerToolCounts.clear();
		footerActiveTools.clear();
		footerToolErrors = 0;
		footerToolTruncatedResults = 0;
		chatPanel.reset();
		// Same pre-switch cleanup as /resume and /fork: without this, the
		// chat-loop closure keeps the prior session's lastTurnId and the
		// agent's state.messages, so the first submit on the new session
		// would reach back into context that the user believes was dropped.
		deps.chat.resetForSession(null);
		footer.refresh();
		tui.requestRender();
	};

	/**
	 * Pop the cwd-fallback overlay after /resume landed on a session whose
	 * recorded cwd no longer exists on disk (see src/domains/session/
	 * cwd-fallback.ts for the reasons). Continue silently accepts the
	 * broken-cwd session. Downstream file ops will surface real errors.
	 * Cancel restores the prior session when one existed, or re-opens the
	 * /resume picker so the user can select a different session.
	 */
	const openCwdFallbackOverlayState = (args: {
		sessionCwd: string;
		reason: "no-cwd" | "missing" | "not-a-directory";
		preResumeSessionId: string | null;
	}): void => {
		if (overlayState !== "closed") return;
		if (!deps.session) return;
		const sessionContract = deps.session;
		overlayState = "cwd-fallback";
		overlayHandle = openCwdFallbackOverlay(tui, {
			sessionCwd: args.sessionCwd,
			currentCwd: process.cwd(),
			reason: args.reason,
			onContinue: () => {
				// Accept the broken-cwd session. First fs access will surface a
				// real error; no extra bookkeeping here. The user chose this
				// explicitly, so leave meta.cwd untouched.
				footer.refresh();
			},
			onCancel: () => {
				handleCwdFallbackCancel(args.preResumeSessionId, {
					session: sessionContract,
					// queueMicrotask defers past the current overlay's close so the
					// resume overlay opens cleanly on a quiesced overlay stack.
					openResumeOverlay: () => queueMicrotask(() => openResumeOverlayState()),
					onWarning: (msg) => io.stderr(msg),
				});
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openHotkeysOverlayState = (): void => {
		if (overlayState !== "closed") return;
		overlayState = "hotkeys";
		overlayHandle = openHotkeysOverlay(tui, keybindings);
		tui.requestRender();
	};

	const toggleDispatchBoardOverlay = (): void => {
		if (overlayState === "dispatch-board") {
			closeOverlay();
			return;
		}
		if (overlayState !== "closed") return;
		renderDispatchBoard();
		overlayState = "dispatch-board";
		overlayHandle = showClioOverlayFrame(tui, dispatchBoard, {
			title: "Dispatch Board",
			footerHint: "[Esc] close",
			anchor: "center",
			width: 80,
		});
		startDispatchBoardTicker();
		tui.requestRender();
	};

	const shutdown = async (): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		process.off("SIGINT", handleCtrlC);
		clearInterval(keepAlive);
		if (footerTicker) clearInterval(footerTicker);
		if (workspaceTicker) clearInterval(workspaceTicker);
		if (leaderTimer) clearTimeout(leaderTimer);
		stopDispatchBoardTicker();
		taskIslandHandle.hide();
		dispatchBoardStore.unsubscribe();
		unsubscribeChat();
		unsubscribeStatus();
		statusController.dispose();
		unsubscribeProgress();
		unsubscribeAbortedProgress();
		unsubscribeFooterTokens();
		unsubscribeContextPressure();
		unsubscribeContextPruned();
		unsubscribePermissionRequired();
		agentProgress.stop();
		deps.chat.dispose();
		for (const unsubscribe of dispatchBoardRenderUnsubscribers) unsubscribe();
		try {
			tui.stop();
		} catch {
			// TUI may already be stopped; swallow.
		}
		// Drain the parked queue so any worker or agent loop still holding
		// a pending tool-execution promise sees a terminal verdict rather
		// than a promise that never settles across process exit.
		deps.toolRegistry?.cancelParkedCalls("Clio Coder shutting down");
		await deps.onShutdown();
		resolveRun(0);
	};

	const handleCtrlC = (): void => {
		const action = resolveCtrlCAction({
			overlayState,
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
			notifications.dismissAll();
		},
		toggleToolExpansion: () => {
			if (chatPanel.toggleLastToolExpanded()) tui.requestRender();
		},
		toggleThinkingExpansion: () => {
			if (chatPanel.toggleLastThinking()) tui.requestRender();
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

	const dispatchBoardRenderUnsubscribers = [
		deps.bus.on(BusChannels.DispatchEnqueued, () => {
			footer.refresh();
			renderTaskIsland();
			tui.requestRender();
			if (overlayState !== "dispatch-board") return;
			renderDispatchBoard();
			tui.requestRender();
		}),
		deps.bus.on(BusChannels.DispatchStarted, () => {
			footer.refresh();
			renderTaskIsland();
			tui.requestRender();
			if (overlayState !== "dispatch-board") return;
			renderDispatchBoard();
			tui.requestRender();
		}),
		deps.bus.on(BusChannels.DispatchProgress, () => {
			footer.refresh();
			renderTaskIsland();
			tui.requestRender();
			if (overlayState !== "dispatch-board") return;
			renderDispatchBoard();
			tui.requestRender();
		}),
		deps.bus.on(BusChannels.DispatchCompleted, () => {
			footer.refresh();
			renderTaskIsland();
			tui.requestRender();
			if (overlayState !== "dispatch-board") return;
			renderDispatchBoard();
			tui.requestRender();
		}),
		deps.bus.on(BusChannels.DispatchFailed, () => {
			footer.refresh();
			renderTaskIsland();
			tui.requestRender();
			if (overlayState !== "dispatch-board") return;
			renderDispatchBoard();
			tui.requestRender();
		}),
	];

	tui.addInputListener((data: string) => {
		if (leaderState.status === "pending") {
			const leader = routeLeaderKey(data, leaderState, {
				...keyActionDeps(),
				matchesLeader: (input) => keybindings.matches(input, "clio.leader"),
				leaderTargets: keybindings.leaderTargets(),
				now: Date.now(),
				isRelease: isKeyRelease,
			});
			if (leader.state !== leaderState) setLeaderState(leader.state);
			if (leader.consumed) return { consume: true };
		}

		if (isCtrlCKey(data)) {
			handleCtrlC();
			return { consume: true };
		}

		const overlayConsumed = routeOverlayKey(
			data,
			overlayState,
			{
				cancelPermission: () => {
					closeOverlay();
				},
				confirmPermission: () => {
					permissionConfirmJustFired = true;
					closeOverlay();
					footer.refresh();
					tui.requestRender();
				},
				closeOverlay,
				requestShutdown: () => {
					void shutdown();
				},
			},
			(input, id) => keybindings.matches(input, id),
		);
		if (overlayConsumed) {
			return { consume: true };
		}

		if (overlayState === "closed") {
			const leader = routeLeaderKey(data, leaderState, {
				...keyActionDeps(),
				matchesLeader: (input) => keybindings.matches(input, "clio.leader"),
				leaderTargets: keybindings.leaderTargets(),
				now: Date.now(),
				isRelease: isKeyRelease,
			});
			if (leader.state !== leaderState) setLeaderState(leader.state);
			if (leader.consumed) return { consume: true };
		}

		// Esc falls through to cancel an active run when one is in flight; before
		// this fall-through Esc was short-circuited above the overlay router and stole
		// the keystroke from any open modal, forcing the user to press Esc twice to
		// dismiss modals that opened mid-stream.
		if (data === ESC && activeEditorBash) {
			activeEditorBash.abort();
			return { consume: true };
		}
		if (data === ESC && deps.chat.isStreaming()) {
			cancelActiveRun();
			return { consume: true };
		}

		if (overlayState === "closed" && !isKeyRelease(data)) {
			for (const id of [
				"clio.notifications.dismiss",
				"clio.tool.expand",
				"clio.editor.external",
				"clio.message.followUp",
				"clio.message.dequeue",
				"clio.thinking.expand",
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
