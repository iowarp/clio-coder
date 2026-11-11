import type { ClioSettings } from "../../core/config.js";
import { interfaceGuidanceEnabled, type OutputStyle } from "../../core/defaults.js";
import { readHarnessProfile, recordLessonShown } from "../../core/harness-profile.js";
import { ACTION_BY_COMMAND } from "../../domains/config/keybindings.js";
import type { LiveBudgetView } from "../../domains/context/budget/live-view.js";
import type { ContextState } from "../../domains/context/index.js";
import type { TaskMemoryOperatorStatus } from "../../domains/memory/index.js";
import type { CapabilityFlags, ProvidersContract, RuntimeTier } from "../../domains/providers/index.js";
import { acceptsImageInput, copilotContextTierLabel } from "../../domains/providers/index.js";
import { effectiveYoloConfinement } from "../../domains/safety/autonomy.js";
import type { LocalCapacity } from "../../domains/scheduling/local-capacity.js";
import type { ContextUsageSnapshot } from "../../domains/session/context-accounting.js";
import type { ContextLedger } from "../../domains/session/context-ledger.js";
import type { TaskBoardSnapshot } from "../../domains/session/task-board.js";
import type { WorkspaceSnapshot } from "../../domains/session/workspace/index.js";
import type { TelemetryView } from "../../domains/telemetry/contract.js";
import type { TokenThroughputSnapshot } from "../../domains/telemetry/index.js";
import { Text } from "../../engine/tui.js";
import { normalizeRetrySettings } from "../../session-control/chat-loop-policy.js";
import { getCurrentBranch } from "../../utils/git.js";
import type { BackgroundCall } from "../background-calls.js";
import type { DispatchBoardRow } from "../dispatch-board.js";
import type { FooterPanel } from "../footer-panel.js";
import { dispatchSegment } from "../footer-panel.js";
import { actionKeyLabel } from "../keybinding-manager.js";
import type { QuotaProviders } from "../quota-view.js";
import type { AgentStatus, TurnSummary } from "../status/index.js";
import { resolveFooterVerb, spinnerFrame } from "../status/index.js";
import { animationStep, clioTheme, collapseHomePath, formatTargetLabel } from "../theme/index.js";
import { skinEpoch } from "../theme/tokens.js";
import { launchpadShowsHints } from "../welcome-dashboard.js";
import { createDemoHints } from "./demo-hints.js";
import type { ComposerKeyContext, KeyHintFacts } from "./key-hints.js";
import type { Notification, NotificationCenter } from "./notifications.js";
import { dashboardPageViewport, renderCompactDashboard } from "./pages.js";
import { routeFirstOutput, silenceNoteForms } from "./silence-note.js";
import type { FooterTelemetry } from "./spend.js";
import { footerTelemetry } from "./spend.js";

export function capabilityLabels(caps: CapabilityFlags | null): string[] {
	if (!caps) return [];
	const out: string[] = [acceptsImageInput({ vision: caps.vision }) ? "images yes" : "images no"];
	if (caps.tools) out.push("tools");
	if (caps.reasoning) out.push("reason");
	if (caps.vision) out.push("vision");
	if (caps.fim) out.push("fim");
	if (caps.embeddings) out.push("embed");
	if (typeof caps.contextWindow === "number" && caps.contextWindow > 0)
		out.push(`ctx ${Math.round(caps.contextWindow / 1000)}k`);
	return out.slice(0, 5);
}

import type { AutonomyStatus } from "../../domains/safety/autonomy-window.js";
import type { AgentWorkFacts, ContextEngineFacts, SessionFacts, ToolTallySnapshot, WorkspaceFacts } from "./widgets.js";
import { fitDashboardLine, formatToolTally } from "./widgets.js";

export type { ToolTallySnapshot } from "./widgets.js";

export type FooterDashboardMode = "compact" | "expanded";

