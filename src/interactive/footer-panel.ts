import type { ClioSettings } from "../core/config.js";
import type { ModesContract } from "../domains/modes/index.js";
import type { UsageBreakdown } from "../domains/observability/index.js";
import {
	type ProvidersContract,
	type ResolvedRuntimeTarget,
	type ResolvedThinkingCapability,
	resolveRuntimeTarget,
} from "../domains/providers/index.js";
import type { ContextUsageSnapshot } from "../domains/session/context-accounting.js";
import { Text, truncateToWidth, visibleWidth } from "../engine/tui.js";
import { getCurrentBranch } from "../utils/git.js";
import type { DispatchBoardRow, DispatchBoardStatus } from "./dispatch-board.js";
import { DIM, RESET } from "./palette.js";
import type { AgentStatus } from "./status/index.js";
import { resolveFooterVerb, spinnerFrame } from "./status/index.js";

const SEP = " \u00b7 ";
const GLYPH = "\u25c6";
const GLYPH_OPEN = "\u25c7";
const ARROW_UP = "\u2191";
const ARROW_DOWN = "\u2193";

export interface FooterDeps {
	modes: ModesContract;
	providers: ProvidersContract;
	getSettings?: () => Readonly<ClioSettings>;
	getStreaming?: () => boolean;
	getAgentStatus?: () => AgentStatus;
	getTerminalColumns?: () => number;
	/**
	 * Running session-level token totals. Drives the input/output footer
	 * segment. Invoked on every refresh so late-arriving `message_end` usage
	 * is picked up without state plumbing inside the footer. Omitted in
	 * tests and degraded boots where observability is unavailable; the
	 * footer then hides the token segment entirely.
	 */
	getSessionTokens?: () => UsageBreakdown;
	/** Current chat-loop context estimate. Drives the CTX footer segment. */
	getContextUsage?: () => ContextUsageSnapshot;
	/** Current dispatch-board rows. Drives a compact dispatch metadata segment. */
	getDispatchRows?: () => ReadonlyArray<DispatchBoardRow>;
}

/**
 * Render a token count with a single-letter magnitude suffix so the footer
 * stays short on long-running sessions. Values under 1,000 render as the
 * raw integer; 1,000-999,999 render with a `k` suffix and one decimal when
 * that digit is non-zero; 1,000,000+ uses `M`.
 */
export function formatFooterTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	const value = Math.round(n);
	if (value < 1000) return value.toString();
	if (value < 1_000_000) {
		const scaled = value / 1000;
		const fixed = scaled.toFixed(1);
		return fixed.endsWith(".0") ? `${fixed.slice(0, -2)}k` : `${fixed}k`;
	}
	const scaled = value / 1_000_000;
	const fixed = scaled.toFixed(1);
	return fixed.endsWith(".0") ? `${fixed.slice(0, -2)}M` : `${fixed}M`;
}

/**
 * Build the token-counter footer segment. Returns `null` when no usage has
 * landed yet so the footer stays uncluttered at session start. Cache-read
 * tokens are omitted here to keep the line scannable; reasoning tokens are
 * shown only when the provider exposes them. The `/cost` overlay exposes the
 * full breakdown.
 */
export function tokensSegment(usage: UsageBreakdown | null | undefined): string | null {
	if (!usage) return null;
	const input = Math.max(0, usage.input ?? 0);
	const output = Math.max(0, usage.output ?? 0);
	const reasoning = Math.max(0, usage.reasoningTokens ?? 0);
	const total = Math.max(0, usage.totalTokens ?? input + output);
	if (input + output + reasoning + total === 0) return null;
	const reasoningPart = reasoning > 0 ? ` r${formatFooterTokens(reasoning)}` : "";
	const totalPart = total > 0 ? ` Σ${formatFooterTokens(total)}` : "";
	return `${ARROW_UP}${formatFooterTokens(input)} ${ARROW_DOWN}${formatFooterTokens(output)}${reasoningPart}${totalPart}`;
}

export function buildCtxBar(percent: number | null | undefined, width = 8): string {
	const cells = Math.max(1, Math.floor(width));
	if (typeof percent !== "number" || !Number.isFinite(percent)) return "░".repeat(cells);
	const filled = Math.max(0, Math.min(cells, Math.round((Math.max(0, Math.min(100, percent)) / 100) * cells)));
	return `${"█".repeat(filled)}${"░".repeat(cells - filled)}`;
}

export function contextSegment(usage: ContextUsageSnapshot | null | undefined): string | null {
	if (!usage || usage.contextWindow <= 0) return null;
	const percent = usage.percent;
	const percentLabel = typeof percent === "number" && Number.isFinite(percent) ? `${Math.round(percent)}%` : "?%";
	const tokenLabel = usage.tokens !== null && usage.tokens > 0 ? formatFooterTokens(usage.tokens) : "?";
	return `CTX ${percentLabel} ${tokenLabel}/${formatFooterTokens(usage.contextWindow)} ${buildCtxBar(percent)}`;
}

