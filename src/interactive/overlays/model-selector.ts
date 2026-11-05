import type { ClioSettings } from "../../core/config.js";
import { listRecentModels } from "../../core/recent-models.js";
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import type {
	CapabilityFlags,
	ProviderModelSource,
	ProvidersContract,
	ResolvedRuntimeTarget,
	RuntimeCapabilityDecision,
	RuntimeResolutionDiagnostic,
	TargetStatus,
	ThinkingLevel,
} from "../../domains/providers/index.js";
import {
	AGENT_ROLE_TOOLS_REQUIRED_REASON,
	acceptsImageInput,
	isOrchestratorEligibleRuntime,
	modelCandidatesForStatus,
	modelIdsForStatus,
	modelListNoteForStatus,
	newerModelNotice,
	resolveRuntimeTarget,
	supportsAgentRoleTools,
	thinkingEffectNote,
} from "../../domains/providers/index.js";
import type { Component, OverlayHandle, TUI } from "../../engine/tui.js";
import { fuzzyFilter, getKeybindings, Input, matchesKey, wrapTextWithAnsi } from "../../engine/tui.js";
import { localKey } from "../keyboard-owner.js";
import {
	buildResponsiveHint,
	clioError,
	diagnosticSeverityToken,
	FILTER_HINT,
	formatRuntimeResolutionDiagnostic,
	type RowBudgetedBody,
	showClioOverlayFrame,
	windowRows,
} from "../overlay-frame.js";
import type { ClioToken, StatusKind, TableCell, TableColumn } from "../theme/index.js";
import {
	chip,
	chipRow,
	clioTheme,
	dotSep,
	emptyState,
	fitIdentityLabel,
	GLYPH,
	padAnsi,
	positionRow,
	statusChip,
	tableRows,
} from "../theme/index.js";

export const MODEL_OVERLAY_WIDTH = 82;
const MODEL_OVERLAY_MAX_WIDTH = 120;
const MODEL_OVERLAY_TERMINAL_PADDING = 8;
const VISIBLE_ROWS = 10;
const MODEL_MIN_WIDTH = 14;
/**
 * Every other column pair is separated by an explicit space. The model cell
 * instead relies on its own padding, so a label that fills the column exactly
 * butts straight against the ctx figure. The gutter is reserved inside the
 * model cell, which keeps the header and the rows on the same column stops.
 */
const MODEL_COL_GUTTER = 1;
const CONTEXT_COL_WIDTH = 7;
const CAPS_COL_WIDTH = 5;
const TARGET_COL_WIDTH_NARROW = 8;
const TARGET_COL_WIDTH_WIDE = 12;
const RUNTIME_COL_WIDTH_NARROW = 10;
const RUNTIME_COL_WIDTH_MEDIUM = 14;
const RUNTIME_COL_WIDTH_WIDE = 18;
const SELECTED_PREFIX_WIDTH = 4;
const TAB = "\t";

function resolveOverlayWidth(terminalColumns: number): number {
	// Default 82 fits a typical 80-col terminal with margin. On wider
	// terminals grow the overlay so target/runtime columns can stay visible.
	if (!Number.isFinite(terminalColumns) || terminalColumns <= 0) return MODEL_OVERLAY_WIDTH;
	const available = terminalColumns - MODEL_OVERLAY_TERMINAL_PADDING;
	if (available <= MODEL_OVERLAY_WIDTH) return Math.max(1, available);
	return Math.min(MODEL_OVERLAY_MAX_WIDTH, available);
}

export interface ModelSelection {
	target: string;
	model: string;
}

export interface OpenModelOverlayDeps {
	settings: Readonly<ClioSettings>;
	/** Optional live settings resolver so refreshes pick up target/config edits made while the overlay is open. */
	getSettings?: () => Readonly<ClioSettings>;
	providers: ProvidersContract;
	bus?: TelemetryHub;
	onSelect: (ref: ModelSelection) => void;
	onToggleFavorite?: (ref: ModelSelection, favorite: boolean) => void;
	onClose: () => void;
	autoRefresh?: boolean;
}

function healthToken(status: TargetStatus): ClioToken {
	switch (status.health.status) {
		case "healthy":
			return "success";
		case "degraded":
			return "warning";
		case "down":
			return "error";
		default:
			return "annotation";
	}
}

function capabilityBadges(caps: CapabilityFlags): string {
	let badges = "";
	if (caps.tools) badges += "T";
	if (caps.reasoning) badges += "R";
	if (caps.vision) badges += "V";
	if (caps.embeddings) badges += "E";
	if (caps.rerank) badges += "K";
	if (caps.fim) badges += "F";
	return badges.length > 0 ? badges : "-";
}

function compactTokenCount(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "?";
	const rounded = Math.round(value);
	if (rounded >= 1_000_000) return `${Math.round(rounded / 100_000) / 10}m`;
	if (rounded >= 1000) return `${Math.round(rounded / 1000)}k`;
	return `${rounded}`;
}

function contextDecisionLabel(decisions: RuntimeCapabilityDecision): string {
	return `${compactTokenCount(decisions.contextWindow)}ctx`;
}

function maxTokensDecisionLabel(decisions: RuntimeCapabilityDecision): string {
	return compactTokenCount(decisions.maxTokens);
}

type ModelSource = ProviderModelSource | "missing";
type ModelBucket = "local" | "cloud";
type ModelRefreshScope = "selected" | "all";