export interface FooterDashboardDeps {
	/** Suppress idle teaching when the welcome already owns it. */
	getWelcomeVisible?: () => boolean;
	/** The last slash command the operator typed, so a demo tip can name its key. */
	getLastCommand?: () => string | null;
	getQuotaSnapshots?: () => QuotaProviders;
	getConnections?: () => { mcp: string[]; plugins: string[] };
	getExtensionStatus?: () => ReadonlyArray<string>;
	/** Owner-labelled, pre-styled extension status facts for the compact second line. */
	getExtensionFacts?: (width: number) => ReadonlyArray<string>;
	/** The active extension workspace's footer line, with how to leave it. */
	getWorkspaceLine?: (width: number) => string | null;
	getLifecycleHint?: () => string | null;
	providers: ProvidersContract;
	getSettings?: () => Readonly<ClioSettings>;
	getAgentStatus?: () => AgentStatus;
	getTerminalColumns?: () => number;
	getTerminalRows?: () => number;
	onHeightChange?: (rows: number) => void;
	/** The telemetry read model's live view; absent when there is no read model, which renders "not available". */
	getTelemetry?: () => TelemetryView | null;
	getTokenThroughput?: () => TokenThroughputSnapshot | null;
	getContextUsage?: () => ContextUsageSnapshot &
		Partial<Pick<LiveBudgetView, "revision" | "historical" | "inputSource">>;
	getContextLedger?: () => ContextLedger;
	getDispatchRows?: () => ReadonlyArray<DispatchBoardRow>;
	getTaskBoard?: () => TaskBoardSnapshot | null;
	/** Local node worker limit and its binding input; sampled only while workers are listed. */
	getLocalCapacity?: () => LocalCapacity | null;
	getTaskMemoryStatus?: () => TaskMemoryOperatorStatus;
	getContextActivity?: () => {
		message: string;
		detail: string | null;
		status: "started" | "running" | "completed" | "failed";
	} | null;
	getToolCounts?: () => ToolTallySnapshot;
	getWorkspaceSnapshot?: () => WorkspaceSnapshot | null;
	getSessionInfo?: () => { id: string | null; name: string | null; turns: number | null };
	getLastTurnSummary?: () => TurnSummary | null;
	getExtensionStats?: () => { active: number; installed: number };
	getContextState?: () => ContextState;
	getNotifications?: () => ReadonlyArray<Notification>;
	getEndedNotifications?: () => ReadonlyArray<Notification>;
	/** Side-agent model calls in flight; the rail names them, and the footer stops repeating them. */
	getBackgroundCalls?: () => ReadonlyArray<BackgroundCall>;
	/** Who answers the keyboard right now; the hint row follows it. Absent reads as the idle composer. */
	getKeyContext?: () => ComposerKeyContext;
	getKeyHintFacts?: () => KeyHintFacts;
	/** Whether the Ctrl+G leader is armed and waiting for its next key. */
	getLeaderArmed?: () => boolean;
	/** Whether a Ctrl+C armed the double tap and its window is still open. */
	getShutdownArmed?: () => boolean | string;
	/** Skills whose tool surface is armed across turns; the compact line names them. */
	getActiveEggs?: () => readonly string[];
	getActiveSkillSurface?: () => ReadonlyArray<string>;
	/** The autonomous window at yolo; null below it. */
	getAutonomyStatus?: () => AutonomyStatus | null;
	dismissKeyLabel?: string;
	now?: () => number;
	resolveCurrentBranch?: (cwd: string) => Promise<string | null>;
}

export interface FooterDashboardRenderState {
	/** Session-wide presentation tier; absent uses the default tier. */
	outputStyle?: OutputStyle;
	/** Extension status facts that join the compact second line. */
	extensionFacts?: ReadonlyArray<string>;
	quota?: QuotaProviders;
	quotaRoute?: Pick<DispatchBoardRow, "runtimeId" | "wireModelId" | "node">;
	demoHint?: string | null;
	/** What a long silence owes the operator, widest form first; the row shows the first that fits. */
	silenceNotes?: readonly string[] | null;
	/** Optional learning is enabled; immediate controls are independent. */
	demo?: boolean;
	keyContext?: ComposerKeyContext;
	keyHintFacts?: KeyHintFacts;
	background?: ReadonlyArray<BackgroundCall>;
	welcomeVisible?: boolean;
	connections?: { mcp: string[]; plugins: string[] };
	costCeilingUsd?: number;

