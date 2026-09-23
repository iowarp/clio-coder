import { credentialsPresent } from "../domains/providers/credentials.js";
import { inspectDecisionSite } from "../domains/providers/decision-sites.js";
import type { LibraryEntryKind } from "../domains/resources/index.js";
import { describeToolRisk as readToolRisk, toolRiskAdvisoryLine } from "../domains/safety/tool-risk.js";
import { appendInterviewRecord, appendNotice } from "./command-output.js";
import { judgeDrafts } from "./drafts.js";
import { createOverlayAskUserLifecycle, type OverlayAskUserLifecycle } from "./overlay-ask-user-lifecycle.js";
import { createOverlayAuthLifecycle } from "./overlay-auth-lifecycle.js";
import { showClioOverlayFrame } from "./overlay-frame.js";
import { createOverlayGeneralOpeners } from "./overlay-general-openers.js";
import { createOverlayModelSelectors } from "./overlay-model-selectors.js";
import { createOverlayPermissionLifecycle, type OverlayPermissionLifecycle } from "./overlay-permission-lifecycle.js";
import { createOverlayResourceOpeners, type LibraryOpenRequest } from "./overlay-resource-openers.js";
import { createOverlaySessionLifecycle } from "./overlay-session-lifecycle.js";
import { createOverlayTransitions } from "./overlay-transitions.js";
import {
	createPermissionOverlayBody,
	PERMISSION_OVERLAY_WIDTH,
	type PermissionOverlayBodyHandle,
	permissionOverlayHint,
	permissionOverlayPlacement,
	permissionOverlayTitle,
	permissionOverlayTone,
} from "./permission-overlay.js";

/**
 * Bound on the advisory request. Nothing waits on it, so this is only how long
 * a card keeps a request alive before giving up on ever showing the line.
 */
const TOOL_RISK_DECISION_TIMEOUT_MS = 5_000;
/**
 * Bound on the `/draft` judgment. The operator is watching the overlay for it,
 * and a live three-candidate judgment answered in 264ms.
 */
const DRAFT_JUDGE_TIMEOUT_MS = 5_000;

export * from "./overlay-key-routing.js";

import type { OverlayState } from "./overlay-key-routing.js";
import type { PendingModelScope } from "./overlays/model-scope.js";
import type { SettingsCenterRowId, SettingsSectionId } from "./overlays/settings.js";

// Runtime lifecycle construction lives beside the pure modal key router so the
// application composition root no longer owns the mutable overlay state.
export type OverlayLifecycleApplicationDeps = Pick<
	import("./interactive-application.js").InteractiveDeps,
	| "agents"
	| "bus"
	| "chat"
	| "commitSetting"
	| "dataDir"
	| "dispatch"
	| "getFleetNodes"
	| "getRouteBreakers"
	| "getSessionId"
	| "getSettings"
	| "getTaskBoard"
	| "userTasks"
	| "getDecisionBoard"
	| "getTaskMemoryStatus"
	| "interop"
	| "observability"
	| "onContextClear"
	| "onForkSession"
	| "onNewSession"
	| "onResumeSession"
	| "onSelectModel"
	| "onSetThinkingLevel"
	| "providers"
	| "readSessionEntries"
	| "registerAskUserHandler"
	| "resources"
	| "scheduling"
	| "session"
	| "stateDir"
	| "supersedeDecision"
	| "toolRegistry"
	| "writeSettings"
>;

/** Pending proposals from the report this process already holds; the picker never probes. */
function interopProposalsFor(
	interop: NonNullable<OverlayLifecycleApplicationDeps["interop"]>,
): () => ReadonlyArray<import("../domains/interop/index.js").InteropProposal> {
	return () => {
		const report = interop.lastReport();
		return report === null ? [] : interop.proposals(report);
	};
}