function dispatchStatusCounts(rows: ReadonlyArray<DispatchBoardRow>): {
	active: number;
	completed: number;
	failed: number;
	tokens: number;
} {
	const activeStatuses = new Set<DispatchBoardStatus>(["running", "stale", "enqueued"]);
	const failedStatuses = new Set<DispatchBoardStatus>(["failed", "aborted", "dead"]);
	let active = 0;
	let completed = 0;
	let failed = 0;
	let tokens = 0;
	for (const row of rows) {
		if (activeStatuses.has(row.status)) active += 1;
		else if (row.status === "completed") completed += 1;
		else if (failedStatuses.has(row.status)) failed += 1;
		tokens += Math.max(0, row.tokenCount);
	}
	return { active, completed, failed, tokens };
}

export function dispatchSegment(rows: ReadonlyArray<DispatchBoardRow> | null | undefined): string | null {
	if (!rows || rows.length === 0) return null;
	const counts = dispatchStatusCounts(rows);
	const parts: string[] = [];
	if (counts.active > 0) parts.push(`${counts.active} active`);
	if (counts.completed > 0) parts.push(`${counts.completed} done`);
	if (counts.failed > 0) parts.push(`${counts.failed} fail`);
	if (counts.tokens > 0) parts.push(`${formatFooterTokens(counts.tokens)}tok`);
	return `dispatch ${parts.length > 0 ? parts.join(" ") : `${rows.length} runs`}`;
}

export interface FooterPanel {
	view: Text;
	refresh(): void;
}

interface OrchestratorTarget {
	endpointId: string;
	wireModelId: string;
	healthStatus: "healthy" | "degraded" | "unknown" | "down";
	resolved: ResolvedRuntimeTarget | null;
}

function resolveOrchestratorTarget(
	providers: ProvidersContract,
	settings: Readonly<ClioSettings>,
): OrchestratorTarget | null {
	const endpointId = settings.orchestrator?.endpoint?.trim();
	const wireModelId = settings.orchestrator?.model?.trim();
	if (!endpointId || !wireModelId) return null;
	const status = providers.list().find((entry) => entry.endpoint.id === endpointId);
	const resolved = resolveRuntimeTarget(providers, {
		endpointId,
		wireModelId,
		requestedThinkingLevel: settings.orchestrator?.thinkingLevel ?? "off",
		use: "orchestrator",
	});
	return {
		endpointId,
		wireModelId,
		healthStatus: status?.health.status ?? "unknown",
		resolved: resolved.ok ? resolved.target : null,
	};
}

/**
 * Build the thinking-segment suffix for the footer. Mechanism-aware:
 *   - effort-levels and budget-tokens render the level glyph as today.
 *   - on-off renders `◆ on` or `◆ off` (no level word).
 *   - always-on renders `◆ forced`.
 *   - none renders a dim `◇ off` so the operator sees the model has no
 *     thinking surface.
 *   - absent mechanism falls back to the legacy level glyph.
 *
 * Returns the empty string when the segment is suppressed (e.g. providers
 * report only the `off` level for the active model).
 */
export function thinkingSuffixForFooter(thinking: ResolvedThinkingCapability | null): string {
	if (!thinking) return "";
	const word = thinking.display;
	if (thinking.mechanism === "none") {
		return `${SEP}${DIM}${GLYPH_OPEN} off${RESET}`;
	}
	if (thinking.mechanism === "always-on") {
		return `${SEP}${GLYPH} ${word}`;
	}
	if (thinking.mechanism === "on-off") {
		const piece = `${SEP}${GLYPH} ${word}`;
		return word === "off" ? `${DIM}${piece}${RESET}` : piece;
	}
	if (thinking.supportedLevels.length > 1) {
		const piece = `${SEP}${GLYPH} ${word}`;
		return word === "off" ? `${DIM}${piece}${RESET}` : piece;
	}
	return "";
}

/**
 * Build the `scoped:N/M` segment for the branded footer. M is the length of
 * `settings.scope`; N is the 1-based index of the active
 * `{endpoint, model}` ref within that set (matching either `endpointId` or
 * `endpointId/wireModelId` entries), or `-` when the active target is not
 * in scope. Returns `null` when scope is empty so the segment is omitted
 * entirely per the footer contract.
 */
export function scopedSegment(settings: Readonly<ClioSettings>): string | null {
	const scope = settings.scope ?? [];
	if (scope.length === 0) return null;
	const endpointId = settings.orchestrator?.endpoint ?? "";
	const wireModelId = settings.orchestrator?.model ?? "";
	const combinedRef = endpointId.length > 0 && wireModelId.length > 0 ? `${endpointId}/${wireModelId}` : "";
	const idx = scope.findIndex((entry) => entry === endpointId || entry === combinedRef);
	const n = idx === -1 ? "-" : String(idx + 1);
	return `scoped:${n}/${scope.length}`;
}