	workspace: WorkspaceFacts;
	session: SessionFacts;
	context: ContextEngineFacts;
	agent: AgentWorkFacts;
	notices: ReadonlyArray<Notification>;
	/** Warnings and errors that already left the footer, which the Activity page still lists. */
	endedNotices?: ReadonlyArray<Notification>;
	dismissKeyLabel?: string;
	status: AgentStatus;
	toolCounts: ToolTallySnapshot;
	dispatchRows: ReadonlyArray<DispatchBoardRow>;
	throughput: TokenThroughputSnapshot | null;
	telemetry: FooterTelemetry;
	tick: number;
	now: number;
}

function routeTier(providers: ProvidersContract, targetId: string | null | undefined): RuntimeTier | undefined {
	const target = targetId ? providers.getTarget(targetId) : null;
	return target ? providers.getRuntime(target.runtime)?.tier : undefined;
}

function statusText(status: AgentStatus | undefined, now: number, width: number, frame: number): string | null {
	if (!status || status.phase === "idle") return null;
	const verb = resolveFooterVerb(status, now, width);
	if (!verb) return status.phase.replace(/_/g, " ");
	return status.phase === "ended" ||
		status.phase === "tool_blocked" ||
		status.phase === "stuck" ||
		status.tool?.toolName === "ask_user"
		? verb.text
		: `${spinnerFrame(frame)} ${verb.text}`;
}

export interface FooterDashboardPanel extends FooterPanel {
	mode(): FooterDashboardMode;
	isExpanded(): boolean;
	setExpanded(expanded: boolean): void;
	toggleExpanded(): FooterDashboardMode;
	scroll(delta: number): boolean;
	dispose(): void;
}

function formatClioMdState(value: ContextState["clioMd"] | null | undefined): string | null {
	return value ? `CLIO-CODER.md ${value}` : null;
}

function formatMemoryState(count: number | null | undefined): string | null {
	return typeof count === "number" && count > 0 ? `mem ${count}` : null;
}

function workspaceFacts(deps: FooterDashboardDeps, branchSlot: string | null): WorkspaceFacts {
	const snapshot = deps.getWorkspaceSnapshot?.() ?? null;
	if (snapshot) {
		return {
			cwd: collapseHomePath(snapshot.cwd),
			branch: snapshot.branch,
			...(snapshot.detachedAt !== undefined ? { detachedAt: snapshot.detachedAt } : {}),
			...(snapshot.pending || snapshot.gitUnknown ? { branchPending: true } : {}),
			dirty: snapshot.dirty,
			projectType: snapshot.projectType && snapshot.projectType !== "unknown" ? snapshot.projectType : null,
			remote: snapshot.remoteUrl,
		};
	}
	return {
		cwd: collapseHomePath(process.cwd()),
		branch: branchSlot,
		dirty: null,
		projectType: null,
		remote: null,
	};
}

/**
 * The footer's text, composed for the width it renders at. A refresh composes
 * it at the terminal's width; a frame that renders it at another width, such
 * as the first frame after a resize, composes it again at that width rather
 * than wrapping rows fitted to the old one into a stack of broken halves.
 */
class FooterText extends Text {
	private composedWidth: number | null = null;
	private composedRows: number | null = null;
	private composedText = "";
	private composedEpoch = -1;
	private composedOwner: string | undefined;
	private readonly compose: (width: number) => string;

	constructor(
		compose: (width: number) => string,
		private readonly getRows: () => number,
		/** The hint row names the keyboard owner, so a new owner recomposes on the frame that shows it. */
		private readonly getOwner: () => string | undefined = () => undefined,
	) {
		super("", 0, 0);
		this.compose = compose;
	}