export interface OverlayLifecycleRuntimeDeps {
	app: OverlayLifecycleApplicationDeps;
	getQuotaSnapshots?: () => ReadonlyArray<import("../domains/quota/types.js").UsageSnapshot>;
	getDispatchRows?: () => ReadonlyArray<import("./dispatch-board.js").DispatchBoardRow>;
	tui: import("../engine/tui.js").TUI;
	footer: import("./footer/dashboard.js").FooterDashboardPanel;
	interactiveTickers: import("./interactive-tickers.js").InteractiveTickers;
	busNoticeSink: Parameters<typeof import("./command-output.js").appendNotice>[2];
	chatRenderer: { applyEvent(event: import("./chat-loop.js").ToolApprovalStateEvent): void };
	notify: (level: import("./interactive-subscriptions.js").InteractiveNoticeLevel, text: string, key?: string) => void;
	terminal: Pick<import("../engine/tui.js").ProcessTerminal, "columns">;
	dispatchBoard: ReturnType<typeof import("./dispatch-board.js").createDispatchBoardView>;
	/** Record a dispatched fleet step's plan position for the board's phase column. */
	setFleetRunPhase?: (runId: string, phase: { wave: number; stepId: string }) => void;
	chatPanel: import("./chat-panel.js").ChatPanel;
	/** Clears the transcript and every view folded alongside it; the session overlays call it before a replay. */
	resetTranscript: () => void;
	/**
	 * Stop and restart the terminal around a child process that owns the screen.
	 * `/handoff` uses it for the external editor, the same way the composer's
	 * own `$EDITOR` opener does.
	 */
	suspendTerminal: <T>(run: () => T) => T;
	io: import("./slash-commands.js").RunIo;
	readStructuredEntries: (sessionId: string) => import("../domains/session/index.js").SessionEntry[];
	announceTaskMemorySeedOffer: () => void;
	/** Rescopes the footer's last-turn line when a session overlay changes the branch. */
	setLastTurnSummary?: (summary: import("./status/index.js").TurnSummary | null) => void;
	keybindings: ReturnType<typeof import("./keybinding-manager.js").createKeybindingManager>;
	editor: Pick<import("./clio-editor.js").ClioEditor, "getText" | "render" | "setText">;
	getSlashContext: () => import("./slash-commands.js").SlashCommandContext;
	/**
	 * A worker permission or ask_user request parked waiting for the operator.
	 * Wired to the desktop notification; absent hosts simply do not notify.
	 */
	onOperatorParked?: () => void;
	showOverlayFrame?: typeof showClioOverlayFrame;
	openAuthDialog?: typeof import("./overlays/auth-dialog.js").openAuthDialog;
	openAskUserOverlay?: typeof import("./overlays/ask-user.js").openAskUserOverlay;
	openModelOverlay?: typeof import("./overlays/model-selector.js").openModelOverlay;
	openModelScopeOverlay?: typeof import("./overlays/model-scope.js").openModelScopeOverlay;
	openSettingsOverlay?: typeof import("./overlays/settings.js").openSettingsOverlay;
	openSessionOverlay?: typeof import("./overlays/session-selector.js").openSessionOverlay;
	openTreeOverlay?: typeof import("./overlays/tree-selector.js").openTreeOverlay;
	openMessagePickerOverlay?: typeof import("./overlays/message-picker.js").openMessagePickerOverlay;
	openCwdFallbackOverlay?: typeof import("./overlays/cwd-fallback.js").openCwdFallbackOverlay;
	openUsageOverlay?: typeof import("./usage-overlay.js").openUsageOverlay;
	openContextOverlay?: typeof import("./context-overlay.js").openContextOverlay;
	openContextResetOverlay?: typeof import("./overlays/context-reset.js").openContextResetOverlay;
	openTasksOverlay?: typeof import("./tasks-overlay.js").openTasksOverlay;
	openDecisionsOverlay?: typeof import("./overlays/decisions.js").openDecisionsOverlay;
	openMemoryOverlay?: typeof import("./memory-overlay.js").openMemoryOverlay;
	openViewOverlay?: typeof import("./view/view-overlay.js").openViewOverlay;
	openHelpOverlay?: typeof import("./overlays/help-reference.js").openHelpOverlay;
	openSkillsHub?: typeof import("./overlays/library.js").openLibraryOverlay;
	openExtensionsOverlay?: typeof import("./overlays/extensions.js").openExtensionsOverlay;
	openInteropOverlay?: typeof import("./overlays/interop.js").openInteropOverlay;
}

