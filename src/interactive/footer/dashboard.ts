import type { ClioSettings } from "../../core/config.js";
import { readClioVersion } from "../../core/package-root.js";
import type { ContextState } from "../../domains/context/index.js";
import type { TokenThroughputSnapshot, UsageBreakdown } from "../../domains/observability/index.js";
import {
	type CapabilityFlags,
	type ProvidersContract,
	resolveModelCapabilities,
	resolveModelRuntimeCapabilitiesForProviders,
} from "../../domains/providers/index.js";
import type { ContextUsageSnapshot } from "../../domains/session/context-accounting.js";
import type { ContextLedger } from "../../domains/session/context-ledger.js";
import type { WorkspaceSnapshot } from "../../domains/session/workspace/index.js";
import { Text, visibleWidth } from "../../engine/tui.js";
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
import { abbreviateModelId, barSep, clioTheme, collapseHomePath, GLYPH, rule } from "../theme/index.js";
import {
	formatNotificationBadge,
	formatNotificationPanel,
	type Notification,
	type NotificationCenter,
} from "./notifications.js";

function capabilityLabels(caps: CapabilityFlags | null): string[] {
	if (!caps) return [];
	const out: string[] = [];
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
	compactPrimaryLine,
	compactSecondaryLine,
	contextQuadrant,
	EXPANDED_MID,
	EXPANDED_ULTRAWIDE,
	EXPANDED_WIDE,
	fitDashboardLine,
	formatToolTally,
	formatUsd,
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
	providers: ProvidersContract;
	getSettings?: () => Readonly<ClioSettings>;
	getAgentStatus?: () => AgentStatus;
	getTerminalColumns?: () => number;
	getSessionTokens?: () => UsageBreakdown;
	getTokenThroughput?: () => TokenThroughputSnapshot | null;
	getSessionCost?: () => number;
	getContextUsage?: () => ContextUsageSnapshot;
	getContextLedger?: () => ContextLedger;
	getDispatchRows?: () => ReadonlyArray<DispatchBoardRow>;
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
	dismissKeyLabel?: string;
	now?: () => number;
	resolveCurrentBranch?: (cwd: string) => Promise<string | null>;
}

export interface FooterDashboardRenderState {
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
	sessionCost: number | null;
	tick: number;
	now: number;
}

function statusText(status: AgentStatus | undefined, now: number, width: number, frame: number): string | null {
	if (!status || status.phase === "idle") return null;
	const verb = resolveFooterVerb(status, now, width);
	if (!verb) return status.phase.replace(/_/g, " ");
	return status.phase === "ended" ? verb.text : `${spinnerFrame(frame)} ${verb.text}`;
}

function costSegment(value: number | undefined): string | null {
	return typeof value === "number" && Number.isFinite(value) ? `cost ${formatUsd(value)}` : null;
}

/** Compact footer: two always-on lines, deliberately free of model/mode/thinking (the editor rail owns those). */
export function renderFooterCompactLines(state: FooterDashboardRenderState, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	return [
		compactPrimaryLine(
			state.workspace,
			state.session,
			safeWidth,
			undefined, // theme
			state.status,
			state.toolCounts,
			state.dispatchRows,
			state.tick,
			state.now,
		),
		compactSecondaryLine(
			state.context,
			state.agent,
			safeWidth,
			undefined, // theme
			state.status,
			state.throughput,
			state.sessionTokens,
			state.sessionCost,
		),
	].map((line) => fitDashboardLine(line, safeWidth));
}

