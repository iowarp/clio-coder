import type { ClioSettings } from "../../core/config.js";
import { readHarnessProfile } from "../../core/harness-profile.js";
import { readClioVersion } from "../../core/package-root.js";
import type { LiveBudgetView } from "../../domains/context/budget/live-view.js";
import type { ContextState } from "../../domains/context/index.js";
import type { TaskMemoryOperatorStatus } from "../../domains/memory/index.js";
import {
	type CostAggregate,
	formatCostAggregate,
	type TokenThroughputSnapshot,
	type UsageBreakdown,
} from "../../domains/observability/index.js";
import {
	acceptsImageInput,
	type CapabilityFlags,
	type ProvidersContract,
	resolveModelCapabilities,
} from "../../domains/providers/index.js";
import type { UsageSnapshot } from "../../domains/quota/types.js";
import type { LocalCapacity } from "../../domains/scheduling/local-capacity.js";
import type { ContextUsageSnapshot } from "../../domains/session/context-accounting.js";
import type { ContextLedger } from "../../domains/session/context-ledger.js";
import type { TaskBoardSnapshot } from "../../domains/session/task-board.js";
import type { WorkspaceSnapshot } from "../../domains/session/workspace/index.js";
import { getKeybindings, Text, visibleWidth } from "../../engine/tui.js";
import { getCurrentBranch } from "../../utils/git.js";
import type { DispatchBoardRow } from "../dispatch-board.js";
import {
	dispatchSegment,
	type FooterPanel,
	formatFooterTokens,
	throughputDetailSegment,
	throughputSegment,
	tokensSegment,
} from "../footer-panel.js";
import type { AgentStatus, TurnSummary } from "../status/index.js";
import { resolveFooterVerb, spinnerFrame } from "../status/index.js";
import {
	animationStep,
	barSep,
	brandMark,
	clioTheme,
	collapseHomePath,
	formatTargetLabel,
	rule,
	screenTitle,
} from "../theme/index.js";
import { createDemoHints } from "./demo-hints.js";
import {
	formatNotificationBadge,
	formatNotificationPanel,
	type Notification,
	type NotificationCenter,
} from "./notifications.js";
import { DASHBOARD_PAGES, type DashboardPage, renderCompactDashboard, renderDashboardPage } from "./pages.js";
import { createLocalMachineSampler, type LocalMachineMetrics } from "./system-metrics.js";

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

import {
	type AgentWorkFacts,
	activityQuadrant,
	type ContextEngineFacts,
	contextQuadrant,
	EXPANDED_MID,
	EXPANDED_ULTRAWIDE,
	EXPANDED_WIDE,
	fitDashboardLine,
	formatToolTally,
	type SessionFacts,
	sessionQuadrant,
	type ToolTallySnapshot,
	type WorkspaceFacts,
	workspaceQuadrant,
	zipColumnBlocks,
	zipColumns,
} from "./widgets.js";

export type { ToolTallySnapshot } from "./widgets.js";

export type FooterDashboardMode = "compact" | "expanded";

export interface FooterDashboardDeps {
	getQuotaSnapshots?: () => ReadonlyArray<UsageSnapshot>;
	getConnections?: () => { mcp: string[]; plugins: string[] };
	getExtensionStatus?: () => ReadonlyArray<string>;
	getLifecycleHint?: () => string | null;
	providers: ProvidersContract;
	getSettings?: () => Readonly<ClioSettings>;
	getAgentStatus?: () => AgentStatus;
	getTerminalColumns?: () => number;
	getTerminalRows?: () => number;
	getSessionTokens?: () => UsageBreakdown;
	getTokenThroughput?: () => TokenThroughputSnapshot | null;
	getSessionCost?: () => CostAggregate;
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
	/** Whether the Ctrl+G leader is armed and waiting for its next key. */
	getLeaderArmed?: () => boolean;
	/** Whether a Ctrl+C armed the double tap and its window is still open. */
	getShutdownArmed?: () => boolean;
	/** Skills whose tool surface is armed across turns; the compact line names them. */
	getActiveSkillSurface?: () => ReadonlyArray<string>;
	dismissKeyLabel?: string;
	now?: () => number;
	resolveCurrentBranch?: (cwd: string) => Promise<string | null>;
}