	composeAt(width: number): void {
		this.composedWidth = width;
		this.composedEpoch = skinEpoch();
		this.composedRows = this.getRows();
		this.composedOwner = this.getOwner();
		const text = this.compose(width);
		if (text === this.composedText) return;
		this.composedText = text;
		this.setText(text);
	}

	override render(width: number): string[] {
		if (
			this.composedEpoch !== skinEpoch() ||
			width !== this.composedWidth ||
			this.getRows() !== this.composedRows ||
			this.getOwner() !== this.composedOwner
		)
			this.composeAt(width);
		return super.render(width);
	}
}

export function buildFooterDashboard(deps: FooterDashboardDeps): FooterDashboardPanel {
	const terminalRows = () => deps.getTerminalRows?.() ?? process.stdout.rows ?? 40;
	const view = new FooterText(
		(width) => composeFooter(width),
		terminalRows,
		() => deps.getKeyContext?.(),
	);
	const demoHints = createDemoHints();
	let branchSlot: string | null = null;
	let dashboardMode: FooterDashboardMode = "compact";
	let scrollOffset = 0;
	let maxScrollOffset = 0;
	let scrollRows = 8;
	let disposed = false;
	const state = (width: number): FooterDashboardRenderState => {
		const now = deps.now?.() ?? Date.now();
		const welcomeVisible = deps.getWelcomeVisible?.() === true;
		const notices = deps.getNotifications?.() ?? [];
		// Every refresh within one animation step composes the same spinner, so a
		// refresh the status stream asks for between ticks costs no bytes.
		const frame = animationStep(now);
		const dispatch = deps.getDispatchRows?.() ?? [];
		const tools = deps.getToolCounts?.() ?? { tools: {}, errors: 0 };
		const status = deps.getAgentStatus?.();
		const compactionActive = status?.phase === "compacting" || (status?.activePhases?.has("compacting") ?? false);
		const telemetry = footerTelemetry(deps.getTelemetry?.());
		const throughputMetric = deps.getTokenThroughput?.();
		const contextUsage = deps.getContextUsage?.();
		const contextLedger = deps.getContextLedger?.() ?? null;
		const settings = deps.getSettings?.();
		const autonomyWindow = deps.getAutonomyStatus?.() ?? null;
		const taskMemory = deps.getTaskMemoryStatus?.() ?? null;
		const contextState = deps.getContextState?.() ?? null;
		const keyContext = deps.getKeyContext?.();

		const statuses = deps.providers.list();
		const current = settings?.chat?.target ? (statuses.find((s) => s.target.id === settings.chat?.target) ?? null) : null;

		const tierLabel = copilotContextTierLabel(current?.target);
		const routeLabel = formatTargetLabel(settings?.chat?.target, settings?.chat?.model, { abbreviate: false });
		const target = tierLabel ? `${routeLabel} · ${tierLabel}` : routeLabel;

		const wireModelId = settings?.chat?.model ?? current?.target.defaultModel ?? null;
		return {
			outputStyle: settings?.interface.outputDetail ?? "standard",
			...(deps.getExtensionFacts ? { extensionFacts: deps.getExtensionFacts(width) } : {}),
			quota: deps.getQuotaSnapshots?.() ?? [],
			...(current?.runtime && wireModelId
				? {
						quotaRoute: {
							runtimeId: current.runtime.id,
							wireModelId,
						},
					}
				: {}),
			...(deps.getConnections ? { connections: deps.getConnections() } : {}),
			...(settings ? { costCeilingUsd: settings.safety.limits.sessionCostUsd } : {}),

			workspace: workspaceFacts(deps, branchSlot),
			session: {
				name: deps.getSessionInfo?.().name ?? null,
				target,
				autonomy: settings?.safety.autonomy ?? "default",
				yoloConfinement: effectiveYoloConfinement(settings?.safety),
				...(autonomyWindow ? { autonomyWindow } : {}),
				targetId: settings?.chat?.target ?? null,
				modelId: settings?.chat?.model ?? null,
				leaderArmed: deps.getLeaderArmed?.() ?? false,
				shutdownArmed: deps.getShutdownArmed?.() ?? false,
				activeSkills: deps.getActiveSkillSurface?.() ?? [],
				duckBadge: deps.getActiveEggs?.().includes("duck") ?? false,
				memoryIntervention: taskMemory
					? {
							enabled: taskMemory.enabled,
							tier: taskMemory.tier,
							size: taskMemory.size,
							stepInFlight: taskMemory.stepInFlight,
							lastDecision: taskMemory.lastDecision,
							...(taskMemory.guardian === undefined ? {} : { guardian: taskMemory.guardian }),
						}
					: null,
			},
			context: {
				...(contextUsage?.revision
					? {
							budget: {
								revision: contextUsage.revision,
								historical: contextUsage.historical ?? true,
								inputSource: contextUsage.inputSource ?? "unknown",
							},
						}
					: {}),
				label: null,
				used: contextUsage?.tokens ?? null,
				contextWindow: contextUsage?.contextWindow ?? null,
				toolSchemaTokens: contextUsage?.breakdown?.toolSchemaTokens ?? null,
				compactionThreshold: settings?.context.compaction?.threshold ?? null,
				compactionAuto: settings?.context.compaction?.auto ?? null,
				compactionActive,
				clioMd: formatClioMdState(contextState?.clioMd),
				memory: formatMemoryState(contextState?.memoryCount),
				extensions: deps.getExtensionStats?.() ?? null,
				breakdown: contextUsage?.breakdown ?? null,
				ledger: contextLedger,
			},
			agent: {
				statusText: statusText(status, now, width, frame),
				dispatchSummary: dispatchSegment(dispatch),
				toolTally: formatToolTally(tools, contextLedger?.toolCount ?? null),
				dispatchRows: dispatch,
				contextActivity: deps.getContextActivity?.() ?? null,
				lastTurn: deps.getLastTurnSummary?.() ?? null,
				taskBoard: deps.getTaskBoard?.() ?? null,
				localCapacity: dispatch.length > 0 ? (deps.getLocalCapacity?.() ?? null) : null,
			},
			silenceNotes: status
				? silenceNoteForms(
						status,
						now,
						normalizeRetrySettings(settings?.chat?.retry),
						routeFirstOutput(deps.getTelemetry?.(), settings?.chat?.target, settings?.chat?.model),
						routeTier(deps.providers, settings?.chat?.target),
					)
				: null,
			demo: settings ? interfaceGuidanceEnabled(settings.interface) : true,
			...(keyContext ? { keyContext } : {}),
			...(deps.getKeyHintFacts ? { keyHintFacts: deps.getKeyHintFacts() } : {}),
			background: deps.getBackgroundCalls?.() ?? [],
			welcomeVisible,
			demoHint: demoHints({
				enabled: settings !== undefined && interfaceGuidanceEnabled(settings.interface),
				...(welcomeVisible
					? {
							launchpad: launchpadShowsHints(settings?.interface?.outputDetail, width, terminalRows())
								? ("hints" as const)
								: ("plain" as const),
						}
					: {}),
				learned: (feature) => (readHarnessProfile().features[feature] ?? 0) > 0,
				shownBefore: (id) => readHarnessProfile().lessons[`footer:${id}`]?.shown ?? 0,
				onShown: (id) => setImmediate(() => recordLessonShown(`footer:${id}`)),
				now,
				quiet:
					dashboardMode !== "compact" ||
					(keyContext !== undefined && keyContext !== "idle") ||
					compactionActive ||
					["tool_blocked", "retrying", "stuck"].includes(status?.phase ?? "") ||
					(status?.activeTools ?? []).some((tool) => tool.toolName === "ask_user") ||
					notices.some((n) => n.expiresAt === null || n.expiresAt > now),
				agentActive: dispatch.some((row) => row.status === "running"),
				toolsUsed: Object.values(tools.tools).some((count) => count > 0),
				contextBusy: (contextLedger?.usedTokens ?? 0) > (contextLedger?.contextWindow ?? Infinity) * 0.4,
				dashboardKey: actionKeyLabel("clio-coder.status.toggle") ?? "Dashboard",
				shortcutFor: (command) => {
					const id = ACTION_BY_COMMAND.get(command);
					if (id === undefined || (readHarnessProfile().features[`key:${id}`] ?? 0) > 0) return null;
					return actionKeyLabel(id);
				},
				lastCommand: deps.getLastCommand?.() ?? null,
				menuKey: actionKeyLabel("clio-coder.leader") ?? "Ctrl+G",
			}),
			notices,
			endedNotices: deps.getEndedNotifications?.() ?? [],
			...(deps.dismissKeyLabel ? { dismissKeyLabel: deps.dismissKeyLabel } : {}),
			status: status ?? {
				phase: "idle",
				since: 0,
				lastMeaningfulAt: 0,
				watchdogTier: 0,
				watchdogPeak: 0,
				localRuntime: false,
			},
			toolCounts: tools,
			dispatchRows: dispatch,
			throughput: throughputMetric ?? null,
			telemetry,
			tick: frame,
			now,
		};
	};
	function composeFooter(width: number): string {
		const current = state(width);
		const lifecycleHint = deps.getLifecycleHint?.();
		const lifecycleLine = lifecycleHint ? [fitDashboardLine(clioTheme().fg("annotation", lifecycleHint), width)] : [];
		const contributed = deps.getExtensionStatus?.() ?? [];
		const extensionLine =
			dashboardMode === "expanded" && contributed.length
				? [fitDashboardLine(`Extensions: ${contributed.join(" | ")}`, width)]
				: [];
		const workspace = deps.getWorkspaceLine?.(width);
		const workspaceLine = workspace ? [fitDashboardLine(workspace, width)] : [];
		// Keep the highest-priority notice readable in full; the dismiss hint exposes the next.
		const supplementary = [...workspaceLine, ...extensionLine, ...lifecycleLine];
		const grid =
			dashboardMode === "expanded"
				? dashboardPageViewport(
						current,
						width,
						terminalRows() - supplementary.length,
						actionKeyLabel("clio-coder.status.toggle") ?? "",
						scrollOffset,
					)
				: renderCompactDashboard(current, width);
		if (!Array.isArray(grid)) {
			scrollOffset = grid.offset;
			maxScrollOffset = grid.maxOffset;
			scrollRows = Math.max(1, grid.rows.length - 4);
		}
		const lines = [...(Array.isArray(grid) ? grid : grid.rows), ...supplementary];
		deps.onHeightChange?.(Math.max(2, lines.length));
		return lines.join("\n");
	}
	const refresh = (): void => {
		if (disposed) return;
		view.composeAt(deps.getTerminalColumns?.() ?? process.stdout.columns ?? 80);
	};
	const setExpanded = (expanded: boolean): void => {
		dashboardMode = expanded ? "expanded" : "compact";
		scrollOffset = 0;
		refresh();
	};
	refresh();
	const resolveBranch = deps.resolveCurrentBranch ?? getCurrentBranch;
	void resolveBranch(process.cwd()).then((name) => {
		if (disposed) return;
		if (name === null) return;
		branchSlot = name;
		refresh();
	});
	return {
		view,
		refresh,
		mode() {
			return dashboardMode;
		},
		isExpanded() {
			return dashboardMode === "expanded";
		},
		setExpanded,
		scroll(delta) {
			if (dashboardMode !== "expanded") return false;
			const step = Math.sign(delta) * Math.min(Math.abs(delta), scrollRows);
			scrollOffset = Math.max(0, Math.min(maxScrollOffset, scrollOffset + step));
			refresh();
			return true;
		},
		toggleExpanded() {
			setExpanded(dashboardMode === "compact");
			return dashboardMode;
		},
		dispose() {
			disposed = true;
		},
	};
}

export type { NotificationCenter };