export interface ModelRow {
	value: string;
	target: string;
	model: string;
	runtimeName: string;
	runtimeShortName: string;
	runtimeId: string;
	apiFamily: string;
	bucket: ModelBucket;
	source: ModelSource;
	/** Present when the target's list is not the provider's live answer: what it is instead, and why. */
	sourceNote?: string;
	loadState?: string;
	loadStateDetail?: string;
	authText: string;
	available: boolean;
	reason: string;
	healthToken: ClioToken;
	healthText: string;
	caps: CapabilityFlags;
	capabilityDecisions?: RuntimeCapabilityDecision;
	thinking?: string;
	/** Why this model runs another level than the one asked for. */
	thinkingNote?: string | null;
	streaming?: boolean;
	diagnostics?: RuntimeResolutionDiagnostic[];
	badges: string;
	context: string;
	maxTokens: string;
	active: boolean;
	scoped: boolean;
	favorite?: boolean;
	recent?: boolean;
	defaultModel?: boolean;
	focusPinned?: boolean;
	visibleByDefault?: boolean;
	selectable: boolean;
}

export interface ModelOverlaySummary {
	totalModels: number;
	targets: number;
	localModels: number;
	cloudModels: number;
	activeRef: string;
	focusedModels?: number;
	newerModelNotice?: string;
}

/** Enumerate target wire model ids with live discovery taking precedence when available. */
export function modelsForTarget(status: TargetStatus): string[] {
	return modelIdsForStatus(status);
}

export interface ModelItemsResult {
	rows: ModelRow[];
	summary: ModelOverlaySummary;
}

function fallbackCapabilityDecisions(status: TargetStatus, caps: CapabilityFlags): RuntimeCapabilityDecision {
	const kind = status.runtime?.kind;
	return {
		chat: caps.chat,
		tools: caps.tools,
		reasoning: caps.reasoning,
		vision: caps.vision,
		streaming: kind === "http",
		contextWindow: caps.contextWindow,
		maxTokens: caps.maxTokens,
	};
}

function providersWithStatusFallback(providers: ProvidersContract, status: TargetStatus): ProvidersContract {
	return {
		...providers,
		getTarget: (id) => providers.getTarget(id) ?? (id === status.target.id ? status.target : null),
		getRuntime: (id) => providers.getRuntime(id) ?? (status.runtime && id === status.runtime.id ? status.runtime : null),
	};
}

interface OverlayRuntimeResolution {
	target: ResolvedRuntimeTarget | null;
	diagnostics: RuntimeResolutionDiagnostic[];
	capabilities: CapabilityFlags;
	capabilityDecisions: RuntimeCapabilityDecision;
	thinking: string;
	thinkingNote: string | null;
	streaming: boolean;
}

/** Resolve the same runtime/capability descriptor used by the footer and chat loop for one overlay row. */
function resolveOverlayRuntimeTarget(input: {
	providers: ProvidersContract;
	status: TargetStatus;
	wireModelId: string;
	requestedThinkingLevel?: ThinkingLevel;
}): OverlayRuntimeResolution {
	const resolution = resolveRuntimeTarget(providersWithStatusFallback(input.providers, input.status), {
		targetId: input.status.target.id,
		wireModelId: input.wireModelId,
		requestedThinkingLevel: input.requestedThinkingLevel ?? "off",
		use: "orchestrator",
		requireTools: true,
		requireStreaming: true,
		requireOutputBudget: true,
	});
	if (resolution.ok) {
		return {
			target: resolution.target,
			diagnostics: resolution.diagnostics,
			capabilities: resolution.target.capabilities,
			capabilityDecisions: resolution.target.capabilityDecisions,
			thinking: resolution.target.modelRuntime.thinking.display,
			thinkingNote: thinkingEffectNote(resolution.target.modelRuntime.thinking),
			streaming: resolution.target.capabilityDecisions.streaming,
		};
	}
	const capabilities = input.status.capabilities;
	const decisions = fallbackCapabilityDecisions(input.status, capabilities);
	return {
		target: null,
		diagnostics: resolution.diagnostics,
		capabilities,
		capabilityDecisions: decisions,
		thinking: "unresolved",
		thinkingNote: null,
		streaming: decisions.streaming,
	};
}

function modelBucket(status: TargetStatus): ModelBucket {
	const tier = status.runtime?.tier;
	if (
		tier === "protocol" ||
		tier === "local-native" ||
		status.target.url?.includes("127.0.0.1") ||
		status.target.url?.includes("localhost")
	) {
		return "local";
	}
	return "cloud";
}

function shortRuntimeName(name: string): string {
	return name
		.replace(/\s*\(OpenAI-compat\)\s*/g, "")
		.replace(/\s+native API$/i, "")
		.replace(/\s+API$/i, "")
		.replace(/\s+SDK$/i, "");
}

function authLabel(deps: { providers: ProvidersContract; status: TargetStatus }): string {
	const { providers, status } = deps;
	if (!status.runtime) return "unknown";
	const auth = providers.auth.statusForTarget(status.target, status.runtime);
	if (!auth.available) return "disconnected";
	if (auth.source === "environment") return auth.detail ? `env:${auth.detail}` : "environment";
	if (auth.source === "none") return "not required";
	return auth.detail ? `${auth.source}:${auth.detail}` : auth.source;
}

function healthText(status: TargetStatus): string {
	const latency =
		typeof status.health.latencyMs === "number" && Number.isFinite(status.health.latencyMs)
			? ` ${Math.round(status.health.latencyMs)}ms`
			: "";
	if (status.health.status === "unknown") return "unknown";
	if (status.health.lastError) return `${status.health.status}: ${status.health.lastError}`;
	return `${status.health.status}${latency}`;
}