export interface FooterDashboardRenderState {
	quota?: ReadonlyArray<UsageSnapshot>;
	quotaRoute?: Pick<DispatchBoardRow, "runtimeId" | "wireModelId" | "node">;
	demoHint?: string | null;
	/** interface.demo. False hides the rotating key hints with the tips; absent reads as on. */
	demo?: boolean;
	resources?: LocalMachineMetrics | null;
	connections?: { mcp: string[]; plugins: string[] };
	costCeilingUsd?: number;

	workspace: WorkspaceFacts;
	session: SessionFacts;
	context: ContextEngineFacts;
	agent: AgentWorkFacts;
	notices: ReadonlyArray<Notification>;
	status: AgentStatus;
	toolCounts: ToolTallySnapshot;
	dispatchRows: ReadonlyArray<DispatchBoardRow>;
	throughput: TokenThroughputSnapshot | null;
	sessionTokens: UsageBreakdown | null;
	sessionCost: CostAggregate | null;
	tick: number;
	now: number;
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

/** Null before anything has been priced, so the footer shows no cost field at all. */
function costSegment(value: CostAggregate | undefined): string | null {
	const cost = formatCostAggregate(value);
	return cost === null ? null : `cost ${cost}`;
}

/** The compact and expanded dashboard share the same live facts. */
function renderFooterCompactLines(state: FooterDashboardRenderState, width: number): string[] {
	return renderCompactDashboard(state, width);
}

/** Notice surface, composed by the view below the grid: compact badge or expanded panel. */
function renderFooterNotices(
	notices: ReadonlyArray<Notification>,
	width: number,
	mode: FooterDashboardMode,
	dismissKeyLabel?: string,
): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	if (mode === "expanded") {
		return formatNotificationPanel(notices, safeWidth, dismissKeyLabel ? { dismissKeyLabel } : {});
	}
	const badge = formatNotificationBadge(notices, safeWidth, dismissKeyLabel ? { dismissKeyLabel } : {});
	return badge ? [badge] : [];
}

function renderFooterDashboardLines(
	state: FooterDashboardRenderState,
	width: number,
	mode: FooterDashboardMode = "compact",
): string[] {
	return mode === "expanded" ? renderFooterStatusLines(state, width) : renderFooterCompactLines(state, width);
}

/**
 * Expanded footer: responsive sections ordered by operational urgency.
 * Widths at 220 columns and above use four weighted horizontal sections.
 * Widths from 80 to 219 columns use a two by two grid.
 * Widths below 80 columns use a vertical stack with all sections retained.
 */
