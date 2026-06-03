import type { ClioSettings } from "../../core/config.js";
import { readClioVersion } from "../../core/package-root.js";
import type { ModesContract } from "../../domains/modes/index.js";
import type { UsageBreakdown } from "../../domains/observability/index.js";
import { type ProvidersContract, resolveRuntimeTarget } from "../../domains/providers/index.js";
import type { ContextUsageSnapshot } from "../../domains/session/context-accounting.js";
import { Text } from "../../engine/tui.js";
import { getCurrentBranch } from "../../utils/git.js";
import type { DispatchBoardRow } from "../dispatch-board.js";
import { contextSegment, type FooterPanel, formatFooterTokens, tokensSegment } from "../footer-panel.js";
import type { AgentStatus } from "../status/index.js";
import { resolveFooterVerb, spinnerFrame } from "../status/index.js";
import { abbreviateModelId, collapseHomePath } from "../theme/index.js";
import {
	dispatchRows,
	dispatchSeparator,
	fitDashboardLine,
	formatToolTally,
	identityLine,
	loopCluster,
	type ToolTallySnapshot,
} from "./widgets.js";

export interface FooterDashboardDeps {
	modes: ModesContract;
	providers: ProvidersContract;
	getSettings?: () => Readonly<ClioSettings>;
	getAgentStatus?: () => AgentStatus;
	getTerminalColumns?: () => number;
	getSessionTokens?: () => UsageBreakdown;
	getContextUsage?: () => ContextUsageSnapshot;
	getDispatchRows?: () => ReadonlyArray<DispatchBoardRow>;
	getToolCounts?: () => ToolTallySnapshot;
	now?: () => number;
}

export interface FooterDashboardRenderState {
	mode: string;
	cwd: string;
	branch: string | null;
	targetLabel: string;
	thinkingLabel: string;
	context: string | null;
	tokens: string | null;
	statusText: string | null;
	toolTally: string;
	dispatchRows: ReadonlyArray<DispatchBoardRow>;
	version: string;
}

function targetState(deps: FooterDashboardDeps): {
	targetLabel: string;
	thinkingLabel: string;
} {
	const settings = deps.getSettings?.();
	const endpointId = settings?.orchestrator?.endpoint?.trim();
	const wireModelId = settings?.orchestrator?.model?.trim();
	if (!settings || !endpointId || !wireModelId) {
		return { targetLabel: "no-endpoint", thinkingLabel: "off" };
	}
	const resolved = resolveRuntimeTarget(deps.providers, {
		endpointId,
		wireModelId,
		requestedThinkingLevel: settings.orchestrator?.thinkingLevel ?? "off",
		use: "orchestrator",
	});
	const thinking = resolved.ok
		? resolved.target.modelRuntime.thinking.display
		: (settings.orchestrator?.thinkingLevel ?? "off");
	return {
		targetLabel: `${endpointId}·${abbreviateModelId(wireModelId)}`,
		thinkingLabel: thinking,
	};
}

function statusText(status: AgentStatus | undefined, now: number, width: number, frame: number): string | null {
	if (!status || status.phase === "idle") return null;
	const verb = resolveFooterVerb(status, now, width);
	if (!verb) return status.phase.replace(/_/g, " ");
	return status.phase === "ended" ? verb.text : `${spinnerFrame(frame)} ${verb.text}`;
}

export function renderFooterDashboardLines(state: FooterDashboardRenderState, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	return [
		identityLine({
			width: safeWidth,
			mode: state.mode,
			branch: state.branch,
			targetLabel: state.targetLabel,
			thinkingLabel: state.thinkingLabel,
			context: state.context,
			version: state.version,
		}),
	];
}

export function renderFooterStatusLines(state: FooterDashboardRenderState, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const lines = loopCluster(
		{
			mode: state.mode,
			cwd: state.cwd,
			branch: state.branch,
			targetLabel: state.targetLabel,
			thinkingLabel: state.thinkingLabel,
			context: state.context,
			tokens: state.tokens,
			statusText: state.statusText,
			toolTally: state.toolTally,
		},
		safeWidth,
	);
	if (state.dispatchRows.length > 0) {
		lines.push(dispatchSeparator(safeWidth));
		lines.push(...dispatchRows(state.dispatchRows, safeWidth));
	}
	return lines.map((line) => fitDashboardLine(line, safeWidth));
}

export interface FooterDashboardPanel extends FooterPanel {
	statusLines(width: number): string[];
}

export function buildFooterDashboard(deps: FooterDashboardDeps): FooterDashboardPanel {
	const view = new Text("", 0, 0);
	let branchSlot: string | null = null;
	let frame = 0;
	const now = (): number => deps.now?.() ?? Date.now();
	const state = (width: number): FooterDashboardRenderState => {
		const dispatch = deps.getDispatchRows?.() ?? [];
		const tools = deps.getToolCounts?.() ?? { tools: {}, errors: 0 };
		const status = deps.getAgentStatus?.();
		const target = targetState(deps);
		const usage = deps.getSessionTokens?.();
		const tokens = tokensSegment(usage);
		const context = contextSegment(deps.getContextUsage?.());
		return {
			mode: deps.modes.current().toLowerCase(),
			cwd: collapseHomePath(process.cwd()),
			branch: branchSlot,
			targetLabel: target.targetLabel,
			thinkingLabel: target.thinkingLabel,
			context,
			tokens: tokens ? `tok ${tokens}` : usage?.totalTokens ? `Σ${formatFooterTokens(usage.totalTokens)}` : null,
			statusText: statusText(status, now(), width, frame),
			toolTally: formatToolTally(tools),
			dispatchRows: dispatch,
			version: readClioVersion(),
		};
	};
	const refresh = (): void => {
		const width = deps.getTerminalColumns?.() ?? process.stdout.columns ?? 80;
		const current = state(width);
		if (current.statusText) frame = (frame + 1) % 10;
		view.setText(renderFooterDashboardLines(current, width).join("\n"));
		view.invalidate();
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
	};
}