function statusPriority(status: TargetStatus): number {
	if (status.available && status.health.status === "healthy") return 0;
	if (status.available && status.health.status !== "down") return 1;
	return 2;
}

function buildSummary(rows: ReadonlyArray<ModelRow>, targets: number, activeRef: string): ModelOverlaySummary {
	let localModels = 0;
	let cloudModels = 0;
	for (const row of rows) {
		if (!row.selectable) continue;
		if (row.bucket === "local") localModels++;
		else cloudModels++;
	}
	return {
		totalModels: localModels + cloudModels,
		targets,
		localModels,
		cloudModels,
		activeRef,
		focusedModels: rows.filter((row) => row.selectable && row.visibleByDefault !== false).length,
	};
}

/**
 * Build the target-first model picker. Each configured target renders one
 * row per candidate wire model (see `modelsForTarget`). Targets without
 * a resolvable wire model still render a single "no-model" row so users can
 * see the target exists and why it is not selectable. Scope stars come from
 * `settings.chat.modelPicker.cycleSet`: both plain `targetId` and `targetId/wireModelId` refs
 * match so a user can pin either granularity.
 */
function buildModelItems(deps: { settings: Readonly<ClioSettings>; providers: ProvidersContract }): ModelItemsResult {
	const activeTarget = deps.settings.chat?.target?.trim() ?? "";
	const activeModel = deps.settings.chat?.model?.trim() ?? "";
	const activeRef = activeTarget && activeModel ? `${activeTarget}/${activeModel}` : activeTarget;
	const favoriteSet = new Set(deps.settings.chat.modelPicker?.favorites ?? []);
	const recentSet = new Set(listRecentModels({ limit: deps.settings.chat.modelPicker?.recentLimit ?? 12 }));
	const list = [...deps.providers.list()]
		.filter((status) => {
			return status.runtime !== null && isOrchestratorEligibleRuntime(status.runtime);
		})
		.sort((a, b) => {
			const aActive = a.target.id === activeTarget ? 0 : 1;
			const bActive = b.target.id === activeTarget ? 0 : 1;
			return (
				aActive - bActive ||
				statusPriority(a) - statusPriority(b) ||
				(a.runtime?.displayName ?? a.target.runtime).localeCompare(b.runtime?.displayName ?? b.target.runtime) ||
				a.target.id.localeCompare(b.target.id)
			);
		});
	const scopeSet = new Set(deps.settings.chat.modelPicker.cycleSet ?? []);
	const rows: ModelRow[] = [];
	for (const status of list) {
		const { target } = status;
		const runtimeName = status.runtime?.displayName ?? target.runtime;
		const runtimeShortName = shortRuntimeName(runtimeName);
		const candidates = modelCandidatesForStatus(status);
		const sourceNote = modelListNoteForStatus(status);
		const authText = authLabel({ providers: deps.providers, status });
		const bucket = modelBucket(status);
		const singleTarget = list.length === 1;
		if (candidates.length === 0) {
			const fallbackModel = target.defaultModel?.trim() ?? "";
			const resolution =
				fallbackModel.length > 0
					? resolveOverlayRuntimeTarget({
							providers: deps.providers,
							status,
							wireModelId: fallbackModel,
							requestedThinkingLevel: deps.settings.chat?.thinkingLevel,
						})
					: null;
			const rowCaps = resolution?.capabilities ?? status.capabilities;
			const decisions = resolution?.capabilityDecisions ?? fallbackCapabilityDecisions(status, rowCaps);
			const row: ModelRow = {
				value: target.id,
				target: target.id,
				model: "",
				runtimeName,
				runtimeShortName,
				runtimeId: status.runtime?.id ?? target.runtime,
				apiFamily: status.runtime?.apiFamily ?? "unknown",
				bucket,
				source: "missing",
				authText,
				available: status.available,
				reason: status.reason,
				healthToken: healthToken(status),
				healthText: healthText(status),
				caps: rowCaps,
				capabilityDecisions: decisions,
				thinking: resolution?.thinking ?? "unresolved",
				thinkingNote: resolution?.thinkingNote ?? null,
				streaming: decisions.streaming,
				diagnostics: resolution?.diagnostics ?? [
					{ severity: "error", code: "model-not-configured", message: `target '${target.id}' has no model configured` },
				],
				badges: capabilityBadges(rowCaps),
				context: contextDecisionLabel(decisions),
				maxTokens: maxTokensDecisionLabel(decisions),
				active: target.id === activeTarget,
				scoped: scopeSet.has(target.id),
				favorite: false,
				recent: false,
				defaultModel: false,
				visibleByDefault: target.id === activeTarget || scopeSet.has(target.id),
				selectable: false,
			};
			rows.push(row);
			continue;
		}
		for (const candidate of candidates) {
			const wireModel = candidate.id;
			const rowRef = `${target.id}/${wireModel}`;
			const resolution = resolveOverlayRuntimeTarget({
				providers: deps.providers,
				status,
				wireModelId: wireModel,
				requestedThinkingLevel: deps.settings.chat?.thinkingLevel,
			});
			const rowCaps = resolution.capabilities;
			const decisions = resolution.capabilityDecisions;
			const badges = capabilityBadges(rowCaps);
			const exactScopeHit = scopeSet.has(rowRef);
			const targetScopeHit = scopeSet.has(target.id);
			const scopeHit = exactScopeHit || targetScopeHit;
			const active = target.id === activeTarget && wireModel === activeModel;
			const favorite = favoriteSet.has(rowRef) || exactScopeHit;
			const recent = recentSet.has(rowRef);
			const defaultModel = wireModel === target.defaultModel;
			const targetScopedFocus = targetScopeHit && (active || defaultModel);
			const focusPinned = singleTarget && candidate.source === "configured";
			const row: ModelRow = {
				value: rowRef,
				target: target.id,
				model: wireModel,
				runtimeName,
				runtimeShortName,
				runtimeId: status.runtime?.id ?? target.runtime,
				apiFamily: status.runtime?.apiFamily ?? "unknown",
				bucket,
				source: candidate.source,
				...(sourceNote ? { sourceNote } : {}),
				...(candidate.loadState ? { loadState: candidate.loadState } : {}),
				...(candidate.loadStateDetail ? { loadStateDetail: candidate.loadStateDetail } : {}),
				authText,
				available: status.available,
				reason: status.reason,
				healthToken: healthToken(status),
				healthText: healthText(status),
				caps: rowCaps,
				capabilityDecisions: decisions,
				thinking: resolution.thinking,
				thinkingNote: resolution.thinkingNote,
				streaming: resolution.streaming,
				diagnostics: resolution.diagnostics,
				badges,
				context: contextDecisionLabel(decisions),
				maxTokens: maxTokensDecisionLabel(decisions),
				active,
				scoped: scopeHit,
				favorite,
				recent,
				defaultModel,
				focusPinned,
				visibleByDefault: active || favorite || recent || defaultModel || targetScopedFocus || focusPinned,
				// A model that cannot call tools stays listed so the operator can see it
				// exists and why it is refused, but it cannot be chosen for the chat role.
				selectable: supportsAgentRoleTools(decisions),
			};
			rows.push(row);
		}
	}
	const summary = buildSummary(rows, list.length, activeRef);
	const activeStatus = list.find((status) => status.target.id === activeTarget);
	const notice = activeStatus
		? newerModelNotice(activeTarget, activeModel, activeStatus.discoveredModels, activeStatus.discoveredModelCreatedAt)
		: null;
	if (notice !== null) summary.newerModelNotice = notice;
	return { rows, summary };
}