function renderFooterStatusLines(state: FooterDashboardRenderState, width: number): string[] {
	const theme = clioTheme();
	const safeWidth = Math.max(1, Math.floor(width));
	const header = headerLine(state.session, safeWidth);

	if (safeWidth >= EXPANDED_ULTRAWIDE) {
		const sep = barSep(theme);
		const widths = expandedWideColumnWidths(safeWidth, visibleWidth(sep) * 3);
		const blocks = [
			activityQuadrant(state.agent, {
				width: widths[0],
				maxWorkers: 4,
				status: state.status,
				toolCounts: state.toolCounts,
				throughput: state.throughput,
				sessionTokens: state.sessionTokens,
				sessionCost: state.sessionCost,
				contextUsed: state.context.used,
				tick: state.tick,
				now: state.now,
			}),
			contextQuadrant(state.context, { width: widths[1] }),
			sessionQuadrant(state.session, { width: widths[2] }),
			workspaceQuadrant(state.workspace, { width: widths[3] }),
		];
		return [header, rule(theme, safeWidth), ...zipColumnBlocks(blocks, widths, sep)].map((line) =>
			fitDashboardLine(line, safeWidth),
		);
	}

	if (safeWidth >= EXPANDED_WIDE) {
		const sep = barSep(theme);
		const [topLeftWidth, topRightWidth] = expandedPairWidths(safeWidth, visibleWidth(sep));
		const [bottomLeftWidth, bottomRightWidth] = expandedPairWidths(safeWidth, visibleWidth(sep));
		const top = zipColumns(
			activityQuadrant(state.agent, {
				width: topLeftWidth,
				maxWorkers: 4,
				status: state.status,
				toolCounts: state.toolCounts,
				throughput: state.throughput,
				sessionTokens: state.sessionTokens,
				sessionCost: state.sessionCost,
				contextUsed: state.context.used,
				tick: state.tick,
				now: state.now,
			}),
			contextQuadrant(state.context, { width: topRightWidth }),
			topLeftWidth,
			topRightWidth,
			sep,
		);
		const bottom = zipColumns(
			sessionQuadrant(state.session, { width: bottomLeftWidth }),
			workspaceQuadrant(state.workspace, { width: bottomRightWidth }),
			bottomLeftWidth,
			bottomRightWidth,
			sep,
		);
		return [header, rule(theme, safeWidth), ...top, "", ...bottom].map((line) => fitDashboardLine(line, safeWidth));
	}

	const blocks = [
		activityQuadrant(state.agent, {
			width: safeWidth,
			maxWorkers: safeWidth >= EXPANDED_MID ? 3 : 2,
			status: state.status,
			toolCounts: state.toolCounts,
			throughput: state.throughput,
			sessionTokens: state.sessionTokens,
			sessionCost: state.sessionCost,
			contextUsed: state.context.used,
			tick: state.tick,
			now: state.now,
		}),
		contextQuadrant(state.context, { width: safeWidth }),
		sessionQuadrant(state.session, { width: safeWidth }),
		workspaceQuadrant(state.workspace, { width: safeWidth }),
	];
	return [header, rule(theme, safeWidth), ...blocks.flatMap((block) => [...block, ""]).slice(0, -1)].map((line) =>
		fitDashboardLine(line, safeWidth),
	);
}

/**
 * Column widths for Activity, Context, Session, and Workspace. The base makes
 * current work the strongest column; surplus is shared by urgency until the
 * lower-priority sections reach their caps, then spills into Activity.
 */
function expandedWideColumnWidths(width: number, totalSepWidth: number): [number, number, number, number] {
	const available = Math.max(0, width - totalSepWidth);
	const widths: [number, number, number, number] = [32, 31, 27, 21];
	let remaining = Math.max(0, available - widths.reduce((sum, item) => sum + item, 0));
	const max: [number, number, number, number] = [Number.POSITIVE_INFINITY, 56, 44, 40];
	const order = [0, 1, 2, 3] as const;
	let cursor = 0;
	while (remaining > 0) {
		const index = order[cursor % order.length] ?? 3;
		if (widths[index] < max[index]) {
			widths[index] += 1;
			remaining -= 1;
		}
		cursor += 1;
	}
	return widths;
}

function expandedPairWidths(width: number, sepWidth: number): [number, number] {
	const available = Math.max(0, width - sepWidth);
	const left = Math.floor(available * 0.53);
	return [left, available - left];
}

function headerLine(session: SessionFacts, width: number): string {
	const theme = clioTheme();
	const left = `${brandMark(theme)} ${screenTitle(theme, "CLIO DASHBOARD")}`;
	const right = theme.fg("dim", `v${session.version}`);
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return fitDashboardLine(`${left}${" ".repeat(gap)}${right}`, width);
}

export interface FooterDashboardPanel extends FooterPanel {
	statusLines(width: number): string[];
	mode(): FooterDashboardMode;
	isExpanded(): boolean;
	setExpanded(expanded: boolean): void;
	toggleExpanded(): FooterDashboardMode;
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
	private readonly compose: (width: number) => string;

	constructor(compose: (width: number) => string) {
		super("", 0, 0);
		this.compose = compose;
	}