export interface OverlayLifecycleController {
	openExtensionPanelState: import("./overlay-resource-openers.js").OverlayResourceOpeners["openExtensionPanelState"];
	getState(): OverlayState;
	closeOverlay(): void;
	finishAuthOverlay(dismiss: boolean): void;
	openAskUserOverlayState: import("../tools/ask-user.js").AskUserHandler;
	closeAskUserSession(): void;
	isAskUserWaiting(): boolean;
	resetAskUserCancellation(): void;
	refreshSettingsOverlay(): void;
	openUsageOverlayState(): void;
	openContextViewOverlayState(): void;
	openContextResetOverlayState(): void;
	toggleFooterDashboardState(): void;
	openTasksOverlayState(): void;
	openDecisionsOverlayState(): void;
	openMemoryOverlayState(): void;
	openViewOverlayState(initialFilter?: string): void;
	/** `/btw <question>`: one side-question round rendered in its own overlay. */
	openSideQuestionOverlayState(question: string): void;
	/** `/draft [N] <request>`: parallel candidates judged by a decision model. */
	openDraftOverlayState(request: string, count: number): void;
	/** `/handoff <goal>`: extract, review, and seed a successor session. */
	startHandoffState(goal: string): void;
	startFleetRunState(name: string, vars: Readonly<Record<string, string>>): void;
	openModelOverlayState(): void;
	/** `/model <pattern>` and the picker both land here: choose session or global before anything applies. */
	openModelScopeState(ref: PendingModelScope): void;
	openSettingsOverlayState(section?: SettingsSectionId, rowId?: SettingsCenterRowId): void;
	openResumeOverlayState(): void;
	openTreeOverlayState(): void;
	openMessagePickerOverlayState(): void;
	openHelpOverlayState(query?: string): void;
	openSkillsHubState(request?: LibraryOpenRequest | LibraryEntryKind): void;
	openExtensionsOverlayState(): void;
	openInteropOverlayState(): void;
	toggleDispatchBoardOverlay(): void;
	confirmPermission(): void;
	stopTurnFromPermission(): void;
	/** Whether the live permission card has a mutation the operator can read here. */
	canInspectMutation(): boolean;
	/** Whether that mutation is currently open. */
	isInspectingMutation(): boolean;
	toggleMutationInspection(): void;
	scrollMutationInspection(delta: number): void;
	/** Fold or unfold the standing approval terms on the live permission card. */
	togglePermissionTerms(): void;
	cancelAskUser(): void;
	dispose(): void;
}