interface ModelLayout {
	modelWidth: number;
	showTarget: boolean;
	showRuntime: boolean;
	targetWidth: number;
	runtimeWidth: number;
}

/** Cells between table columns. */
const MODEL_TABLE_GAP = 2;

/**
 * Which columns a width can carry. The model id is the column the operator
 * reads, so it is sized last from what the fixed columns leave, and runtime,
 * then target, drop whole when it would fall under `MODEL_MIN_WIDTH`.
 */
function modelLayout(width: number): ModelLayout {
	const targetWidth = width >= 92 ? TARGET_COL_WIDTH_WIDE : TARGET_COL_WIDTH_NARROW;
	const runtimeWidth =
		width >= 96 ? RUNTIME_COL_WIDTH_WIDE : width >= 78 ? RUNTIME_COL_WIDTH_MEDIUM : RUNTIME_COL_WIDTH_NARROW;
	let showTarget = width >= 58;
	let showRuntime = width >= 68;
	const modelWidthFor = (): number => {
		let fixed = SELECTED_PREFIX_WIDTH + MODEL_TABLE_GAP + CONTEXT_COL_WIDTH + MODEL_TABLE_GAP + CAPS_COL_WIDTH;
		if (showTarget) fixed += MODEL_TABLE_GAP + targetWidth;
		if (showRuntime) fixed += MODEL_TABLE_GAP + runtimeWidth;
		return width - fixed;
	};
	let modelWidth = modelWidthFor();
	if (modelWidth < MODEL_MIN_WIDTH && showRuntime) {
		showRuntime = false;
		modelWidth = modelWidthFor();
	}
	if (modelWidth < MODEL_MIN_WIDTH && showTarget) {
		showTarget = false;
		modelWidth = modelWidthFor();
	}
	return { modelWidth: Math.max(1, modelWidth), showTarget, showRuntime, targetWidth, runtimeWidth };
}

// The active, favorite and recent marks keep one fixed column. Scoped and
// default remain words in the selected row's detail instead of run-origin marks.
function activeMark(row: ModelRow): string {
	const theme = clioTheme();
	if (row.active) return theme.fg("selectedOption", GLYPH.ok);
	if (row.favorite) return theme.fg("annotation", GLYPH.favorite);
	if (row.recent) return theme.fg("annotation", GLYPH.recent);
	return " ";
}

/**
 * The model table: cursor and mark lead the model id in one cell, so the id
 * starts on the same column as its header; context and capabilities follow,
 * then the target and runtime the width allows. The id keeps its tail when it
 * must shorten, because the suffix is what tells two builds apart.
 */
