import type { ClioSettings } from "../../core/config.js";
import { readClioVersion } from "../../core/package-root.js";
import type { ContextState } from "../../domains/context/index.js";
import type { ModesContract } from "../../domains/modes/index.js";
import type { TokenThroughputSnapshot, UsageBreakdown } from "../../domains/observability/index.js";
import type { ProvidersContract } from "../../domains/providers/index.js";
import type { ContextUsageSnapshot } from "../../domains/session/context-accounting.js";
import type { WorkspaceSnapshot } from "../../domains/session/workspace/index.js";
import { Text, visibleWidth } from "../../engine/tui.js";
import { getCurrentBranch } from "../../utils/git.js";
import type { DispatchBoardRow } from "../dispatch-board.js";
import {
	contextSegment,
	dispatchSegment,
	type FooterPanel,
	formatFooterTokens,
	throughputDetailSegment,
	throughputSegment,
	tokensSegment,
} from "../footer-panel.js";
import type { AgentStatus } from "../status/index.js";
import { resolveFooterVerb, spinnerFrame } from "../status/index.js";
import { barSep, clioTheme, collapseHomePath, GLYPH, rule } from "../theme/index.js";
import {
	formatNotificationBadge,
	formatNotificationPanel,
	type Notification,
	type NotificationCenter,
} from "./notifications.js";
import {
	type AgentWorkFacts,
	agentQuadrant,
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
	modes: ModesContract;
	providers: ProvidersContract;
	getSettings?: () => Readonly<ClioSettings>;
	getAgentStatus?: () => AgentStatus;
	getTerminalColumns?: () => number;
	getSessionTokens?: () => UsageBreakdown;
	getTokenThroughput?: () => TokenThroughputSnapshot | null;
	getSessionCost?: () => number;
	getContextUsage?: () => ContextUsageSnapshot;
	getDispatchRows?: () => ReadonlyArray<DispatchBoardRow>;
	getToolCounts?: () => ToolTallySnapshot;
	getWorkspaceSnapshot?: () => WorkspaceSnapshot | null;
	getSessionInfo?: () => { id: string | null; name: string | null; turns: number | null };
	getExtensionStats?: () => { active: number; installed: number };
	getContextState?: () => ContextState;
	getNotifications?: () => ReadonlyArray<Notification>;
	dismissKeyLabel?: string;
	now?: () => number;
}

export interface FooterDashboardRenderState {
	workspace: WorkspaceFacts;
	session: SessionFacts;
	context: ContextEngineFacts;
	agent: AgentWorkFacts;
	notices: ReadonlyArray<Notification>;
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
		compactPrimaryLine(state.workspace, state.session, safeWidth),
		compactSecondaryLine(state.context, state.agent, safeWidth),
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
 *   - >=100: four horizontal sections.
 *   - 80-99: 2x2 sections.
 *   - <80: vertical stack with all sections retained.
 */
export function renderFooterStatusLines(state: FooterDashboardRenderState, width: number): string[] {
	const theme = clioTheme();
	const safeWidth = Math.max(1, Math.floor(width));
	const header = headerLine(state.session, safeWidth);

	if (safeWidth >= EXPANDED_ULTRAWIDE) {
		const sep = barSep(theme);
		const sepWidth = visibleWidth(sep) * 3;
		const available = safeWidth - sepWidth;
		const baseWidth = Math.floor(available / 4);
		const widths = [baseWidth, baseWidth, baseWidth, available - baseWidth * 3];
		const blocks = [
			workspaceQuadrant(state.workspace),
			sessionQuadrant(state.session),
			contextQuadrant(state.context),
			agentQuadrant(state.agent, { maxWorkers: 4 }),
		];
		return [header, rule(theme, safeWidth), ...zipColumnBlocks(blocks, widths, sep)].map((line) =>
			fitDashboardLine(line, safeWidth),
		);
	}

	if (safeWidth >= EXPANDED_WIDE) {
		const sep = barSep(theme);
		const sepWidth = 3;
		const leftWidth = Math.floor((safeWidth - sepWidth) / 2);
		const rightWidth = safeWidth - sepWidth - leftWidth;
		const top = zipColumns(
			workspaceQuadrant(state.workspace),
			sessionQuadrant(state.session),
			leftWidth,
			rightWidth,
			sep,
		);
		const bottom = zipColumns(
			contextQuadrant(state.context),
			agentQuadrant(state.agent, { maxWorkers: 4 }),
			leftWidth,
			rightWidth,
			sep,
		);
		return [header, rule(theme, safeWidth), ...top, "", ...bottom].map((line) => fitDashboardLine(line, safeWidth));
	}

	const blocks = [
		workspaceQuadrant(state.workspace),
		sessionQuadrant(state.session),
		contextQuadrant(state.context),
		agentQuadrant(state.agent, { maxWorkers: safeWidth >= EXPANDED_MID ? 3 : 2 }),
	];
	return [header, rule(theme, safeWidth), ...blocks.flatMap((block) => [...block, ""]).slice(0, -1)].map((line) =>
		fitDashboardLine(line, safeWidth),
	);
}

function headerLine(session: SessionFacts, width: number): string {
	const theme = clioTheme();
	const left = theme.style("title", `${GLYPH.agent} CLIO DASHBOARD`, { bold: true });
	const right = `${theme.fg("muted", session.mode)}${theme.fg("dim", " · ")}${theme.fg("dim", `v${session.version}`)}`;
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return fitDashboardLine(`${left}${" ".repeat(gap)}${right}`, width);
}

export interface FooterDashboardPanel extends FooterPanel {
	statusLines(width: number): string[];
	mode(): FooterDashboardMode;
	isExpanded(): boolean;
	setExpanded(expanded: boolean): void;
	toggleExpanded(): FooterDashboardMode;
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
		const settings = deps.getSettings?.();
		const sessionInfo = deps.getSessionInfo?.() ?? { id: null, name: null, turns: null };
		const contextState = deps.getContextState?.() ?? null;
		const tokensLabel = tokens || (usage?.totalTokens ? `Σ${formatFooterTokens(usage.totalTokens)}` : null);
		return {
			workspace: workspaceFacts(deps, branchSlot),
			session: {
				name: sessionInfo.name,
				id: sessionInfo.id,
				mode: deps.modes.current().toLowerCase(),
				version: readClioVersion(),
				turns: sessionInfo.turns,
				tokens: tokensLabel,
				throughput,
				throughputDetail,
				cost: costSegment(deps.getSessionCost?.()),
			},
			context: {
				label: contextSegment(contextUsage),
				used: contextUsage?.tokens ?? null,
				contextWindow: contextUsage?.contextWindow ?? null,
				compactionThreshold: settings?.compaction?.threshold ?? null,
				compactionAuto: settings?.compaction?.auto ?? null,
				compactionActive,
				clioMd: formatClioMdState(contextState?.clioMd),
				memory: formatMemoryState(contextState?.memoryCount),
				extensions: deps.getExtensionStats?.() ?? null,
			},
			agent: {
				statusText: statusText(status, now(), width, frame),
				dispatchSummary: dispatchSegment(dispatch),
				toolTally: formatToolTally(tools),
				dispatchRows: dispatch,
			},
			notices: deps.getNotifications?.() ?? [],
		};
	};
	const refresh = (): void => {
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
	void getCurrentBranch(process.cwd()).then((name) => {
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
	};
}

export type { NotificationCenter };