/** Notice surface, composed by the view below the grid: compact badge or expanded panel. */
export function renderFooterNotices(
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

export function renderFooterDashboardLines(
	state: FooterDashboardRenderState,
	width: number,
	mode: FooterDashboardMode = "compact",
): string[] {
	return mode === "expanded" ? renderFooterStatusLines(state, width) : renderFooterCompactLines(state, width);
}

/**
 * Expanded footer: responsive quadrants.
 * Widths at 120 columns and above use four weighted horizontal sections.
 * Widths from 80 to 119 columns use a two by two grid.
 * Widths below 80 columns use a vertical stack with all sections retained.
 */
export function renderFooterStatusLines(state: FooterDashboardRenderState, width: number): string[] {
	const theme = clioTheme();
	const safeWidth = Math.max(1, Math.floor(width));
	const header = headerLine(state.session, safeWidth);

	if (safeWidth >= EXPANDED_ULTRAWIDE) {
		const sep = barSep(theme);
		const widths = expandedWideColumnWidths(safeWidth, visibleWidth(sep) * 3);
		const blocks = [
			workspaceQuadrant(state.workspace, { width: widths[0] }),
			sessionQuadrant(state.session, { width: widths[1] }),
			contextQuadrant(state.context, { width: widths[2] }),
			activityQuadrant(state.agent, {
				width: widths[3],
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
		];
		return [header, rule(theme, safeWidth), ...zipColumnBlocks(blocks, widths, sep)].map((line) =>
			fitDashboardLine(line, safeWidth),
		);
	}

	if (safeWidth >= EXPANDED_WIDE) {
		const sep = barSep(theme);
		const [topLeftWidth, topRightWidth] = expandedPairWidths(safeWidth, visibleWidth(sep), "session");
		const [bottomLeftWidth, bottomRightWidth] = expandedPairWidths(safeWidth, visibleWidth(sep), "context");
		const top = zipColumns(
			workspaceQuadrant(state.workspace, { width: topLeftWidth }),
			sessionQuadrant(state.session, { width: topRightWidth }),
			topLeftWidth,
			topRightWidth,
			sep,
		);
		const bottom = zipColumns(
			contextQuadrant(state.context, { width: bottomLeftWidth }),
			activityQuadrant(state.agent, {
				width: bottomRightWidth,
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
			bottomLeftWidth,
			bottomRightWidth,
			sep,
		);
		return [header, rule(theme, safeWidth), ...top, "", ...bottom].map((line) => fitDashboardLine(line, safeWidth));
	}

	const blocks = [
		workspaceQuadrant(state.workspace, { width: safeWidth }),
		sessionQuadrant(state.session, { width: safeWidth }),
		contextQuadrant(state.context, { width: safeWidth }),
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
	];
	return [header, rule(theme, safeWidth), ...blocks.flatMap((block) => [...block, ""]).slice(0, -1)].map((line) =>
		fitDashboardLine(line, safeWidth),
	);
}

function expandedWideColumnWidths(width: number, totalSepWidth: number): [number, number, number, number] {
	const available = Math.max(0, width - totalSepWidth);
	const widths: [number, number, number, number] = [27, 29, 31, 24];
	let remaining = Math.max(0, available - widths.reduce((sum, item) => sum + item, 0));
	const max: [number, number, number, number] = [30, 34, 36, Number.POSITIVE_INFINITY];
	const order = [2, 1, 3, 0] as const;
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

function expandedPairWidths(width: number, sepWidth: number, priority: "session" | "context"): [number, number] {
	const available = Math.max(0, width - sepWidth);
	const leftWeight = priority === "context" ? 0.53 : 0.47;
	const left = Math.floor(available * leftWeight);
	return [left, available - left];
}

function headerLine(session: SessionFacts, width: number): string {
	const theme = clioTheme();
	const left = theme.style("title", `${GLYPH.agent} CLIO DASHBOARD`, { bold: true });
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
	return value ? `CLIO.md ${value}` : null;
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

export function buildFooterDashboard(deps: FooterDashboardDeps): FooterDashboardPanel {
	const view = new Text("", 0, 0);
	let branchSlot: string | null = null;
	let frame = 0;
	let dashboardMode: FooterDashboardMode = "compact";
	let disposed = false;
	const now = (): number => deps.now?.() ?? Date.now();
	const state = (width: number): FooterDashboardRenderState => {
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
		const sessionInfo = deps.getSessionInfo?.() ?? { id: null, name: null, turns: null };
		const contextState = deps.getContextState?.() ?? null;
		const tokensLabel = tokens || (usage?.totalTokens ? `Σ${formatFooterTokens(usage.totalTokens)}` : null);

		const statuses = deps.providers.list();
		const current = settings?.orchestrator?.target
			? (statuses.find((s) => s.target.id === settings.orchestrator?.target) ?? null)
			: null;

		const targetLabel = settings?.orchestrator?.target ?? "none";
		const modelLabel = settings?.orchestrator?.model ?? "none";
		const target = `${targetLabel} · ${abbreviateModelId(modelLabel)}`;

		const resolution = resolveModelRuntimeCapabilitiesForProviders(
			deps.providers,
			settings?.orchestrator?.target,
			settings?.orchestrator?.model,
			settings?.orchestrator?.thinkingLevel ?? "off",
		);

		const thinking = resolution?.thinking.display ?? settings?.orchestrator?.thinkingLevel ?? "off";

		const wireModelId = settings?.orchestrator?.model ?? current?.target.defaultModel ?? null;
		const detectedReasoning =
			wireModelId && typeof deps.providers.getDetectedReasoning === "function"
				? deps.providers.getDetectedReasoning(settings?.orchestrator?.target ?? "", wireModelId)
				: null;
		const caps = current
			? resolveModelCapabilities(current, wireModelId, deps.providers.knowledgeBase, { detectedReasoning })
			: null;
		const capabilities = capabilityLabels(caps);

		const safety = settings?.autonomy ?? "auto-edit";
		const toolProfile = settings?.delegation?.defaults?.toolGovernance ?? "clio-policy";

		return {
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
				thinking,
				capabilities,
				safety,
				toolProfile,
			},
			context: {
				label: null,
				used: contextUsage?.tokens ?? null,
				contextWindow: contextUsage?.contextWindow ?? null,
				toolSchemaTokens: contextUsage?.breakdown?.toolSchemaTokens ?? null,
				compactionThreshold: settings?.compaction?.threshold ?? null,
				compactionAuto: settings?.compaction?.auto ?? null,
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
				toolTally: formatToolTally(tools),
				dispatchRows: dispatch,
				contextActivity: deps.getContextActivity?.() ?? null,
				lastTurn: deps.getLastTurnSummary?.() ?? null,
			},
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
	const refresh = (): void => {
		if (disposed) return;
		const width = deps.getTerminalColumns?.() ?? process.stdout.columns ?? 80;
		const current = state(width);
		if (current.agent.statusText) frame = (frame + 1) % 10;
		const grid = renderFooterDashboardLines(current, width, dashboardMode);
		const notices = renderFooterNotices(current.notices, width, dashboardMode, deps.dismissKeyLabel);
		view.setText([...grid, ...notices].join("\n"));
		view.invalidate();
	};
	const setExpanded = (expanded: boolean): void => {
		dashboardMode = expanded ? "expanded" : "compact";
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
			setExpanded(dashboardMode !== "expanded");
			return dashboardMode;
		},
		dispose() {
			disposed = true;
		},
	};
}

export type { NotificationCenter };