	composeAt(width: number): void {
		this.composedWidth = width;
		this.setText(this.compose(width));
	}

	override render(width: number): string[] {
		if (width !== this.composedWidth) this.composeAt(width);
		return super.render(width);
	}
}

export function buildFooterDashboard(deps: FooterDashboardDeps): FooterDashboardPanel {
	const view = new FooterText((width) => composeFooter(width));
	const demoHints = createDemoHints();
	let branchSlot: string | null = null;
	let dashboardMode: FooterDashboardMode = "compact";
	let page: DashboardPage = "Activity";
	let disposed = false;
	const now = (): number => deps.now?.() ?? Date.now();
	const state = (width: number): FooterDashboardRenderState => {
		// Every refresh within one animation step composes the same spinner, so a
		// refresh the status stream asks for between ticks costs no bytes.
		const frame = animationStep(now());
		const dispatch = deps.getDispatchRows?.() ?? [];
		const tools = deps.getToolCounts?.() ?? { tools: {}, errors: 0 };
		const status = deps.getAgentStatus?.();
		const compactionActive = status?.phase === "compacting" || (status?.activePhases?.has("compacting") ?? false);
		const usage = deps.getSessionTokens?.();
		const tokens = tokensSegment(usage);
		const throughputMetric = deps.getTokenThroughput?.();
		const throughput = throughputSegment(throughputMetric);
		const throughputDetail = throughputDetailSegment(throughputMetric);
		const contextUsage = deps.getContextUsage?.();
		const contextLedger = deps.getContextLedger?.() ?? null;
		const settings = deps.getSettings?.();
		const taskMemory = deps.getTaskMemoryStatus?.() ?? null;
		const sessionInfo = deps.getSessionInfo?.() ?? { id: null, name: null, turns: null };
		const contextState = deps.getContextState?.() ?? null;
		const tokensLabel = tokens || (usage?.totalTokens ? `Σ${formatFooterTokens(usage.totalTokens)}` : null);

		const statuses = deps.providers.list();
		const current = settings?.chat?.target ? (statuses.find((s) => s.target.id === settings.chat?.target) ?? null) : null;

		const target = formatTargetLabel(settings?.chat?.target, settings?.chat?.model, { abbreviate: false });

		const wireModelId = settings?.chat?.model ?? current?.target.defaultModel ?? null;
		const detectedReasoning =
			wireModelId && typeof deps.providers.getDetectedReasoning === "function"
				? deps.providers.getDetectedReasoning(settings?.chat?.target ?? "", wireModelId)
				: null;
		const caps = current
			? resolveModelCapabilities(current, wireModelId, deps.providers.knowledgeBase, { detectedReasoning })
			: null;
		const capabilities = capabilityLabels(caps);

		const safety = settings?.safety.autonomy ?? "default";
		const toolProfile = settings?.integrations.externalAgents?.defaults?.toolGovernance ?? "clio-coder-policy";

		return {
			resources: machine.snapshot(),
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
				name: sessionInfo.name,
				id: sessionInfo.id,
				version: readClioVersion(),
				turns: sessionInfo.turns,
				tokens: tokensLabel,
				throughput,
				throughputDetail,
				cost: costSegment(deps.getSessionCost?.()),
				target,
				targetId: settings?.chat?.target ?? null,
				modelId: settings?.chat?.model ?? null,
				capabilities,
				safety,
				toolProfile,
				outputStyle: settings?.interface.outputDetail ?? "standard",
				leaderArmed: deps.getLeaderArmed?.() ?? false,
				shutdownArmed: deps.getShutdownArmed?.() ?? false,
				activeSkills: deps.getActiveSkillSurface?.() ?? [],
				memoryIntervention: taskMemory
					? {
							enabled: taskMemory.enabled,
							tier: taskMemory.tier,
							size: taskMemory.size,
							stepInFlight: taskMemory.stepInFlight,
							lastDecision: taskMemory.lastDecision,
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
				statusText: statusText(status, now(), width, frame),
				dispatchSummary: dispatchSegment(dispatch),
				toolTally: formatToolTally(tools, contextLedger?.toolCount ?? null),
				dispatchRows: dispatch,
				contextActivity: deps.getContextActivity?.() ?? null,
				lastTurn: deps.getLastTurnSummary?.() ?? null,
				taskBoard: deps.getTaskBoard?.() ?? null,
				localCapacity: dispatch.length > 0 ? (deps.getLocalCapacity?.() ?? null) : null,
			},
			demo: settings?.interface.demo !== false,
			demoHint: demoHints({
				enabled: settings?.interface.demo === true,
				learned: (feature) => (readHarnessProfile().features[feature] ?? 0) > 0,
				now: now(),
				quiet:
					dashboardMode !== "compact" ||
					compactionActive ||
					["tool_blocked", "retrying", "stuck"].includes(status?.phase ?? "") ||
					(status?.activeTools ?? []).some((tool) => tool.toolName === "ask_user") ||
					(deps.getNotifications?.() ?? []).some((n) => n.expiresAt === null || n.expiresAt > now()),
				agentActive: dispatch.some((row) => row.status === "running"),
				toolsUsed: Object.values(tools.tools).some((count) => count > 0),
				contextBusy: (contextLedger?.usedTokens ?? 0) > (contextLedger?.contextWindow ?? Infinity) * 0.4,
				dashboardKey: getKeybindings().getKeys("clio-coder.status.toggle").join("/") || "Dashboard",
			}),
			notices: deps.getNotifications?.() ?? [],
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
			sessionTokens: usage ?? null,
			sessionCost: deps.getSessionCost?.() ?? null,
			tick: frame,
			now: now(),
		};
	};
	function composeFooter(width: number): string {
		const current = state(width);
		const lifecycleHint = deps.getLifecycleHint?.();
		const lifecycleLine = lifecycleHint ? [fitDashboardLine(clioTheme().fg("dim", lifecycleHint), width)] : [];
		const notices =
			dashboardMode === "compact" ? [] : renderFooterNotices(current.notices, width, dashboardMode, deps.dismissKeyLabel);
		const contributed = deps.getExtensionStatus?.() ?? [];
		const extensionLine =
			dashboardMode === "expanded" && contributed.length
				? [fitDashboardLine(`Extensions: ${contributed.join(" | ")}`, width)]
				: [];
		const grid =
			dashboardMode === "expanded"
				? renderDashboardPage(
						current,
						page,
						width,
						(deps.getTerminalRows?.() ?? process.stdout.rows ?? 40) -
							notices.length -
							extensionLine.length -
							lifecycleLine.length,
						getKeybindings().getKeys("clio-coder.status.toggle").join(" / "),
					)
				: renderFooterDashboardLines(current, width, dashboardMode);
		return [...grid, ...extensionLine, ...lifecycleLine, ...notices].join("\n");
	}
	const refresh = (): void => {
		if (disposed) return;
		view.composeAt(deps.getTerminalColumns?.() ?? process.stdout.columns ?? 80);
	};
	const setExpanded = (expanded: boolean): void => {
		dashboardMode = expanded ? "expanded" : "compact";
		page = "Activity";
		refresh();
	};
	const machine = createLocalMachineSampler(() => {
		if (!disposed) refresh();
	});
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
		statusLines(width: number) {
			return renderFooterStatusLines(state(width), width);
		},
		mode() {
			return dashboardMode;
		},
		isExpanded() {
			return dashboardMode === "expanded";
		},
		setExpanded,
		toggleExpanded() {
			if (dashboardMode === "compact") setExpanded(true);
			else if (page === "Status") setExpanded(false);
			else {
				page = DASHBOARD_PAGES[DASHBOARD_PAGES.indexOf(page) + 1] ?? "Activity";
				refresh();
			}
			return dashboardMode;
		},
		dispose() {
			disposed = true;
			machine.dispose();
		},
	};
}

export type { NotificationCenter };