const STREAMING_FRAMES = ["|", "/", "-", "\\"] as const;

function modeBadge(mode: string): string {
	return `[${mode.toUpperCase()}]`;
}

function statusLabel(status: AgentStatus | undefined): string | null {
	if (!status) return null;
	if (status.phase === "ended") {
		const stopReason = status.summary?.stopReason;
		if (stopReason === "error" || stopReason === "aborted" || stopReason === "cancelled") return `status:${stopReason}`;
		return null;
	}
	if (status.phase === "idle") return null;
	if (status.phase === "tool_blocked") return "status:blocked";
	if (status.phase === "tool_running" && status.tool?.toolName) return `status:tool:${status.tool.toolName}`;
	if (status.phase === "stuck") return "status:stuck";
	return `status:${status.phase.replace(/_/g, "-")}`;
}

export function fitFooterText(text: string, width: number): string {
	const safeWidth = Math.max(1, Math.floor(width));
	return visibleWidth(text) > safeWidth ? truncateToWidth(text, safeWidth, "", true) : text;
}

export function buildFooter(deps: FooterDeps): FooterPanel {
	const view = new Text("");
	let streamingFrame = 0;
	let branchSlot: string | null = null;
	const refresh = (): void => {
		const mode = deps.modes.current().toLowerCase();
		const branchPart = branchSlot ? `${SEP}${branchSlot}` : "";
		const settings = deps.getSettings?.();
		const target = settings ? resolveOrchestratorTarget(deps.providers, settings) : null;
		let targetLabel: string;
		if (target) {
			const dim = target.healthStatus === "down" ? DIM : "";
			const reset = dim.length > 0 ? RESET : "";
			targetLabel = `${dim}${target.endpointId}${SEP}${target.wireModelId}${reset}`;
		} else {
			targetLabel = "no-endpoint";
		}

		const scoped = settings ? scopedSegment(settings) : null;
		const scopedPart = scoped ? `${SEP}${scoped}` : "";

		let suffix = "";
		if (target?.resolved) {
			suffix = thinkingSuffixForFooter(target.resolved.modelRuntime.thinking);
		}

		const status = deps.getAgentStatus?.();
		const statusVerb = status
			? resolveFooterVerb(status, Date.now(), deps.getTerminalColumns?.() ?? process.stdout.columns ?? 80)
			: null;
		const legacyStreaming = statusVerb === null && (deps.getStreaming?.() ?? false);
		const streamingPart =
			statusVerb && status
				? `${SEP}${status.phase === "ended" ? "" : `${spinnerFrame(streamingFrame)} `}${statusVerb.text}`
				: legacyStreaming
					? `${SEP}${STREAMING_FRAMES[streamingFrame % STREAMING_FRAMES.length]} responding`
					: "";
		if (statusVerb !== null && status?.phase !== "ended") {
			streamingFrame = (streamingFrame + 1) % 10;
		} else if (legacyStreaming) {
			streamingFrame = (streamingFrame + 1) % STREAMING_FRAMES.length;
		} else {
			streamingFrame = 0;
		}

		// Token counters (input/output/reasoning). Rendered right of the thinking-level
		// segment and left of the streaming indicator so the running totals
		// stay visible while a response is in flight. The segment disappears
		// entirely when no usage has landed yet (first boot / fresh session).
		const tokens = deps.getSessionTokens ? tokensSegment(deps.getSessionTokens()) : null;
		const tokensPart = tokens ? `${SEP}tok ${tokens}` : "";
		const ctx = deps.getContextUsage ? contextSegment(deps.getContextUsage()) : null;
		const ctxPart = ctx ? `${SEP}${ctx}` : "";
		const dispatch = deps.getDispatchRows ? dispatchSegment(deps.getDispatchRows()) : null;
		const dispatchPart = dispatch ? `${SEP}${dispatch}` : "";
		const state = statusLabel(status);
		const statePart = state ? `${SEP}${state}` : "";

		const text = `Clio Coder${SEP}${modeBadge(mode)}${branchPart}${SEP}${targetLabel}${scopedPart}${suffix}${tokensPart}${ctxPart}${dispatchPart}${statePart}${streamingPart}`;
		const width = deps.getTerminalColumns?.() ?? process.stdout.columns ?? 80;
		view.setText(fitFooterText(text, width));
		view.invalidate();
	};
	refresh();
	void getCurrentBranch(process.cwd()).then((name) => {
		if (name === null) return;
		branchSlot = `${DIM}branch:${name}${RESET}`;
		refresh();
	});
	return { view, refresh };
}