function modelTableLines(rows: ReadonlyArray<ModelRow>, selectedIndex: number, width: number): string[] {
	const theme = clioTheme();
	const layout = modelLayout(width);
	const modelColumnWidth = SELECTED_PREFIX_WIDTH + layout.modelWidth;
	const columns: TableColumn[] = [
		{ label: `${" ".repeat(SELECTED_PREFIX_WIDTH)}model`, min: modelColumnWidth, max: modelColumnWidth, priority: 10 },
		{ label: "ctx", align: "right", min: CONTEXT_COL_WIDTH, max: CONTEXT_COL_WIDTH, priority: 4 },
		{ label: "caps", min: CAPS_COL_WIDTH, max: CAPS_COL_WIDTH, priority: 3 },
		...(layout.showTarget
			? [{ label: "target", min: layout.targetWidth, max: layout.targetWidth, priority: 2 } satisfies TableColumn]
			: []),
		...(layout.showRuntime
			? [{ label: "runtime", min: layout.runtimeWidth, max: layout.runtimeWidth, priority: 1 } satisfies TableColumn]
			: []),
	];
	const table = rows.map((row, index): Array<string | TableCell> => {
		const selected = index === selectedIndex;
		const pointer = selected ? theme.fg("selectedOption", GLYPH.cursor) : " ";
		const label = fitIdentityLabel(
			row.model.length > 0 ? row.model : "(no model ids)",
			Math.max(1, layout.modelWidth - MODEL_COL_GUTTER),
		);
		const model = selected
			? theme.style("selectedOption", label, { bold: true })
			: theme.fg("menuOption", label, row.selectable ? "normal" : "disabled");
		return [
			`${pointer} ${activeMark(row)} ${model}`,
			theme.fg(row.context === "-" || row.context === "?" ? "unknownValue" : "counter", row.context),
			{ text: row.badges, tone: "muted" },
			...(layout.showTarget ? [theme.fg("modelIdentity", row.target)] : []),
			...(layout.showRuntime ? [{ text: row.runtimeShortName, tone: "muted" } satisfies TableCell] : []),
		];
	});
	return tableRows(theme, { columns, rows: table, header: true, gap: MODEL_TABLE_GAP }, width);
}

function capabilityNames(caps: CapabilityFlags): string {
	const names: string[] = [];
	if (caps.tools) names.push("tools");
	if (caps.reasoning) names.push("reasoning");
	if (caps.vision) names.push("vision");
	if (caps.embeddings) names.push("embeddings");
	if (caps.rerank) names.push("rerank");
	if (caps.fim) names.push("fim");
	return names.length > 0 ? names.join(", ") : "none";
}

function sourceLabel(source: ModelSource): string {
	switch (source) {
		case "configured":
			return "configured";
		case "live":
			return "live probe";
		case "cache":
			return "cached list";
		case "catalog":
			return "catalog";
		case "default":
			return "target default";
		default:
			return "no model ids";
	}
}

function healthStatus(row: ModelRow): StatusKind {
	switch (row.healthToken) {
		case "success":
			return "ok";
		case "warning":
			return "warning";
		case "error":
			return "error";
		default:
			return "info";
	}
}

/**
 * The selected row, explained: its state and ref with the target's health and
 * auth on one row, then the facts that decide whether it can run a turn, then
 * any diagnostic in its own tone. Everything but the health and the
 * diagnostics stays dim, so the table above keeps the eye. `maxRows` is what
 * the body can spare; the facts give way first and say where they were cut.
 */
function formatModelDetail(row: ModelRow, width: number, maxRows: number): string[] {
	const theme = clioTheme();
	const ref = row.model.length > 0 ? `${row.target}/${row.model}` : row.target;
	const tags: string[] = [];
	if (row.active) tags.push("current");
	if (row.favorite) tags.push("favorite");
	if (row.recent) tags.push("recent");
	if (row.scoped) tags.push("scoped");
	if (row.defaultModel) tags.push("default");
	const state = tags.length > 0 ? tags.join("+") : row.selectable ? "candidate" : "not selectable";
	const availability = row.available ? row.healthText : `${row.healthText}; ${row.reason || "unavailable"}`;
	const loadState = row.loadState
		? `state ${row.loadState}${row.loadStateDetail ? ` (${row.loadStateDetail})` : ""}`
		: null;
	const facts = [
		`source ${row.sourceNote ?? sourceLabel(row.source)}`,
		loadState,
		row.runtimeName,
		row.apiFamily,
		`max output ${row.maxTokens}`,
		`thinking ${row.thinking ?? "-"}${row.thinkingNote ? ` (${row.thinkingNote}, your setting is kept)` : ""}`,
		`streaming ${row.streaming === false ? "no" : "yes"}`,
		`image input ${acceptsImageInput({ vision: row.caps.vision }) ? "yes" : "no"}`,
		capabilityNames(row.caps),
	].filter((fact): fact is string => fact !== null);
	// Severity colors the way the targets hub colors it, through the shared mapping.
	// The thinking fact above already says what runs and why, so its codes do not repeat it in jargon.
	const diagnostics = (row.diagnostics ?? [])
		.filter((entry) => entry.severity !== "info" && !entry.code.startsWith("thinking-"))
		.slice(0, 2)
		.map((entry) => {
			const token = diagnosticSeverityToken(entry.severity);
			return theme.fg(
				token,
				`${token === "error" ? GLYPH.error : GLYPH.warn} ${formatRuntimeResolutionDiagnostic(entry)}`,
			);
		})
		.flatMap((line) => wrapTextWithAnsi(line, width).slice(0, 1));
	const factLines = wrapTextWithAnsi(facts.map((fact) => chip(theme, fact, "muted")).join(dotSep(theme)), width);
	// A route that cannot answer says what to do about it before any fact about the route.
	const unreachable = !row.available || healthStatus(row) === "error";
	const next = unreachable
		? wrapTextWithAnsi(
				theme.fg(
					"warning",
					`next: pick a healthy route, or r to recheck this one. Using it fails every turn until it answers. Fix it with clio-coder configure --id ${row.target}`,
				),
				width,
			)
		: [];
	const factBudget = Math.max(1, Math.min(factLines.length, maxRows - 1 - next.length - diagnostics.length));
	const kept = factLines.slice(0, factBudget);
	const last = kept.at(-1);
	if (factLines.length > kept.length && last !== undefined) kept[kept.length - 1] = `${last}${GLYPH.ellipsis}`;
	return [
		chipRow(
			theme,
			[
				statusChip(theme, healthStatus(row), availability),
				theme.fg("annotation", `${state} ${ref}`),
				chip(theme, `auth ${row.authText}`, "muted"),
			],
			width,
		),
		...next,
		...kept,
		...diagnostics,
	];
}

