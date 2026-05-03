import { exec } from "node:child_process";
import { BusChannels } from "../core/bus-events.js";
import type { ClioSettings } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { ClioKeybinding } from "../domains/config/keybindings.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { SuperModeConfirmation } from "../domains/modes/contract.js";
import type { ModesContract } from "../domains/modes/index.js";
import type { ObservabilityContract } from "../domains/observability/index.js";
import {
	getRuntimeRegistry,
	type ProvidersContract,
	resolveProviderReference,
	type ThinkingLevel,
	targetRequiresAuth,
} from "../domains/providers/index.js";
import type { SessionContract } from "../domains/session/contract.js";
import { resolveSessionCwd } from "../domains/session/cwd-fallback.js";
import { probeWorkspace } from "../domains/session/workspace/index.js";
import { openSession } from "../engine/session.js";
import {
	createAgentProgress,
	Editor,
	isKeyRelease,
	matchesKey,
	ProcessTerminal,
	type SelectItem,
	Text,
	TUI,
	visibleWidth,
} from "../engine/tui.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ChatLoop } from "./chat-loop.js";
import { createChatPanel } from "./chat-panel.js";
import {
	buildReplayAgentMessagesFromTurns,
	createCoalescingChatRenderer,
	rehydrateChatPanelFromTurns,
} from "./chat-renderer.js";
import { openCostOverlay } from "./cost-overlay.js";
import { createDispatchBoardStore, formatDispatchBoardLines } from "./dispatch-board.js";
import { buildFooter } from "./footer-panel.js";
import { createKeybindingManager } from "./keybinding-manager.js";
import { buildLayout } from "./layout.js";
import { editorBorderColorForMode } from "./mode-theme.js";
import { openAuthDialog } from "./overlays/auth-dialog.js";
import { openAuthSelectorOverlay } from "./overlays/auth-selector.js";
import { openCwdFallbackOverlay } from "./overlays/cwd-fallback.js";
import { openDevDiffOverlay } from "./overlays/dev-diff.js";
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
} from "./overlays/thinking-selector.js";
import { openTreeOverlay } from "./overlays/tree-selector.js";
import { openProvidersOverlay } from "./providers-overlay.js";
import { openReceiptsOverlay, verifyReceiptFile } from "./receipts-overlay.js";
import { createSlashCommandAutocompleteProvider } from "./slash-autocomplete.js";
import { dispatchSlashCommand, parseSlashCommand, type RunIo, type SlashCommandContext } from "./slash-commands.js";
import {
	createStatusController,
	formatStatusElapsed,
	resolveInlineVerb,
	spinnerFrame,
	type TurnSummary,
} from "./status/index.js";
import { renderSuperOverlayLines } from "./super-overlay.js";
import { createWelcomeDashboard } from "./welcome-dashboard.js";

// Re-exports preserve the public surface for diag scripts that import these
// names from "interactive/index.js". Slice 2.6 relocated the implementations
// into slash-commands.ts.
export {
	BUILTIN_SLASH_COMMANDS,
	type BuiltinSlashCommand,
	dispatchSlashCommand,
	type HandleRunDeps,
	handleRun,
	parseSlashCommand,
	type RunIo,
	type SlashCommand,
	type SlashCommandContext,
	type SlashCommandKind,
} from "./slash-commands.js";

export interface InteractiveDeps {
	bus: SafeEventBus;
	modes: ModesContract;
	providers: ProvidersContract;
	dispatch: DispatchContract;
	observability: ObservabilityContract;
	chat: ChatLoop;
	/**
	 * Shared tool registry. When wired, the super overlay opens automatically
	 * whenever a tool call is parked waiting for super admission, and the
	 * confirm / cancel overlay handlers drive `resumeParkedCalls` /
	 * `cancelParkedCalls` so blocked bash batches run (or reject cleanly)
	 * after the mode transition rather than stalling indefinitely.
	 */
	toolRegistry?: ToolRegistry;
	session?: SessionContract;
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
	/** Run /init for the current working directory. */
	onInit?: () => Promise<void>;
	/** Advance the orchestrator target one step forward through `provider.scope`. */
	onCycleScopedModelForward?: () => void;
	/** Advance the orchestrator target one step backward through `provider.scope`. */
	onCycleScopedModelBackward?: () => void;
	/** Hot-reload harness handle. When present, the footer shows an indicator line and Ctrl+R triggers restart. */
	harness?: import("../harness/index.js").HarnessHandle;
	/** True when the dashboard should show the self-development mode badge. */
	selfDev: boolean;
	/** Repository root for private self-development UI affordances. */
	selfDevRepoRoot?: string;
	/** Private self-development footer line. Present only in dev mode. */
	getSelfDevFooterLine?: () => string | null;
	onShutdown: () => Promise<void>;
}