export function createOverlayLifecycle(deps: OverlayLifecycleRuntimeDeps): OverlayLifecycleController {
	const {
		tui,
		footer,
		interactiveTickers,
		busNoticeSink,
		chatRenderer,
		notify,
		terminal,
		dispatchBoard,
		chatPanel,
		resetTranscript,
		io,
		readStructuredEntries,
		announceTaskMemorySeedOffer,
		setLastTurnSummary,
		keybindings,
		editor,
		showOverlayFrame = showClioOverlayFrame,
		openAuthDialog: openAuthDialogFactory,
		openAskUserOverlay: openAskUserOverlayFactory,
		openModelOverlay: openModelOverlayFactory,
		openModelScopeOverlay: openModelScopeOverlayFactory,
		openSettingsOverlay: openSettingsOverlayFactory,
		openSessionOverlay: openSessionOverlayFactory,
		openTreeOverlay: openTreeOverlayFactory,
		openMessagePickerOverlay: openMessagePickerOverlayFactory,
		openCwdFallbackOverlay: openCwdFallbackOverlayFactory,
		openUsageOverlay: openUsageOverlayFactory,
		openContextOverlay: openContextOverlayFactory,
		openContextResetOverlay: openContextResetOverlayFactory,
		openTasksOverlay: openTasksOverlayFactory,
		openDecisionsOverlay: openDecisionsOverlayFactory,
		openMemoryOverlay: openMemoryOverlayFactory,
		openViewOverlay: openViewOverlayFactory,
		openHelpOverlay: openHelpOverlayFactory,
		openSkillsHub: openSkillsHubFactory,
		openExtensionsOverlay: openExtensionsOverlayFactory,
		openInteropOverlay: openInteropOverlayFactory,
	} = deps;
	let overlayPermission: OverlayPermissionLifecycle | null = null;
	let overlayAskUser: OverlayAskUserLifecycle | null = null;
	/**
	 * The live permission card's body, held only while its dialog is on screen.
	 * The mutation text it can show lives here and nowhere else, so dropping the
	 * reference when the dialog closes drops the text with it.
	 */
	let permissionBody: PermissionOverlayBodyHandle | null = null;
	const inspectionHint = (): import("./permission-hint.js").PermissionInspectionHint => {
		if (permissionBody === null || !permissionBody.canInspect()) return "none";
		return permissionBody.isInspecting() ? "open" : "closed";
	};
	const overlayTransitions = createOverlayTransitions({
		stopDispatchBoardTicker: () => interactiveTickers.stopDispatchBoardTicker(),
		renderContextIsland: () => interactiveTickers.renderContextIsland(),
		renderTaskIsland: () => interactiveTickers.renderTaskIsland(),
		requestRender: () => tui.requestRender(),
		cancelPendingAskUser: () => overlayAskUser?.cancelPending() ?? false,
		finishAuth: (dismiss) => overlayAuth.finish(dismiss),
		onPermissionOverlayClosed: () => {
			permissionBody = null;
			overlayPermission?.onPermissionOverlayClosed();
		},
		onOverlayClosed: () => overlayPermission?.retryPending(),
	});
	const closeOverlay = overlayTransitions.close;

	const overlayAuth = createOverlayAuthLifecycle({
		tui,
		providers: deps.app.providers,
		...(deps.app.getSettings ? { getSettings: deps.app.getSettings } : {}),
		notify,
		refreshFooter: () => footer.refresh(),
		renderContextIsland: () => interactiveTickers.renderContextIsland(),
		renderTaskIsland: () => interactiveTickers.renderTaskIsland(),
		requestRender: () => tui.requestRender(),
		getOverlayState: () => overlayTransitions.state,
		setOverlayState: (state) => {
			overlayTransitions.state = state;
		},
		getOverlayHandle: () => overlayTransitions.handle,
		setOverlayHandle: (handle) => {
			overlayTransitions.handle = handle;
		},
		...(openAuthDialogFactory ? { openAuthDialog: openAuthDialogFactory } : {}),
	});

	overlayPermission = createOverlayPermissionLifecycle({
		...(deps.app.toolRegistry ? { toolRegistry: deps.app.toolRegistry } : {}),
		bus: deps.app.bus,
		dispatch: deps.app.dispatch,
		getAutonomy: () => deps.app.getSettings?.().safety.autonomy ?? "auto-edit",
		/**
		 * The blast-radius sentence for one parked call, or nothing at all.
		 *
		 * Resolved here rather than in the composition root because the binding is
		 * read per call: an operator who unbinds the site mid-session stops seeing
		 * the line on the next approval instead of at the next restart. Every path
		 * that cannot produce a sentence returns the empty string, and the caller
		 * never waits on this.
		 */
		describeToolRisk: async (subject) => {
			const settings = deps.app.getSettings?.();
			if (!settings || !deps.app.providers) return "";
			const status = inspectDecisionSite("toolRisk", {
				settings,
				providers: deps.app.providers,
				ctx: () => ({ credentialsPresent: credentialsPresent(), httpTimeoutMs: TOOL_RISK_DECISION_TIMEOUT_MS }),
			});
			if (!status.bound) return "";
			return toolRiskAdvisoryLine(
				await readToolRisk(status.decider, subject, `${status.targetId}/${status.model ?? "default"}`),
			);
		},
		getOverlayState: () => overlayTransitions.state,
		openPermissionOverlay: (view, inspect, invocation, advisory) => {
			if (overlayTransitions.state === "permission-confirm") return false;
			const body = createPermissionOverlayBody(view, inspect, invocation, advisory);
			permissionBody = body;
			const handle = showOverlayFrame(tui, body, {
				...permissionOverlayPlacement(tui, editor, footer.view),
				width: PERMISSION_OVERLAY_WIDTH,
				// Not derived from the title: that one is classified per decision
				// axis and is one of five strings for the same modal.
				markerId: "permission-confirm",
				title: permissionOverlayTitle(view),
				tone: permissionOverlayTone(view),
				// Read per frame: the footer names what Enter does right now, and
				// that depends on whether the composer holds a draft and on whether
				// the mutation is open.
				footerHint: (innerWidth) =>
					permissionOverlayHint(
						innerWidth,
						editor.getText().length > 0,
						inspectionHint(),
						body.isShowingTerms() ? "open" : "closed",
					),
			});
			if (!overlayTransitions.showPermission(handle)) {
				handle.hide();
				permissionBody = null;
				return false;
			}
			tui.requestRender();
			return true;
		},
		closeOverlay,
		appendNotice: (level, text) => appendNotice(level, text, busNoticeSink),
		applyApprovalState: (event) => chatRenderer.applyEvent(event),
		requestRender: () => tui.requestRender(),
		// An operator cancel, audited as one. The reason distinguishes it from an
		// Esc or Ctrl-C in the audit trail without inventing a new abort source.
		stopActiveTurn: (reason) =>
			deps.app.chat.cancel({
				reason,
				source: "stream_cancel",
				auditReason: "operator stopped the turn at a permission prompt",
			}),
		...(deps.onOperatorParked ? { onOperatorParked: deps.onOperatorParked } : {}),
	});

	overlayAskUser = createOverlayAskUserLifecycle({
		tui,
		getOverlayState: () => overlayTransitions.state,
		setOverlayState: (state) => {
			overlayTransitions.state = state;
		},
		getOverlayHandle: () => overlayTransitions.handle,
		setOverlayHandle: (handle) => {
			overlayTransitions.handle = handle;
		},
		renderContextIsland: () => interactiveTickers.renderContextIsland(),
		renderTaskIsland: () => interactiveTickers.renderTaskIsland(),
		requestRender: () => tui.requestRender(),
		...(deps.app.registerAskUserHandler ? { registerHandler: deps.app.registerAskUserHandler } : {}),
		...(openAskUserOverlayFactory ? { openAskUserOverlay: openAskUserOverlayFactory } : {}),
		...(deps.onOperatorParked ? { onOperatorParked: deps.onOperatorParked } : {}),
		onRoundAnswered: (questions, answers) =>
			appendInterviewRecord(
				answers.map((answer) => ({
					label:
						questions.find((question) => question.question === answer.question)?.header ??
						answer.question.split("\n").find((line) => line.trim().length > 0) ??
						answer.question,
					answer: answer.answer,
				})),
				busNoticeSink,
			),
	});

	const overlayModelSelectors = createOverlayModelSelectors({
		tui,
		transitions: overlayTransitions,
		providers: deps.app.providers,
		bus: deps.app.bus,
		refreshFooter: () => footer.refresh(),
		notify,
		closeOverlay,
		...(deps.app.getSettings ? { getSettings: deps.app.getSettings } : {}),
		...(deps.app.writeSettings ? { writeSettings: deps.app.writeSettings } : {}),
		...(deps.app.commitSetting ? { commitSetting: deps.app.commitSetting } : {}),
		...(deps.app.onSelectModel ? { onSelectModel: deps.app.onSelectModel } : {}),
		...(deps.app.onSetThinkingLevel ? { onSetThinkingLevel: deps.app.onSetThinkingLevel } : {}),
		...(deps.app.getFleetNodes ? { getFleetNodes: deps.app.getFleetNodes } : {}),
		...(deps.app.getRouteBreakers ? { getRouteBreakers: deps.app.getRouteBreakers } : {}),
		connectTarget: (targetId) => overlayAuth.openConnectFlow(targetId),
		...(deps.app.interop ? { getInteropProposals: interopProposalsFor(deps.app.interop) } : {}),
		...(openModelOverlayFactory ? { openModelOverlay: openModelOverlayFactory } : {}),
		...(openModelScopeOverlayFactory ? { openModelScopeOverlay: openModelScopeOverlayFactory } : {}),
		...(openSettingsOverlayFactory ? { openSettingsOverlay: openSettingsOverlayFactory } : {}),
	});

	const overlayResourceOpeners = createOverlayResourceOpeners({
		tui,
		transitions: overlayTransitions,
		keybindings,
		editor,
		getSlashContext: deps.getSlashContext,
		...(deps.app.resources ? { resources: deps.app.resources } : {}),
		closeOverlay,
		...(openHelpOverlayFactory ? { openHelpOverlay: openHelpOverlayFactory } : {}),
		...(openSkillsHubFactory ? { openSkillsHub: openSkillsHubFactory } : {}),
		...(openExtensionsOverlayFactory ? { openExtensionsOverlay: openExtensionsOverlayFactory } : {}),
		...(openInteropOverlayFactory ? { openInteropOverlay: openInteropOverlayFactory } : {}),
	});

	const overlaySessions = createOverlaySessionLifecycle({
		tui,
		transitions: overlayTransitions,
		...(deps.app.session ? { session: deps.app.session } : {}),
		chat: deps.app.chat,
		chatPanel,
		resetTranscript,
		readStructuredEntries,
		getSlashNotice: () => deps.getSlashContext().notice,
		...(deps.app.onResumeSession ? { onResumeSession: deps.app.onResumeSession } : {}),
		...(deps.app.onForkSession ? { onForkSession: deps.app.onForkSession } : {}),
		...(deps.app.onNewSession ? { onNewSession: deps.app.onNewSession } : {}),
		...(deps.app.getDecisionBoard ? { getDecisionBoard: deps.app.getDecisionBoard } : {}),
		terminal: deps.terminal,
		suspendTerminal: deps.suspendTerminal,
		announceTaskMemorySeedOffer,
		sessionUsage: deps.app.observability,
		...(setLastTurnSummary ? { setLastTurnSummary } : {}),
		refreshFooter: () => footer.refresh(),
		requestRender: () => tui.requestRender(),
		stderr: (text) => io.stderr(text),
		notify,
		...(openSessionOverlayFactory ? { openSessionOverlay: openSessionOverlayFactory } : {}),
		...(openTreeOverlayFactory ? { openTreeOverlay: openTreeOverlayFactory } : {}),
		...(openMessagePickerOverlayFactory ? { openMessagePickerOverlay: openMessagePickerOverlayFactory } : {}),
		...(openCwdFallbackOverlayFactory ? { openCwdFallbackOverlay: openCwdFallbackOverlayFactory } : {}),
	});

	const scheduling = deps.app.scheduling;
	const overlayGeneralOpeners = createOverlayGeneralOpeners({
		readTranscript: () => chatPanel.inspectionArtifacts(),
		tui,
		transitions: overlayTransitions,
		observability: deps.app.observability,
		...(deps.getQuotaSnapshots ? { getQuotaSnapshots: deps.getQuotaSnapshots } : {}),
		...(deps.getDispatchRows ? { getDispatchRows: deps.getDispatchRows } : {}),
		...(deps.app.getSessionId ? { getSessionId: deps.app.getSessionId } : {}),
		getContextLedger: () => deps.app.chat.contextLedger(),
		contextChat: deps.app.chat,
		bus: deps.app.bus,
		...(deps.app.onContextClear ? { onContextClear: (options) => deps.app.onContextClear?.(options, deps.io) } : {}),
		stderr: (text) => io.stderr(text),
		refreshFooter: () => footer.refresh(),
		toggleFooter: () => footer.toggleExpanded(),
		renderTaskIsland: () => interactiveTickers.renderTaskIsland(),
		requestRender: () => tui.requestRender(),
		...(deps.app.getTaskBoard ? { getTaskBoard: deps.app.getTaskBoard } : {}),
		...(deps.app.userTasks ? { userTasks: deps.app.userTasks } : {}),
		...(deps.app.getDecisionBoard ? { getDecisionBoard: deps.app.getDecisionBoard } : {}),
		...(deps.app.supersedeDecision ? { supersedeDecision: deps.app.supersedeDecision } : {}),
		submitChat: (text) => deps.getSlashContext().submitChat(text),
		...(deps.app.getTaskMemoryStatus ? { getTaskMemoryStatus: deps.app.getTaskMemoryStatus } : {}),
		dataDir: deps.app.dataDir,
		notify,
		dispatch: deps.app.dispatch,
		stateDir: deps.app.stateDir,
		getSessionMeta: () => deps.app.session?.current() ?? null,
		...(deps.app.readSessionEntries ? { readSessionEntries: deps.app.readSessionEntries } : {}),
		...(deps.app.getSettings ? { getSettings: deps.app.getSettings } : {}),
		terminal,
		dispatchBoard,
		startDispatchBoardTicker: () => interactiveTickers.startDispatchBoardTicker(),
		closeOverlay,
		showOverlayFrame,
		...(openUsageOverlayFactory ? { openUsageOverlay: openUsageOverlayFactory } : {}),
		...(openContextOverlayFactory ? { openContextOverlay: openContextOverlayFactory } : {}),
		...(openContextResetOverlayFactory ? { openContextResetOverlay: openContextResetOverlayFactory } : {}),
		...(openTasksOverlayFactory ? { openTasksOverlay: openTasksOverlayFactory } : {}),
		...(openDecisionsOverlayFactory ? { openDecisionsOverlay: openDecisionsOverlayFactory } : {}),
		...(openMemoryOverlayFactory ? { openMemoryOverlay: openMemoryOverlayFactory } : {}),
		...(openViewOverlayFactory ? { openViewOverlay: openViewOverlayFactory } : {}),
		askSideQuestion: (question, options) => deps.app.chat.askSideQuestion(question, options),
		draftCandidates: (request, count, options) => deps.app.chat.draftCandidates(request, count, options),
		/**
		 * Read per call, like the toolRisk site, so binding or unbinding `drafts`
		 * mid-session applies to the next draft.
		 */
		judgeDrafts: async (request, candidates, signal) => {
			const settings = deps.app.getSettings?.();
			if (!settings || !deps.app.providers) return { reason: "not judged: settings are not loaded" };
			const status = inspectDecisionSite("drafts", {
				settings,
				providers: deps.app.providers,
				ctx: () => ({ credentialsPresent: credentialsPresent(), httpTimeoutMs: DRAFT_JUDGE_TIMEOUT_MS }),
			});
			if (!status.bound) {
				return {
					reason:
						status.reason === "unbound"
							? "not judged: bind fleet.decisionProfiles.drafts to a System One profile"
							: `not judged: ${status.detail}`,
				};
			}
			const verdict = await judgeDrafts(
				status.decider,
				request,
				candidates,
				`${status.targetId}/${status.model ?? "default"}`,
				signal,
			);
			return verdict ? { verdict } : { reason: `not judged: ${status.targetId} gave no usable answer` };
		},
		...(deps.app.agents ? { agents: deps.app.agents } : {}),
		...(scheduling ? { getBudgetPreflight: () => scheduling.preflight() } : {}),
		isTurnInFlight: () => deps.app.chat.isStreaming(),
		...(deps.setFleetRunPhase ? { setFleetRunPhase: deps.setFleetRunPhase } : {}),
	});

	const openResumeOverlayState = overlaySessions.openResume;
	const openTreeOverlayState = overlaySessions.openTree;
	const openMessagePickerOverlayState = overlaySessions.openMessagePicker;
	const openUsageOverlayState = overlayGeneralOpeners.openUsage;
	const openContextViewOverlayState = overlayGeneralOpeners.openContextView;
	const openContextResetOverlayState = overlayGeneralOpeners.openContextReset;
	const toggleFooterDashboardState = overlayGeneralOpeners.toggleFooter;
	const openTasksOverlayState = overlayGeneralOpeners.openTasks;
	const openDecisionsOverlayState = overlayGeneralOpeners.openDecisions;
	const openMemoryOverlayState = overlayGeneralOpeners.openMemory;
	const openViewOverlayState = overlayGeneralOpeners.openView;
	const openSideQuestionOverlayState = overlayGeneralOpeners.openSideQuestion;
	const openDraftOverlayState = overlayGeneralOpeners.openDraft;
	const startFleetRunState = overlayGeneralOpeners.startFleetRun;
	const startHandoffState = overlaySessions.startHandoff;
	const toggleDispatchBoardOverlay = overlayGeneralOpeners.toggleDispatchBoard;

	return {
		getState: () => overlayTransitions.state,
		closeOverlay,
		finishAuthOverlay: overlayAuth.finish,
		openAskUserOverlayState: overlayAskUser.handler,
		closeAskUserSession: overlayAskUser.close,
		isAskUserWaiting: overlayAskUser.isWaiting,
		resetAskUserCancellation: overlayAskUser.resetCancellation,
		refreshSettingsOverlay: overlayModelSelectors.refreshSettingsOverlay,
		openUsageOverlayState,
		openContextViewOverlayState,
		openContextResetOverlayState,
		toggleFooterDashboardState,
		openTasksOverlayState,
		openDecisionsOverlayState,
		openMemoryOverlayState,
		openViewOverlayState,
		openSideQuestionOverlayState,
		openDraftOverlayState,
		startFleetRunState,
		startHandoffState,
		openModelOverlayState: overlayModelSelectors.openModelOverlayState,
		openModelScopeState: overlayModelSelectors.openModelScopeState,
		openSettingsOverlayState: overlayModelSelectors.openSettingsOverlayState,
		openResumeOverlayState,
		openTreeOverlayState,
		openMessagePickerOverlayState,
		openHelpOverlayState: overlayResourceOpeners.openHelpOverlayState,
		openSkillsHubState: overlayResourceOpeners.openSkillsHubState,
		openExtensionsOverlayState: overlayResourceOpeners.openExtensionsOverlayState,
		openExtensionPanelState: overlayResourceOpeners.openExtensionPanelState,
		openInteropOverlayState: overlayResourceOpeners.openInteropOverlayState,
		toggleDispatchBoardOverlay,
		confirmPermission: () => {
			overlayPermission?.confirm();
			footer.refresh();
			tui.requestRender();
		},
		stopTurnFromPermission: () => {
			overlayPermission?.stopTurn();
			footer.refresh();
			tui.requestRender();
		},
		canInspectMutation: () => permissionBody?.canInspect() ?? false,
		isInspectingMutation: () => permissionBody?.isInspecting() ?? false,
		toggleMutationInspection: () => {
			permissionBody?.toggleInspect();
			tui.requestRender();
		},
		scrollMutationInspection: (delta) => {
			permissionBody?.scrollInspect(delta);
			tui.requestRender();
		},
		togglePermissionTerms: () => {
			permissionBody?.toggleTerms();
			tui.requestRender();
		},
		cancelAskUser: overlayAskUser.cancel,
		dispose: () => {
			overlayPermission?.dispose();
			overlayAskUser?.dispose();
		},
	};
}