/**
 * Keep the target-qualified ref ahead of the bare model id. This mirrors
 * pi-coding-agent's provider-first model-selector search text, so an exact
 * target/model query ranks ahead of a proxy target carrying that ref as its
 * model id. Clio's runtime and availability facts remain searchable after the
 * ranking prefix.
 */
function modelSelectorSearchText(row: ModelRow): string {
	const qualifiedModel = row.model.length > 0 ? `${row.target}/${row.model}` : row.target;
	return [
		row.target,
		qualifiedModel,
		row.target,
		row.model,
		row.runtimeName,
		row.runtimeShortName,
		row.runtimeId,
		row.apiFamily,
		row.bucket,
		row.source,
		row.loadState ?? "",
		row.loadStateDetail ?? "",
		row.badges,
		row.context,
		row.maxTokens,
		row.authText,
		row.healthText,
	].join(" ");
}

function filterModelRows(rows: ReadonlyArray<ModelRow>, query: string): ModelRow[] {
	return fuzzyFilter([...rows], query, modelSelectorSearchText);
}

function refreshStatusLine(
	refreshing: ModelRefreshScope | null | undefined,
	error: RuntimeResolutionDiagnostic | null | undefined,
): string | null {
	if (refreshing)
		return refreshing === "all" ? "refreshing all targets and model catalogs…" : "refreshing selected target models…";
	return error ? formatRuntimeResolutionDiagnostic(error) : null;
}

/** Rows the body spends outside the table rows: summary, header, divider, blank, two detail rows. */
const MODEL_CHROME_ROWS = 6;
const MODEL_MIN_VISIBLE_ROWS = 3;

function renderModelOverlayLines(input: {
	rows: ReadonlyArray<ModelRow>;
	summary: ModelOverlaySummary;
	selectedIndex: number;
	query: string;
	width: number;
	/** Rows the frame granted, or zero while unknown. */
	bodyRows?: number;
	showAll?: boolean;
	refreshing?: ModelRefreshScope | null;
	refreshError?: RuntimeResolutionDiagnostic | null;
	selectionError?: string | null;
}): string[] {
	const width = Math.max(1, input.width);
	const theme = clioTheme();
	const query = input.query.trim();
	const searching = query.length > 0;
	const allMatches = filterModelRows(input.rows, input.query);
	const focusedMatches = allMatches.filter((row) => row.visibleByDefault !== false);
	const filtered = searching || input.showAll ? allMatches : focusedMatches;
	const hidden = searching || input.showAll ? 0 : allMatches.length - focusedMatches.length;
	const selectableFiltered = filtered.filter((row) => row.selectable).length;
	const selectedIndex = Math.max(0, Math.min(input.selectedIndex, Math.max(0, filtered.length - 1)));
	const selected = filtered[selectedIndex] ?? null;
	const active = input.summary.activeRef || "not configured";
	const mode = searching ? `search "${query}"` : input.showAll ? "all" : "focus";
	// The mode leads in the accent because Tab changes it; the counts stay
	// dim. One row, not two: the legend that explained focus now sits on the
	// position row, where the count of hidden models is.
	const lines = [
		chipRow(
			theme,
			[
				chip(theme, mode, "accent"),
				chip(theme, `${selectableFiltered}/${input.summary.totalModels} models`, "muted"),
				chip(theme, `${input.summary.targets} targets`, "muted"),
				chip(theme, `${input.summary.localModels} local`, "muted"),
				chip(theme, `${input.summary.cloudModels} cloud`, "muted"),
				chip(theme, `current ${active}`, "muted", GLYPH.ok),
			],
			width,
		),
	];
	if (input.summary.newerModelNotice) {
		lines.push(...wrapTextWithAnsi(theme.fg("annotation", input.summary.newerModelNotice), width).slice(0, 1));
	}
	const refreshLine = refreshStatusLine(input.refreshing, input.refreshError);
	if (refreshLine)
		lines.push(
			...wrapTextWithAnsi(input.refreshError ? clioError(refreshLine) : theme.fg("annotation", refreshLine), width),
		);
	if (input.selectionError) lines.push(...wrapTextWithAnsi(clioError(input.selectionError), width));
	const bodyRows = input.bodyRows !== undefined && input.bodyRows > 0 ? input.bodyRows : 0;
	// Two detail rows are owed before the table is sized; whatever the table
	// leaves goes back to the detail, so a short list explains its row in full.
	let detail = selected ? formatModelDetail(selected, width, 3) : [];
	const extraChrome = lines.length - 1 + Math.max(0, detail.length - 2);
	const budget =
		bodyRows > 0 ? Math.max(MODEL_MIN_VISIBLE_ROWS, bodyRows - MODEL_CHROME_ROWS - extraChrome - 1) : VISIBLE_ROWS;
	if (filtered.length === 0) {
		lines.push(
			...emptyState(
				theme,
				searching ? "No models match the filter." : "No focused models.",
				width,
				searching ? { remedy: "Esc clears the filter" } : { remedy: "Type to search, or press Tab to list every model" },
			),
		);
	} else {
		const { window, start, position } = windowRows(filtered, selectedIndex, budget);
		lines.push(...modelTableLines(window, selectedIndex - start, width));
		if (position !== null || hidden > 0) {
			lines.push(
				positionRow(
					theme,
					{
						start: position?.start ?? 1,
						end: position?.end ?? filtered.length,
						total: filtered.length,
						unit: "models",
						keys: hidden > 0 ? [`Tab shows all ${allMatches.length}`] : [],
					},
					width,
				),
			);
		}
	}
	lines.push("");
	if (selected) {
		const spare = bodyRows > 0 ? bodyRows - lines.length : detail.length;
		if (spare > detail.length) detail = formatModelDetail(selected, width, spare);
		lines.push(...detail);
	} else lines.push(theme.fg("menuDescription", "no selected model"));
	return lines.map((line) => padAnsi(line, width, GLYPH.ellipsis));
}