export const CTRL_C_DOUBLE_TAP_MS = 500;
export const ENTER = "\r";
export const ESC = "\x1b";
export type OverlayState =
	| "closed"
	| "super-confirm"
	| "dispatch-board"
	| "providers"
	| "auth"
	| "cost"
	| "receipts"
	| "thinking"
	| "model"
	| "scoped-models"
	| "settings"
	| "resume"
	| "tree"
	| "message-picker"
	| "cwd-fallback"
	| "hotkeys"
	| "dev-diff";

export interface KeyBindingDeps {
	/**
	 * Keybinding lookup injected by startInteractive. Defaults come from
	 * CLIO_KEYBINDINGS; user overrides from settings.keybindings. Tests may
	 * substitute a narrower matcher via createKeybindingManagerForTesting.
	 */
	matches: (data: string, id: ClioKeybinding) => boolean;
	cycleMode: () => void;
	cycleThinking: () => void;
	requestShutdown: () => void;
	requestSuper: () => void;
	toggleDispatchBoard: () => void;
	openModelSelector: () => void;
	openTree: () => void;
	cycleScopedModelForward: () => void;
	cycleScopedModelBackward: () => void;
}

export interface SuperOverlayKeyDeps {
	cancelSuper: () => void;
	confirmSuper: (conf: SuperModeConfirmation) => void;
	now: () => number;
}