interface ModelRefreshActions {
	selected?: (targetId: string) => Promise<ModelItemsResult>;
	all?: () => Promise<ModelItemsResult>;
	requestRender?: () => void;
}

export class ModelOverlayView implements Component, RowBudgetedBody {
	private selectedIndex = 0;
	private query = "";
	private readonly queryInput = new Input();
	get keyboardScope(): "edit" | "browse" {
		return this.query ? "edit" : "browse";
	}
	undoInput(): boolean {
		this.queryInput.applyEdit("undo");
		this.query = this.queryInput.getValue();
		this.selectedIndex = 0;
		return true;
	}
	private showAll = false;
	private rows: ModelRow[];
	private summary: ModelOverlaySummary;
	private refreshing: ModelRefreshScope | null = null;
	private refreshError: RuntimeResolutionDiagnostic | null = null;
	private selectionError: string | null = null;
	private bodyRows = 0;
	private readonly lifecycle = new AbortController();

	constructor(
		rows: ReadonlyArray<ModelRow>,
		summary: ModelOverlaySummary,
		private readonly onSelect: (ref: ModelSelection) => void,
		private readonly onToggleFavorite: ((ref: ModelSelection, favorite: boolean) => void) | undefined,
		private readonly onClose: () => void,
		private readonly refreshActions: ModelRefreshActions = {},
	) {
		this.rows = [...rows];
		this.summary = summary;
	}

	selectedValue(): string | null {
		return this.selectedRow()?.value ?? null;
	}

	setSelectedValue(value: string): void {
		this.restoreSelection(value);
	}

	replaceItems(result: ModelItemsResult, preferredValue: string | null = this.selectedValue()): void {
		if (this.lifecycle.signal.aborted) return;
		this.rows = [...result.rows];
		this.summary = result.summary;
		this.selectionError = null;
		this.restoreSelection(preferredValue);
	}

	dispose(): void {
		if (!this.lifecycle.signal.aborted) this.lifecycle.abort();
	}

	isDisposed(): boolean {
		return this.lifecycle.signal.aborted;
	}