export interface DispatchBoardOverlayKeyDeps {
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

export interface DevDiffOverlayKeyDeps {
	closeOverlay: () => void;
}

export interface OverlayKeyDeps
	extends SuperOverlayKeyDeps,
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
		HotkeysOverlayKeyDeps,
		DevDiffOverlayKeyDeps {
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

export function resolveCtrlCAction(deps: CtrlCActionDeps): CtrlCAction {
	if (deps.lastCtrlCAt > 0 && deps.now - deps.lastCtrlCAt <= CTRL_C_DOUBLE_TAP_MS) {
		return "shutdown";
	}
	if (deps.streaming) return "cancel-stream";
	if (deps.overlayState !== "closed") return "close-overlay";
	if (deps.editorText.length > 0) return "clear-editor";
	return "arm-shutdown";
}

/** Pure key router: returns true when the input was consumed. */
export function routeInteractiveKey(data: string, deps: KeyBindingDeps): boolean {
	if (deps.matches(data, "clio.super.request")) {
		deps.requestSuper();
		return true;
	}
	if (deps.matches(data, "clio.thinking.cycle")) {
		deps.cycleThinking();
		return true;
	}
	if (deps.matches(data, "clio.mode.cycle")) {
		deps.cycleMode();
		return true;
	}
	if (deps.matches(data, "clio.session.tree")) {
		deps.openTree();
		return true;
	}
	if (deps.matches(data, "clio.dispatchBoard.toggle")) {
		deps.toggleDispatchBoard();
		return true;
	}
	if (deps.matches(data, "clio.model.select")) {
		deps.openModelSelector();
		return true;
	}
	// Match shift+ctrl+p before ctrl+p so the longer sequence wins. In the
	// default bindings these do not prefix-match each other anyway (the
	// first starts with \x1b via CSI-u, the second is a single \x10 byte),
	// but the order still matters if a user rebinds ctrl+p to an escape
	// sequence that shift+ctrl+p shares a prefix with.
	if (deps.matches(data, "clio.model.cycleBackward")) {
		deps.cycleScopedModelBackward();
		return true;
	}
	if (deps.matches(data, "clio.model.cycleForward")) {
		deps.cycleScopedModelForward();
		return true;
	}
	if (deps.matches(data, "clio.exit")) {
		deps.requestShutdown();
		return true;
	}
	return false;
}

/** Pure overlay key router: returns true when the input was consumed. */
export function routeSuperOverlayKey(data: string, deps: SuperOverlayKeyDeps): boolean {
	if (data === ENTER) {
		deps.confirmSuper({
			requestedBy: "keybind",
			acceptedAt: deps.now(),
		});
		return true;
	}
	if (data === ESC) {
		deps.cancelSuper();
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
 * Pure overlay key router for the /resume overlay. Esc closes; arrows and
 * Enter fall through to the focused SelectList.
 */
export function routeResumeOverlayKey(data: string, deps: ResumeOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
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

/** Pure overlay key router for the self-development diff overlay. Esc closes; everything else is swallowed. */
export function routeDevDiffOverlayKey(data: string, deps: DevDiffOverlayKeyDeps): boolean {
	if (data === ESC) {
		deps.closeOverlay();
		return true;
	}
	return true;
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
	if (overlayState === "super-confirm") {
		routeSuperOverlayKey(data, deps);
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
		// SelectList owns arrows and Enter; route only Esc here.
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
	if (overlayState === "dev-diff") {
		return routeDevDiffOverlayKey(data, deps);
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

const IDENTITY = (s: string): string => s;

export async function startInteractive(deps: InteractiveDeps): Promise<number> {
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);

	// Build the runtime keybinding manager from the current settings snapshot.
	// This also installs the manager as pi-tui's global (via setKeybindings)
	// so editor/select components honor overrides without explicit plumbing.
	const keybindings = createKeybindingManager(deps.getSettings?.() ?? ({ keybindings: {} } as ClioSettings));

	const bootWorkspace = probeWorkspace(process.cwd());

	const banner = createWelcomeDashboard({
		modes: deps.modes,
		providers: deps.providers,
		observability: deps.observability,
		getContextUsage: () => deps.chat.contextUsage(),
		getWorkspaceSnapshot: () => deps.session?.current()?.workspace ?? bootWorkspace,
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		selfDev: deps.selfDev,
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
	const statusController = createStatusController({
		chat: deps.chat,
		providers: deps.providers,
		bus: deps.bus,
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
	});
	const harness = deps.harness;
	const footer = buildFooter({
		modes: deps.modes,
		providers: deps.providers,
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		...(harness ? { getHarnessState: () => harness.state.snapshot() } : {}),
		...(deps.getSelfDevFooterLine ? { getSelfDevFooterLine: deps.getSelfDevFooterLine } : {}),
		getStreaming: () => deps.chat.isStreaming(),
		getAgentStatus: () => statusController.current(),
		getTerminalColumns: () => terminal.columns,
		getSessionTokens: () => deps.observability.sessionTokens(),
	});
	const editor = new Editor(tui, {
		borderColor: IDENTITY,
		selectList: {
			selectedPrefix: IDENTITY,
			selectedText: IDENTITY,
			description: IDENTITY,
			scrollInfo: IDENTITY,
			noMatch: IDENTITY,
		},
	});
	editor.focused = true;
	editor.setAutocompleteProvider(createSlashCommandAutocompleteProvider());
	const applyEditorModeTheme = (): void => {
		editor.borderColor = editorBorderColorForMode(deps.modes.current());
	};
	applyEditorModeTheme();

	const superOverlayLines = renderSuperOverlayLines();
	const superOverlayWidth = superOverlayLines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
	const superOverlay = new Text(superOverlayLines.join("\n"), 0, 0);
	const dispatchBoardStore = createDispatchBoardStore(deps.bus);
	const dispatchBoard = new Text(formatDispatchBoardLines(dispatchBoardStore.rows()).join("\n"), 0, 0);
	const dispatchBoardWidth = formatDispatchBoardLines([]).reduce((max, line) => Math.max(max, visibleWidth(line)), 0);

	const io: RunIo = {
		stdout: (s) => process.stdout.write(s),
		stderr: (s) => process.stderr.write(s),
	};

	const chatRenderer = createCoalescingChatRenderer({
		chatPanel,
		requestRender: () => tui.requestRender(),
	});
	const unsubscribeChat = deps.chat.onEvent((event) => chatRenderer.applyEvent(event));
	let statusInlineFrame = 0;
	const formatSummaryLine = (summary: TurnSummary): string => {
		const stopGlyph =
			summary.stopReason === "stop" || summary.stopReason === "toolUse" || summary.stopReason === "length"
				? "✓"
				: summary.stopReason === "cancelled" || summary.stopReason === "aborted"
					? "⊘"
					: "✗";
		const tools =
			summary.toolCount > 0
				? ` · ${summary.toolCount} tool${summary.toolCount === 1 ? "" : "s"}${
						summary.toolErrorCount > 0 ? ` (${summary.toolErrorCount} ✗)` : ""
					}`
				: "";
		const slow = summary.watchdogPeak >= 2 ? " · slow turn" : "";
		const reasoning =
			typeof summary.reasoningTokens === "number" && summary.reasoningTokens > 0
				? ` · reasoning:${summary.reasoningTokens}`
				: "";
		const model =
			summary.endpointId.length > 0 || summary.modelId.length > 0
				? `${summary.endpointId || "endpoint"}/${summary.modelId || "model"}`
				: "unknown-model";
		return `${formatStatusElapsed(summary.elapsedMs)} · ${model} · ↑${summary.inputTokens} ↓${summary.outputTokens}${reasoning}${tools} ${stopGlyph}${slow}`;
	};
	const unsubscribeStatus = statusController.subscribe((status) => {
		if (status.phase === "idle") {
			chatPanel.setStatusLine(null);
		} else if (status.phase === "ended") {
			chatPanel.setStatusLine(null);
			chatPanel.setSummaryLine(status.summary ? formatSummaryLine(status.summary) : null);
		} else {
			chatPanel.setSummaryLine(null);
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
	// OSC 9;4 indeterminate progress around each agent turn. pi-tui 0.70.x
	// exposes Terminal.setProgress; the engine helper wraps it so start/stop
	// are idempotent and unit-testable.
	const agentProgress = createAgentProgress(terminal);
	const unsubscribeProgress = deps.chat.onEvent((event) => {
		const settings = deps.getSettings?.();
		const showProgress = settings?.terminal.showTerminalProgress ?? false;
		if (event.type === "agent_start" && showProgress) agentProgress.start();
		else if (event.type === "agent_end") agentProgress.stop();
	});
	// Repaint the footer whenever an assistant message completes so the
	// running `in:/out:` token counters reflect the latest usage. The
	// existing 120ms ticker only refreshes while streaming, which means the
	// final frame after a turn ends would otherwise be stale.
	const unsubscribeFooterTokens = deps.chat.onEvent((event) => {
		if (event.type !== "message_end" && event.type !== "agent_end") return;
		footer.refresh();
		tui.requestRender();
	});
	const unsubscribeModeTheme = deps.bus.on(BusChannels.ModeChanged, () => {
		applyEditorModeTheme();
		tui.requestRender();
	});

	const slashCtx: SlashCommandContext = {
		io,
		dispatch: deps.dispatch,
		bus: deps.bus,
		dataDir: deps.dataDir,
		workerDefault: () => deps.getWorkerDefault?.(),
		shutdown: () => {
			void shutdown();
		},
		openProviders: () => openProvidersOverlayState(),
		openConnect: (target) => openConnectOverlayState(target),
		openDisconnect: (target) => openDisconnectOverlayState(target),
		openCost: () => openCostOverlayState(),
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
		runInit: () => {
			if (!deps.onInit) {
				io.stderr("[/init] init not wired; pass onInit to startInteractive\n");
				return;
			}
			void deps
				.onInit()
				.catch((err) => {
					const msg = err instanceof Error ? err.message : String(err);
					io.stderr(`[/init] ${msg}\n`);
				})
				.finally(() => tui.requestRender());
		},
		verifyReceipt: (runId) => verifyReceiptFile(deps.dataDir, runId),
		submitChat: (text) => {
			chatPanel.appendUser(text);
			tui.requestRender();
			void (async () => {
				try {
					await deps.chat.submit(text);
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

	editor.onSubmit = (text: string): void => {
		dispatchSlashCommand(parseSlashCommand(text), slashCtx);
	};

	const root = buildLayout({ banner, chat: chatPanel, editor, footer: footer.view });
	tui.addChild(root);
	tui.setFocus(editor);
	tui.start();

	let footerTicker: NodeJS.Timeout | null = null;
	footerTicker = setInterval(() => {
		const harnessActive = harness ? harness.state.snapshot().kind !== "idle" : false;
		const statusActive = statusController.current().phase !== "idle";
		if (!deps.chat.isStreaming() && !harnessActive && !statusActive) return;
		footer.refresh();
		tui.requestRender();
	}, 120);
	footerTicker.unref?.();

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
	process.removeAllListeners("SIGINT");

	const renderDispatchBoard = (): void => {
		dispatchBoard.setText(formatDispatchBoardLines(dispatchBoardStore.rows()).join("\n"));
		dispatchBoard.invalidate();
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
		// Centralize the parked-call lifecycle here so every super-overlay
		// dismissal (Enter, Esc, Ctrl+C, shutdown) drives the registry to a
		// terminal verdict. `modes.confirmSuper` flips the mode before the
		// confirm handler calls closeOverlay, so a post-close mode of "super"
		// means the user confirmed; anything else means they cancelled.
		if (leaving === "super-confirm") {
			const cancelled = deps.modes.current() !== "super";
			if (cancelled) {
				// Emit before mutating the registry so the audit row lands even
				// when toolRegistry is not wired (lighter integration tests, future
				// non-tool callers). The from/to fields stay equal because the
				// pending request never produced a real mode transition; safety's
				// audit subscriber persists this row as kind: "mode_change" with
				// reason: "request_cancelled" so /audit consumers can correlate
				// dismissed Alt+S overlays with the prior request rows.
				const current = deps.modes.current();
				deps.bus.emit(BusChannels.ModeChanged, {
					from: current,
					to: current,
					reason: "request_cancelled",
					at: Date.now(),
				});
			}
			if (deps.toolRegistry) {
				if (cancelled) {
					deps.toolRegistry.cancelParkedCalls(
						"User cancelled this tool call from the super-mode confirmation prompt. Do not retry the same target via another tool. Wait for new instruction.",
					);
				} else {
					void deps.toolRegistry.resumeParkedCalls();
				}
			}
			// Hard-stop the entire agent turn on a super cancel so the model
			// cannot reach the same target through a different tool (e.g.
			// write -> bash redirection). Without this the SDK auto-continues
			// after the blocked tool result and the agent treats the
			// cancellation as "use a different approach".
			if (cancelled && deps.chat.isStreaming()) {
				cancelActiveRun();
			}
		}
		// If a parked call arrived while an unrelated overlay was open, the
		// onSuperRequired listener's attempt to open the super overlay was a
		// no-op. Re-check on every overlay close so the user sees the
		// confirmation prompt as soon as the competing overlay dismisses.
		if (overlayState === "closed" && deps.toolRegistry?.hasParkedCalls()) {
			openSuperOverlay("tool");
		}
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
			io.stderr(`[/disconnect] unknown target: ${target}\n`);
			return;
		}
		const status = deps.providers.disconnectEndpoint(resolved.endpoint.id);
		if (!status) {
			io.stderr(`[/disconnect] unknown target: ${target}\n`);
			return;
		}
		io.stderr(`[/disconnect] disconnected target ${status.endpoint.id}; credentials unchanged\n`);
		footer.refresh();
		tui.requestRender();
	};

	const openConnectFlowState = (target: string): void => {
		if (overlayState !== "closed") return;
		const resolved = resolveConnectionReference(target);
		if (!resolved?.endpoint) {
			io.stderr(`[/connect] unknown target: ${target}. Configure a target first with clio targets add.\n`);
			return;
		}
		const endpointId = resolved.endpoint.id;
		const runtimeId = resolved.runtime.id;
		const probeTarget = async (dialog: ReturnType<typeof openAuthDialog>): Promise<void> => {
			dialog.controller.setLines([`Target: ${endpointId}`, `Runtime: ${runtimeId}`, "Checking connection..."]);
			const status = await deps.providers.probeEndpoint(endpointId);
			if (!status) {
				dialog.controller.setLines([`Target: ${endpointId}`, "Connection failed: target is not configured."]);
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
			footer.refresh();
			tui.requestRender();
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
					onPrompt: async (prompt) => (await dialog.controller.prompt(prompt.message)).trim(),
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
					io.stderr(`[/connect] ${message}\n`);
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
			io.stderr("[/connect] no targets configured. Run clio configure or clio targets add.\n");
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
			io.stderr("[/disconnect] no targets configured. Run clio configure or clio targets add.\n");
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

	const openSuperOverlay = (requestedBy: string = "keybind"): void => {
		if (overlayState !== "closed") return;
		deps.modes.requestSuper(requestedBy);
		overlayState = "super-confirm";
		overlayHandle = tui.showOverlay(superOverlay, {
			anchor: "center",
			width: superOverlayWidth,
		});
		tui.requestRender();
	};

	// Subscribe to registry parking so the super overlay opens automatically
	// whenever a tool call (typically a privileged bash batch) stalls waiting
	// for super admission. The resume/cancel handlers on the overlay drive the
	// registry back to a terminal verdict so pi-agent-core sees either a real
	// result or a clean rejection instead of a hung promise.
	const unsubscribeSuperRequired =
		deps.toolRegistry?.onSuperRequired(() => {
			deps.bus.emit(BusChannels.SuperRequired, { requestedBy: "tool", at: Date.now() });
			if (overlayState === "super-confirm") return;
			openSuperOverlay("tool");
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
		const current = settings ? readThinkingLevel(settings) : "off";
		const available = settings ? resolveAvailableThinkingLevels(deps.providers, settings) : (["off"] as ThinkingLevel[]);
		overlayHandle = openThinkingOverlay(tui, {
			current,
			available,
			onSelect: (next) => {
				deps.onSetThinkingLevel?.(next);
				footer.refresh();
			},
			onClose: () => closeOverlay(),
		});
		tui.requestRender();
	};

	const openModelOverlayState = (): void => {
		if (overlayState !== "closed") return;
		const settings = deps.getSettings?.();
		if (!settings) return;
		overlayState = "model";
		overlayHandle = openModelOverlay(tui, {
			settings,
			providers: deps.providers,
			onSelect: (ref) => {
				deps.onSelectModel?.(ref);
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
				// Capture the parent session id BEFORE fork swaps the
				// contract's current pointer; the pre-fork transcript lives
				// on the parent session's current.jsonl, and we need it for
				// replay into the new branch's chat panel.
				const parentSessionId = sessionContract.current()?.id ?? null;
				try {
					if (deps.onForkSession) {
						deps.onForkSession(parentTurnId);
					} else {
						sessionContract.fork(parentTurnId);
					}
					chatPanel.reset();
					if (parentSessionId) {
						try {
							const parentTurns = openSession(parentSessionId).turns();
							rehydrateChatPanelFromTurns(chatPanel, parentTurns, { uptoTurnId: parentTurnId });
							const replayMessages = buildReplayAgentMessagesFromTurns(parentTurns, { uptoTurnId: parentTurnId });
							deps.chat.resetForSession(null, replayMessages);
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							io.stderr(`[/fork] transcript replay failed: ${msg}\n`);
							deps.chat.resetForSession(null);
						}
					}
					// The new branch starts a fresh tree (tree.json is empty on
					// the fork; the parent-pointer lives on meta.json), so the
					// next user turn must parent to null. When replay succeeds,
					// resetForSession still seeds the provider context from the
					// selected parent prefix so the visible fork transcript and
					// model memory agree.
					if (!parentSessionId) deps.chat.resetForSession(null);
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

	const openDevDiffOverlayState = (): void => {
		if (!deps.selfDev || !deps.selfDevRepoRoot || overlayState !== "closed") return;
		overlayState = "dev-diff";
		overlayHandle = openDevDiffOverlay(tui, deps.selfDevRepoRoot);
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
		overlayHandle = tui.showOverlay(dispatchBoard, {
			anchor: "center",
			width: dispatchBoardWidth,
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
		stopDispatchBoardTicker();
		dispatchBoardStore.unsubscribe();
		unsubscribeChat();
		unsubscribeStatus();
		statusController.dispose();
		unsubscribeProgress();
		unsubscribeFooterTokens();
		unsubscribeModeTheme();
		unsubscribeSuperRequired();
		agentProgress.stop();
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

	const dispatchBoardRenderUnsubscribers = [
		deps.bus.on(BusChannels.DispatchEnqueued, () => {
			if (overlayState !== "dispatch-board") return;
			renderDispatchBoard();
			tui.requestRender();
		}),
		deps.bus.on(BusChannels.DispatchStarted, () => {
			if (overlayState !== "dispatch-board") return;
			renderDispatchBoard();
			tui.requestRender();
		}),
		deps.bus.on(BusChannels.DispatchProgress, () => {
			if (overlayState !== "dispatch-board") return;
			renderDispatchBoard();
			tui.requestRender();
		}),
		deps.bus.on(BusChannels.DispatchCompleted, () => {
			if (overlayState !== "dispatch-board") return;
			renderDispatchBoard();
			tui.requestRender();
		}),
		deps.bus.on(BusChannels.DispatchFailed, () => {
			if (overlayState !== "dispatch-board") return;
			renderDispatchBoard();
			tui.requestRender();
		}),
	];

	tui.addInputListener((data: string) => {
		if (isCtrlCKey(data)) {
			handleCtrlC();
			return { consume: true };
		}

		const overlayConsumed = routeOverlayKey(
			data,
			overlayState,
			{
				cancelSuper: () => {
					closeOverlay();
				},
				confirmSuper: (conf) => {
					deps.modes.confirmSuper(conf);
					closeOverlay();
					footer.refresh();
					tui.requestRender();
				},
				now: () => Date.now(),
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

		// No overlay consumed the input. Esc now falls through to cancel an
		// active run when one is in flight; before this fall-through Esc was
		// short-circuited above the overlay router and stole the keystroke
		// from any open modal, forcing the user to press Esc twice to dismiss
		// modals that opened mid-stream.
		if (data === ESC && deps.chat.isStreaming()) {
			cancelActiveRun();
			return { consume: true };
		}

		if (overlayState === "closed" && keybindings.matches(data, "clio.tool.expand") && !isKeyRelease(data)) {
			if (chatPanel.toggleLastToolExpanded()) tui.requestRender();
			return { consume: true };
		}

		if (overlayState === "closed" && keybindings.matches(data, "clio.thinking.expand") && !isKeyRelease(data)) {
			if (chatPanel.toggleLastThinking()) tui.requestRender();
			return { consume: true };
		}

		if (harness) {
			const snap = harness.state.snapshot();
			if (snap.kind === "restart-required" && keybindings.matches(data, "clio.harness.restart")) {
				void harness.restart();
				return { consume: true };
			}
		}

		if (deps.selfDev && overlayState === "closed" && matchesKey(data, "alt+d") && !isKeyRelease(data)) {
			openDevDiffOverlayState();
			return { consume: true };
		}

		const consumed = routeInteractiveKey(data, {
			matches: (input, id) => keybindings.matches(input, id),
			cycleMode: () => {
				deps.modes.cycleNormal();
				footer.refresh();
				tui.requestRender();
			},
			cycleThinking: () => {
				const settings = deps.getSettings?.();
				const available = settings
					? resolveAvailableThinkingLevels(deps.providers, settings)
					: (["off"] as ThinkingLevel[]);
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
			requestSuper: () => {
				openSuperOverlay();
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
		});
		return consumed ? { consume: true } : undefined;
	});

	return run;
}