	private restoreSelection(preferredValue: string | null): void {
		const filtered = this.filteredRows();
		if (preferredValue) {
			const idx = filtered.findIndex((row) => row.value === preferredValue);
			if (idx >= 0) {
				this.selectedIndex = idx;
				return;
			}
		}
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, filtered.length - 1)));
	}

	private filteredRows(): ModelRow[] {
		const matches = filterModelRows(this.rows, this.query);
		if (this.query.trim().length > 0 || this.showAll) return matches;
		return matches.filter((row) => row.visibleByDefault !== false);
	}

	private selectedRow(): ModelRow | null {
		return this.filteredRows()[this.selectedIndex] ?? null;
	}

	private move(delta: number): void {
		this.selectionError = null;
		const count = this.filteredRows().length;
		if (count === 0) {
			this.selectedIndex = 0;
			return;
		}
		this.selectedIndex = (this.selectedIndex + delta + count) % count;
	}

	private clearQuery(): void {
		if (this.query.length === 0) return;
		this.selectionError = null;
		this.query = "";
		this.queryInput.setValue("");
		this.selectedIndex = 0;
	}

	private toggleShowAll(): void {
		this.selectionError = null;
		this.showAll = !this.showAll;
		this.selectedIndex = 0;
	}

	private toggleFavorite(): void {
		const row = this.selectedRow();
		if (!row?.selectable || !this.onToggleFavorite) return;
		row.favorite = !row.favorite;
		row.visibleByDefault =
			row.focusPinned === true ||
			row.active ||
			row.favorite === true ||
			row.recent === true ||
			row.scoped === true ||
			row.defaultModel === true;
		this.onToggleFavorite({ target: row.target, model: row.model }, row.favorite === true);
	}

	refresh(scope: ModelRefreshScope): void {
		void this.runRefresh(scope);
	}

	private async runRefresh(scope: ModelRefreshScope): Promise<void> {
		if (this.refreshing || this.lifecycle.signal.aborted) return;
		const signal = this.lifecycle.signal;
		const selected = this.selectedRow();
		const preferredValue = selected?.value ?? null;
		if (scope === "all" && !this.refreshActions.all) return;
		if (scope === "selected" && (!this.refreshActions.selected || !selected?.target)) return;
		this.refreshing = scope;
		this.refreshError = null;
		this.selectionError = null;
		this.refreshActions.requestRender?.();
		try {
			const next =
				scope === "all" ? await this.refreshActions.all?.() : await this.refreshActions.selected?.(selected?.target ?? "");
			if (signal.aborted) return;
			if (next) this.replaceItems(next, preferredValue);
		} catch (err) {
			if (signal.aborted) return;
			this.refreshError = {
				severity: "error",
				code: "probe-failed",
				message: err instanceof Error ? err.message : String(err),
			};
		} finally {
			this.refreshing = null;
			if (!signal.aborted) this.refreshActions.requestRender?.();
		}
	}

	setBodyRows(rows: number): void {
		this.bodyRows = Math.max(0, Math.floor(rows));
	}

	render(width: number): string[] {
		return renderModelOverlayLines({
			rows: this.rows,
			summary: this.summary,
			selectedIndex: this.selectedIndex,
			query: this.query,
			width,
			bodyRows: this.bodyRows,
			showAll: this.showAll,
			refreshing: this.refreshing,
			refreshError: this.refreshError,
			selectionError: this.selectionError,
		});
	}

	invalidate(): void {}

	handleInput(data: string): void {
		data = localKey(data);
		if (this.lifecycle.signal.aborted) return;
		if (matchesKey(data, "escape")) {
			if (this.query) this.clearQuery();
			else this.onClose();
			this.refreshActions.requestRender?.();
			return;
		}
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || matchesKey(data, "enter") || data === "\n") {
			const row = this.selectedRow();
			if (row?.selectable) {
				// Close the picker before handing the selection to its owner. The
				// application opens the session/global scope confirmation from
				// onSelect; closing afterwards would immediately close that new overlay
				// and leave the model binding unchanged.
				this.onClose();
				this.onSelect({ target: row.target, model: row.model });
				return;
			}
			this.selectionError = row
				? row.model && row.capabilityDecisions && !supportsAgentRoleTools(row.capabilityDecisions)
					? `${row.model} ${AGENT_ROLE_TOOLS_REQUIRED_REASON}`
					: `target ${row.target} has no selectable model id`
				: "no model is selected";
			this.refreshActions.requestRender?.();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			// Esc unwinds one step at a time: an active filter is the thing the
			// user most recently built, so it goes first and the overlay stays
			// open. A second press with no filter left closes. Typing a filter
			// and reaching for Esc used to dump the whole overlay.
			if (this.query.length > 0) {
				this.clearQuery();
				this.refreshActions.requestRender?.();
				return;
			}
			this.onClose();
			return;
		}
		if (data === TAB) {
			this.toggleShowAll();
			return;
		}
		if (data === "r" && this.query.length === 0) {
			this.refresh("selected");
			return;
		}
		if (data === "R" && this.query.length === 0) {
			this.refresh("all");
			return;
		}
		if (data === "*" && this.query.length === 0) {
			this.toggleFavorite();
			return;
		}
		this.queryInput.handleInput(data);
		const next = this.queryInput.getValue();
		if (next !== this.query) {
			this.query = next;
			this.selectedIndex = 0;
			this.selectionError = null;
			this.refreshActions.requestRender?.();
		}
	}
}

function reloadKnowledgeBaseIfSupported(providers: ProvidersContract): void {
	const knowledgeBase = providers.knowledgeBase;
	const reload = (knowledgeBase as { reload?: unknown } | null)?.reload;
	if (typeof reload === "function") reload.call(knowledgeBase);
}

export function openModelOverlay(tui: TUI, deps: OpenModelOverlayDeps): OverlayHandle {
	const currentSettings = (): Readonly<ClioSettings> => deps.getSettings?.() ?? deps.settings;
	const build = (options?: { reloadCatalog?: boolean }): ModelItemsResult => {
		if (options?.reloadCatalog) reloadKnowledgeBaseIfSupported(deps.providers);
		return buildModelItems({ settings: currentSettings(), providers: deps.providers });
	};
	const initial = build();
	const overlayWidth = resolveOverlayWidth(tui.terminal?.columns ?? 0);
	const activeTarget = currentSettings().chat?.target?.trim();
	const activeModel = currentSettings().chat?.model?.trim();
	const view = new ModelOverlayView(
		initial.rows,
		initial.summary,
		(ref) => deps.onSelect(ref),
		deps.onToggleFavorite ? (ref, favorite) => deps.onToggleFavorite?.(ref, favorite) : undefined,
		() => deps.onClose(),
		{
			selected: async (targetId) => {
				await deps.providers.probeTarget(targetId);
				return build({ reloadCatalog: true });
			},
			all: async () => {
				await deps.providers.probeAllLive();
				return build({ reloadCatalog: true });
			},
			requestRender: () => tui.requestRender(),
		},
	);
	if (activeTarget && activeModel) view.setSelectedValue(`${activeTarget}/${activeModel}`);
	const unsubscribeHealth = deps.bus?.subscribe("provider.health_changed", () => {
		if (view.isDisposed()) return;
		view.replaceItems(build());
		tui.requestRender();
	});
	const handle = showClioOverlayFrame(tui, view, {
		anchor: "center",
		width: overlayWidth,
		markerId: "model",
		title: "Models",
		footerHint: buildResponsiveHint([
			FILTER_HINT,
			{ key: "Tab", verb: "focus/all" },
			{ key: "r", verb: "refresh target", short: "refresh" },
			{ key: "R", verb: "refresh all" },
			{ key: "*", verb: "fav" },
			{ key: "Enter", verb: "use" },
		]),
	});
	if (deps.autoRefresh !== false) {
		view.refresh("all");
	}
	return {
		...handle,
		hide(): void {
			view.dispose();
			unsubscribeHealth?.();
			handle.hide();
		},
	};
}
