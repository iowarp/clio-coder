import type { ClioSettings } from "../../core/config.js";
import { relative } from "../../core/format-time.js";
import { type PickerDetail, tierPolicy } from "../../core/presentation-tier.js";
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
	chatModelCandidatesForStatus,
	hasLiveModelCatalog,
	isOrchestratorEligibleRuntime,
	modelIdsForStatus,
	modelListNoteForStatus,
	modelResidencyForStatus,
	newerModelNotice,
	resolveRuntimeTarget,
	supportsAgentRoleTools,
	thinkingEffectNote,
} from "../../domains/providers/index.js";
import type { Component, OverlayHandle, TUI } from "../../engine/tui.js";
import {
	fuzzyFilter,
	getKeybindings,
	Input,
	matchesKey,
	stripTerminalSequences,
	visibleWidth,
	wrapTextWithAnsi,
} from "../../engine/tui.js";
import { localKey } from "../keyboard-owner.js";
import {
	buildResponsiveHint,
	clioError,
	diagnosticSeverityToken,
	FILTER_HINT,
	formatRuntimeResolutionDiagnostic,
	type HintEntry,
	type RowBudgetedBody,
	showClioOverlayFrame,
	windowRows,
} from "../overlay-frame.js";
import type { ClioToken, Fact, SideUnit, StatusKind, TableCell, TableColumn } from "../theme/index.js";
import {
	chip,
	clioTheme,
	emptyState,
	factRows,
	fitIdentityLabel,
	fitSides,
	GLYPH,
	padAnsi,
	positionRow,
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
const STATE_COL_WIDTH = 8;
const TARGET_COL_WIDTH_NARROW = 8;
const TARGET_COL_WIDTH_WIDE = 12;
const RUNTIME_COL_WIDTH_NARROW = 10;
const RUNTIME_COL_WIDTH_MEDIUM = 14;
const RUNTIME_COL_WIDTH_WIDE = 18;
const TARGET_COL_WIDTH_MAX = 24;
const RUNTIME_COL_WIDTH_MAX = 28;
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
	/** Enter: use the row for this session. */
	onSelect: (ref: ModelSelection) => void;
	/** `s`: save the row as a default, through the scope card. */
	onSave?: (ref: ModelSelection) => void;
	/** What switching to the row costs this session's prompt cache, shown in its detail since Enter no longer stops at the card. */
	switchCost?: (ref: ModelSelection) => string | null;
	onToggleFavorite?: (ref: ModelSelection, favorite: boolean) => void;
	onClose: () => void;
	autoRefresh?: boolean;
	/** What a pick would do to the turn in flight, asked on every frame so it stays true up to the Enter. */
	turnEffect?: () => string | null;
	/** The row to select on open, as `target/model`, when the picker reopens on a pick the operator backed out of. */
	initialSelection?: string;
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
	/** Whether the model is in memory where it would run; null where residency is not a property of the route. */
	residency?: ModelResidencyWord | null;
	authText: string;
	available: boolean;
	reason: string;
	healthToken: ClioToken;
	healthText: string;
	/** When the target's health was last checked, as the provider recorded it; null before any check. */
	healthCheckedAt?: string | null;
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

export type ModelResidencyWord = "resident" | "loading" | "unloaded" | "failed" | "unknown";

/**
 * Residency as the runtime reported it on its last live answer (J2-F15). A hosted cloud API always serves, so it has
 * none; a gateway or a runtime that does not report it reads `unknown` rather than a guess, and so does a model list
 * that is not the provider's live answer, because a cached state says nothing about what is loaded now.
 */
export function modelResidencyWord(status: TargetStatus, modelId: string): ModelResidencyWord | null {
	if (modelBucket(status) === "cloud") return null;
	if (!hasLiveModelCatalog(status) || modelId.length === 0) return "unknown";
	if (status.discoveredModelStates?.[modelId]?.state === "failed") return "failed";
	switch (modelResidencyForStatus(status, modelId)) {
		case "resident":
			return "resident";
		case "loading":
			return "loading";
		case "absent":
			return "unloaded";
		default:
			return "unknown";
	}
}

/** The residency as one plain sentence, for the selected row's detail and the scope dialog. */
export function modelResidencySentence(word: ModelResidencyWord | null, model: string, target: string): string | null {
	switch (word) {
		case "resident":
			return `${model} is loaded on ${target}, so there is no load to wait for.`;
		case "loading":
			return `${model} is loading on ${target}; the first reply waits for it.`;
		case "unloaded":
			return `${model} is not loaded on ${target}; the first request loads it, which can take a minute.`;
		case "failed":
			return `${target} reported that loading ${model} failed; the first request tries again.`;
		case "unknown":
			return `${target} does not report whether ${model} is loaded.`;
		default:
			return null;
	}
}

const RESIDENCY_TONES: Record<ModelResidencyWord, ClioToken> = {
	resident: "success",
	loading: "warning",
	unloaded: "counter",
	failed: "error",
	unknown: "unknownValue",
};

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
			thinkingNote: thinkingEffectNote({
				...resolution.target.modelRuntime.thinking,
				model: resolution.target.modelRuntime.modelId,
			}),
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
	const activeRef = activeTarget && activeModel ? modelRefWords(activeTarget, activeModel) : activeTarget;
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
		const candidates = chatModelCandidatesForStatus(status);
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
				residency: modelBucket(status) === "cloud" ? null : "unknown",
				authText,
				available: status.available,
				reason: status.reason,
				healthToken: healthToken(status),
				healthText: healthText(status),
				healthCheckedAt: status.health.lastCheckAt,
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
				residency: modelResidencyWord(status, wireModel),
				authText,
				available: status.available,
				reason: status.reason,
				healthToken: healthToken(status),
				healthText: healthText(status),
				healthCheckedAt: status.health.lastCheckAt,
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
	showState: boolean;
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
function modelLayout(
	width: number,
	hasState: boolean,
	content?: { model: number; target: number; runtime: number },
): ModelLayout {
	const fixed = columnLayout(
		width,
		hasState,
		width >= 92 ? TARGET_COL_WIDTH_WIDE : TARGET_COL_WIDTH_NARROW,
		width >= 96 ? RUNTIME_COL_WIDTH_WIDE : width >= 78 ? RUNTIME_COL_WIDTH_MEDIUM : RUNTIME_COL_WIDTH_NARROW,
	);
	if (content === undefined) return fixed;
	// A wide picker cut `offline-audit` to `offline-aud…` with forty idle cells in
	// the model column. When every id still fits whole, the target and runtime
	// columns take the width their own names need instead of a fixed stop.
	const fitted = columnLayout(
		width,
		hasState,
		Math.min(content.target, TARGET_COL_WIDTH_MAX),
		Math.min(content.runtime, RUNTIME_COL_WIDTH_MAX),
	);
	const idsWhole = fitted.modelWidth - MODEL_COL_GUTTER >= Math.max(MODEL_MIN_WIDTH, content.model);
	return fitted.showTarget && fitted.showRuntime && idsWhole ? fitted : fixed;
}

function columnLayout(width: number, hasState: boolean, targetWidth: number, runtimeWidth: number): ModelLayout {
	let showTarget = width >= 58;
	let showRuntime = width >= 68;
	let showState = hasState;
	const modelWidthFor = (): number => {
		let fixed = SELECTED_PREFIX_WIDTH + MODEL_TABLE_GAP + CONTEXT_COL_WIDTH + MODEL_TABLE_GAP + CAPS_COL_WIDTH;
		if (showState) fixed += MODEL_TABLE_GAP + STATE_COL_WIDTH;
		if (showTarget) fixed += MODEL_TABLE_GAP + targetWidth;
		if (showRuntime) fixed += MODEL_TABLE_GAP + runtimeWidth;
		return width - fixed;
	};
	let modelWidth = modelWidthFor();
	if (modelWidth < MODEL_MIN_WIDTH && showRuntime) {
		showRuntime = false;
		modelWidth = modelWidthFor();
	}
	// Whether the pick will wait on a load outlasts which target serves it only once the id itself is at stake.
	if (modelWidth < MODEL_MIN_WIDTH && showTarget) {
		showTarget = false;
		modelWidth = modelWidthFor();
	}
	if (modelWidth < MODEL_MIN_WIDTH && showState) {
		showState = false;
		modelWidth = modelWidthFor();
	}
	return { modelWidth: Math.max(1, modelWidth), showState, showTarget, showRuntime, targetWidth, runtimeWidth };
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
	const longest = (values: ReadonlyArray<string>, header: string): number =>
		Math.max(header.length, ...values.map((value) => visibleWidth(value)));
	const layout = modelLayout(
		width,
		rows.some((row) => row.residency != null),
		{
			model: longest(
				rows.map((row) => row.model),
				"model",
			),
			target: longest(
				rows.map((row) => row.target),
				"target",
			),
			runtime: longest(
				rows.map((row) => row.runtimeShortName),
				"runtime",
			),
		},
	);
	const modelColumnWidth = SELECTED_PREFIX_WIDTH + layout.modelWidth;
	const columns: TableColumn[] = [
		{ label: `${" ".repeat(SELECTED_PREFIX_WIDTH)}model`, min: modelColumnWidth, max: modelColumnWidth, priority: 10 },
		{ label: "ctx", align: "right", min: CONTEXT_COL_WIDTH, max: CONTEXT_COL_WIDTH, priority: 4 },
		{ label: "caps", min: CAPS_COL_WIDTH, max: CAPS_COL_WIDTH, priority: 3 },
		...(layout.showState
			? [{ label: "state", min: STATE_COL_WIDTH, max: STATE_COL_WIDTH, priority: 3 } satisfies TableColumn]
			: []),
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
			contextCell(row),
			{ text: row.badges, tone: "muted" },
			...(layout.showState ? [residencyCell(row)] : []),
			...(layout.showTarget ? [theme.fg("modelIdentity", row.target)] : []),
			...(layout.showRuntime ? [{ text: row.runtimeShortName, tone: "muted" } satisfies TableCell] : []),
		];
	});
	const lines = tableRows(theme, { columns, rows: table, header: true, gap: MODEL_TABLE_GAP }, width);
	const chosen = rows[selectedIndex];
	// Header and divider lead; no column wraps, so every row is one line after them.
	const at = 2 + selectedIndex;
	if (chosen === undefined || lines[at] === undefined) return lines;
	// The model column as the table drew it: its natural width, bounded by the layout's.
	const drawnModel = Math.min(
		modelColumnWidth,
		Math.max(visibleWidth(columns[0]?.label ?? ""), ...table.map((cells) => visibleWidth(String(cells[0] ?? "")))),
	);
	const whole = selectedRowLines(chosen, layout, width, drawnModel - SELECTED_PREFIX_WIDTH);
	return whole === null ? lines : [...lines.slice(0, at), ...whole, ...lines.slice(at + 1)];
}

/** The ctx cell: a bare count under its header, `128k`, or `?` for unknown. */
function contextCell(row: ModelRow): string {
	return clioTheme().fg(
		row.context === "-" || row.context === "?" || row.context === "?ctx" ? "unknownValue" : "counter",
		row.context.replace(/ctx$/u, ""),
	);
}

function residencyCell(row: ModelRow): string {
	return row.residency ? clioTheme().fg(RESIDENCY_TONES[row.residency], row.residency) : "";
}

function alignRight(text: string, width: number): string {
	return `${" ".repeat(Math.max(0, width - visibleWidth(text)))}${text}`;
}

/**
 * The selected row with its model and target printed whole, or null when the table's own row already does. The
 * picker is where the full route is always one key away (Alt+M), so the row the cursor is on never shortens the id
 * or loses the target to a narrow column. It stays one row when it can, giving up runtime and then residency (the
 * status row under the table names the route and its health); ctx and caps keep their place beside the id. When the
 * target still does not fit beside them it moves to a continuation row under the id, and an id wider than the row
 * wraps rather than being cut.
 */
function selectedRowLines(row: ModelRow, layout: ModelLayout, width: number, drawnModelWidth: number): string[] | null {
	const theme = clioTheme();
	const id = row.model.length > 0 ? row.model : "(no model ids)";
	const idRoom = Math.max(1, layout.modelWidth - MODEL_COL_GUTTER);
	const idFits = visibleWidth(id) <= idRoom;
	const targetFits = layout.showTarget && visibleWidth(row.target) <= layout.targetWidth;
	if (idFits && targetFits) return null;
	const gap = " ".repeat(MODEL_TABLE_GAP);
	const lead = `${theme.fg("selectedOption", GLYPH.cursor)} ${activeMark(row)} `;
	const model = theme.style("selectedOption", id, { bold: true });
	const target = theme.fg("modelIdentity", row.target);
	// While the id fits its column the row keeps the column stops; past it the cells follow the id at the gap.
	const modelCell = idFits ? padAnsi(model, drawnModelWidth) : `${model}${" ".repeat(MODEL_COL_GUTTER)}`;
	const facts = [
		alignRight(contextCell(row), CONTEXT_COL_WIDTH),
		padAnsi(chip(theme, row.badges, "muted"), CAPS_COL_WIDTH),
	];
	const state = layout.showState ? padAnsi(residencyCell(row), STATE_COL_WIDTH) : null;
	const runtime = layout.showRuntime ? chip(theme, row.runtimeShortName, "muted") : null;
	const fit = (line: string): boolean => visibleWidth(line) <= width;
	const join = (cells: ReadonlyArray<string | null>): string =>
		cells
			.filter((cell): cell is string => cell !== null)
			.join(gap)
			.trimEnd();
	for (const line of [
		join([`${lead}${modelCell}`, ...facts, state, target, runtime]),
		join([`${lead}${modelCell}`, ...facts, state, target]),
		join([`${lead}${modelCell}`, ...facts, target]),
	]) {
		if (fit(line)) return [line];
	}
	const indent = " ".repeat(SELECTED_PREFIX_WIDTH);
	const room = Math.max(1, width - SELECTED_PREFIX_WIDTH);
	const first = join([`${lead}${modelCell}`, ...facts]);
	const idLines = fit(first)
		? [first]
		: wrapTextWithAnsi(model, room).map((part, index) => `${index === 0 ? lead : indent}${part}`);
	return [...idLines, ...wrapTextWithAnsi(target, room).map((part) => `${indent}${part}`)];
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

function statusGlyph(status: StatusKind): string {
	switch (status) {
		case "ok":
			return GLYPH.ok;
		case "error":
			return GLYPH.error;
		case "warning":
			return GLYPH.warn;
		default:
			return GLYPH.info;
	}
}

/** What the selected model is to the operator, in words: in use, a default, in the cycle, or none of those. */
function selectionStateWords(row: ModelRow): string {
	const tags: string[] = [];
	if (row.active) tags.push("in use");
	if (row.defaultModel) tags.push("its connection's default");
	if (row.scoped) tags.push("in the model cycle");
	if (row.favorite) tags.push("favorite");
	if (row.recent) tags.push("used recently");
	return tags.length > 0 ? tags.join(", ") : row.selectable ? "not in use" : "cannot be picked";
}

/**
 * The selection's status row: the health glyph, the route whole, then its health, what it is to you and its sign-in.
 * Those three give way whole from the right (a health that is not healthy keeps its word), and the route never does:
 * the picker is where the operator reads the full target and model, so when the row cannot hold it the route wraps
 * onto as many rows as it takes instead of being cut.
 */
function selectionStatusRows(row: ModelRow, width: number): string[] {
	const theme = clioTheme();
	const status = healthStatus(row);
	const glyph = statusGlyph(status);
	const route = modelRefWords(row.target, row.model);
	const availability = row.available ? row.healthText : `${row.healthText}; ${row.reason || "unavailable"}`;
	const healthWord = row.healthText.split(/[:\s]/u)[0] ?? row.healthText;
	const healthy = status === "ok" && row.available;
	if (visibleWidth(`${glyph} ${route}`) > width) {
		const lines = wrapTextWithAnsi(
			`${theme.fg(row.healthToken, glyph)} ${theme.fg("activeModelIdentity", route)}`,
			width,
		);
		return healthy ? lines : [...lines, ...wrapTextWithAnsi(theme.fg(row.healthToken, healthWord), width)];
	}
	const units: SideUnit[] = [
		{ text: glyph, lead: true, paint: (text) => theme.fg(row.healthToken, text) },
		{ text: route, paint: (text) => theme.fg("activeModelIdentity", text) },
		{
			text: availability,
			paint: (text) => theme.fg(row.healthToken, text),
			...(availability !== healthWord ? { shorter: [{ text: healthWord, rank: 2 }] } : {}),
			// A healthy route's word is the reassuring fact, so it gives way before what the model is to you.
			...(healthy ? { drop: 2.5 } : {}),
		},
		{ text: selectionStateWords(row), drop: 3, paint: (text) => theme.fg("annotation", text) },
		{ text: authWords(row.authText), drop: 1, paint: (text) => chip(theme, text, "muted") },
	];
	return [fitSides(theme, units, [], width).trimEnd()];
}

/** The target's last health check: its answer, its latency or error, and how long ago it ran. */
function healthHistoryWords(row: ModelRow): string {
	const checked = row.healthCheckedAt ? `checked ${relative(row.healthCheckedAt)}` : "not checked yet";
	return `${row.healthText} ${GLYPH.sep} ${checked}`;
}

/** The credential in words, with the source it was read from when the words do not already say it. */
function signInWords(authText: string): string {
	const words = authWords(authText);
	return words === authText || authText === "unknown" || authText === "disconnected" || authText === "not required"
		? words
		: `${words} ${GLYPH.sep} ${authText}`;
}

/**
 * The selected row, explained, as deep as the tier's `pickerDetail` reaches. Every tier leads with the status row
 * (health, the route whole, what it is to you, sign-in), then what blocks it: an unreachable route's next step and
 * any warning or error the resolution raised, which no tier hides. Standard adds the facts a switch is decided on
 * (residency, what the switch costs the cache, context and thinking); detailed adds the full pane (capabilities,
 * replies, load state, runtime, the health check's history and the sign-in source). `maxRows` is what the body can
 * spare; the facts give way first and say where they were cut.
 */
function formatModelDetail(
	row: ModelRow,
	width: number,
	maxRows: number,
	switchCost: string | null | undefined,
	detail: PickerDetail,
): string[] {
	const theme = clioTheme();
	const status = selectionStatusRows(row, width);
	const withFacts = detail !== "status";
	const residency = modelResidencySentence(row.residency ?? null, row.model, row.target);
	// Residency reads as its own line in its own tone, above the facts that give way first.
	const residencyLines =
		withFacts && residency && row.residency
			? wrapTextWithAnsi(
					theme.fg(RESIDENCY_TONES[row.residency], `${residency}${row.loadStateDetail ? ` (${row.loadStateDetail})` : ""}`),
					width,
				).slice(0, 2)
			: [];
	const costLines =
		withFacts && switchCost ? wrapTextWithAnsi(theme.fg("annotation", switchCost), width).slice(0, 2) : [];
	// Severity colors the way the targets hub colors it, through the shared mapping. The thinking
	// fact already says what runs and why, and from standard up an unknown context window is the
	// context fact's own value, so neither repeats as a diagnostic there; at compact, where there is
	// no context fact, the warning stands on its own row.
	const shown = (row.diagnostics ?? []).filter((entry) => entry.severity !== "info");
	const contextNote = shown.find((entry) => entry.code === CONTEXT_UNVERIFIED_CODE);
	const diagnostics = shown
		.filter((entry) => (withFacts ? entry !== contextNote : true) && !entry.code.startsWith("thinking-"))
		.slice(0, 2)
		.flatMap((entry) => {
			const token = diagnosticSeverityToken(entry.severity);
			return capWrapped(
				wrapTextWithAnsi(theme.fg(token, `${token === "error" ? GLYPH.error : GLYPH.warn} ${entry.message}`), width),
				2,
			);
		});
	const known = (value: string): boolean => value !== "?" && value !== "-" && value.length > 0;
	const context = row.context.replace(/ctx$/u, "");
	// In the order a switch is decided on: how much the model holds, how it thinks, what it can do.
	const keyFacts: Fact[] = withFacts
		? [
				known(context)
					? { label: "context", value: `${context} tokens` }
					: {
							label: "context",
							// The diagnostic's own sentence took three rows at 60 columns and pushed thinking off the card.
							value: contextNote
								? "unknown, so CLIO Coder compacts at its token budget; clio-coder configure can set it"
								: "unknown",
							tone: contextNote ? "warning" : "muted",
						},
				{
					label: "thinking",
					value: `${row.thinking ?? "not reported"}${row.thinkingNote ? `; ${row.thinkingNote}, your setting is kept` : ""}`,
				},
			]
		: [];
	const paneFacts: Fact[] =
		detail === "pane"
			? [
					// Health history and sign-in lead the pane: they are what detailed adds, so a short body cuts runtime first.
					{ label: "health", value: healthHistoryWords(row) },
					{ label: "sign-in", value: signInWords(row.authText) },
					{ label: "can use", value: capabilityNames(row.caps) },
					{
						label: "replies",
						value: [
							known(row.maxTokens) ? `up to ${row.maxTokens} tokens` : "no reported length limit",
							row.streaming === false ? "whole, not streamed" : "streamed",
							acceptsImageInput({ vision: row.caps.vision }) ? "takes images" : "text only",
						].join(` ${GLYPH.sep} `),
					},
					...(residency === null && row.loadState
						? [{ label: "state", value: `${row.loadState}${row.loadStateDetail ? ` (${row.loadStateDetail})` : ""}` }]
						: []),
					{ label: "runtime", value: `${row.runtimeName} ${GLYPH.sep} ${row.sourceNote ?? modelListWords(row.source)}` },
				]
			: [];
	const factLines = factRows(
		theme,
		[...keyFacts, ...paneFacts].map((fact) => ({ ...fact, tone: fact.tone ?? "muted" })),
		width,
	);
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
	const factBudget = Math.max(
		factLines.length === 0 ? 0 : 1,
		Math.min(
			factLines.length,
			maxRows - status.length - next.length - residencyLines.length - costLines.length - diagnostics.length,
		),
	);
	const body = [...next, ...residencyLines, ...costLines, ...capWrapped(factLines, factBudget), ...diagnostics];
	// The status row carries the route whole and is never cut; what follows it gives way to the room and says so.
	const room = maxRows - status.length;
	return room <= 0 ? status : [...status, ...capWrapped(body, room)];
}

/** The diagnostic an unknown context window raises; the detail's context fact carries its sentence instead. */
const CONTEXT_UNVERIFIED_CODE = "context-window-unverified";

/** At most `max` rows, the last closing on an ellipsis when rows were cut. */
function capWrapped(rows: ReadonlyArray<string>, max: number): string[] {
	if (rows.length <= max) return [...rows];
	const kept = rows.slice(0, Math.max(1, max));
	const last = kept.at(-1);
	if (last !== undefined && !stripTerminalSequences(last).trimEnd().endsWith(GLYPH.ellipsis))
		kept[kept.length - 1] = `${last}${GLYPH.ellipsis}`;
	return kept;
}

/** A connection and its model the way the composer names them: `mock · mock/judge-model`, never `mock/mock/judge-model`. */
function modelRefWords(target: string, model: string): string {
	return model.length > 0 ? `${target} ${GLYPH.sep} ${model}` : target;
}

/** Where the picker's list of this connection's models came from, in words. */
function modelListWords(source: ModelSource): string {
	switch (source) {
		case "configured":
			return "models listed in settings";
		case "live":
			return "models listed by the server just now";
		case "cache":
			return "models from a cached list";
		case "catalog":
			return "models from CLIO Coder's catalog";
		case "default":
			return "only the connection's default model";
		default:
			return "no model ids";
	}
}

/** The credential a connection uses, in words. */
function authWords(authText: string): string {
	const [source = "", detail] = authText.split(":");
	switch (source) {
		case "not required":
		case "not-required":
		case "none":
			return "no sign-in needed";
		case "disconnected":
			return "not signed in";
		case "unknown":
			return "sign-in unknown";
		case "env":
		case "environment":
			return detail ? `key from ${detail}` : "key from the environment";
		case "stored-api-key":
			return "saved API key";
		case "stored-oauth":
			return "signed in through the browser";
		case "runtime-override":
			return "key set for this run";
		case "fallback":
			return "fallback credential";
		default:
			return detail ? `${source} (${detail})` : source;
	}
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

/**
 * Rows a query names, best first: a word of the ref that starts with the query, then the ref containing every word of
 * it, then the row's other facts (runtime, health, residency) containing them. A scattered-letter match only answers
 * when nothing contains the query, because `ornith` matching an embedding model through letters spread across its
 * runtime name and health is noise, not a result (J2-F09).
 */
function filterModelRows(rows: ReadonlyArray<ModelRow>, query: string): ModelRow[] {
	const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
	if (words.length === 0) return [...rows];
	const tiers: ModelRow[][] = [[], [], []];
	for (const row of rows) {
		const ref = (row.model.length > 0 ? `${row.target}/${row.model}` : row.target).toLowerCase();
		const facts = modelSelectorSearchText(row).toLowerCase();
		if (!words.every((word) => ref.includes(word))) {
			if (words.every((word) => facts.includes(word))) tiers[2]?.push(row);
			continue;
		}
		const first = words[0] ?? "";
		const startsWord = ref.split(/[/\s:_.-]+/u).some((part) => part.startsWith(first)) || ref.startsWith(first);
		tiers[startsWord ? 0 : 1]?.push(row);
	}
	const contained = tiers.flat();
	return contained.length > 0 ? contained : fuzzyFilter([...rows], query, modelSelectorSearchText);
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/**
 * The picker's summary row, fitted from whole units so it never ends on a cut chip: the mode leads in the accent
 * because Tab changes it and never drops; the local and cloud split (shown only when both are present) goes first,
 * then the target count, then the current route, and the match count last. The current route is printed whole or
 * not at all; the selection's status row prints whichever route the cursor is on.
 */
function summaryLine(
	summary: ModelOverlaySummary,
	mode: string,
	matches: number,
	active: string,
	width: number,
): string {
	const theme = clioTheme();
	const muted = (text: string): string => chip(theme, text, "muted");
	const split = summary.localModels > 0 && summary.cloudModels > 0;
	const units: SideUnit[] = [
		{ text: mode, paint: (text) => chip(theme, text, "accent") },
		{
			text: `${matches} of ${plural(summary.totalModels, "model", "models")}`,
			drop: 5,
			paint: muted,
			shorter: [{ text: `${matches} of ${summary.totalModels}`, rank: 4.5 }],
		},
		{ text: plural(summary.targets, "target", "targets"), drop: 2, paint: muted },
		...(split
			? [
					{ text: `${summary.localModels} local`, drop: 1, paint: muted },
					{ text: `${summary.cloudModels} cloud`, drop: 1, paint: muted },
				]
			: []),
		{ text: `${GLYPH.ok} current ${active}`, drop: 3, paint: muted },
	];
	return fitSides(theme, units, [], width).trimEnd();
}

function refreshStatusLine(
	refreshing: ModelRefreshScope | null | undefined,
	error: RuntimeResolutionDiagnostic | null | undefined,
): string | null {
	if (refreshing)
		return refreshing === "all"
			? `refreshing all targets and model catalogs${GLYPH.ellipsis}`
			: `refreshing selected target models${GLYPH.ellipsis}`;
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
	switchCost?: (ref: ModelSelection) => string | null;
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
	const detailDepth = tierPolicy().pickerDetail;
	const lines = [summaryLine(input.summary, mode, selectableFiltered, active, width)];
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
	// The detail is sized before the table: the tier decides how deep it goes (one status row, the key facts, or the
	// full pane), and the table windows into what that leaves, so a deeper tier shows fewer rows rather than a cut pane.
	const cost =
		selected?.selectable && input.switchCost
			? input.switchCost({ target: selected.target, model: selected.model })
			: null;
	const naturalDetail = selected
		? formatModelDetail(selected, width, Number.POSITIVE_INFINITY, cost, detailDepth).length
		: 1;
	// Header, divider, position row and the blank row above the detail.
	const budget =
		bodyRows > 0 ? Math.max(MODEL_MIN_VISIBLE_ROWS, bodyRows - lines.length - 4 - naturalDetail) : VISIBLE_ROWS;
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
		let { window, start, position } = windowRows(filtered, selectedIndex, budget);
		let table = modelTableLines(window, selectedIndex - start, width);
		// A selected row that carries its target or id onto continuation rows takes them from the table, not the detail.
		const extra = table.length - window.length - 2;
		if (bodyRows > 0 && extra > 0 && budget - extra >= MODEL_MIN_VISIBLE_ROWS) {
			({ window, start, position } = windowRows(filtered, selectedIndex, budget - extra));
			table = modelTableLines(window, selectedIndex - start, width);
		}
		lines.push(...table);
		if (position !== null || hidden > 0) {
			lines.push(
				positionRow(
					theme,
					{
						start: position?.start ?? 1,
						end: position?.end ?? filtered.length,
						total: filtered.length,
						unit: "models",
						keys: [
							...(position !== null ? ["PgUp/PgDn page"] : []),
							...(hidden > 0 ? [`Tab shows all ${allMatches.length}`] : []),
						],
					},
					width,
				),
			);
		}
	}
	// With no budget known yet the detail renders whole, the way every other windowed body does. A short
	// dock gives the detail what the table leaves and cuts it with a mark, rather than overfilling the frame
	// and losing the rows below the table to the frame's own cut.
	const spare = bodyRows > 0 ? bodyRows - lines.length : Number.POSITIVE_INFINITY;
	if (spare >= 3) lines.push("");
	if (selected) {
		const room = Math.max(1, spare >= 3 ? spare - 1 : spare);
		lines.push(...formatModelDetail(selected, width, room, cost, detailDepth));
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
	private showAllChosen = false;
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
		private readonly turnEffect?: () => string | null,
		private readonly extras: Pick<OpenModelOverlayDeps, "onSave" | "switchCost"> = {},
	) {
		this.rows = [...rows];
		this.summary = summary;
		this.openOnAllWhenFocusHides();
	}

	/** A focus view of fewer than two rows hides the choice it exists to offer, so the picker lists everything until Tab says otherwise. */
	private openOnAllWhenFocusHides(): void {
		if (this.showAllChosen) return;
		this.showAll = this.rows.filter((row) => row.visibleByDefault !== false).length < 2;
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
		this.openOnAllWhenFocusHides();
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
		this.showAllChosen = true;
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
		const effect = this.turnEffect?.() ?? null;
		const list = this.renderList(width, effect === null ? this.bodyRows : Math.max(0, this.bodyRows - 1));
		return effect === null ? list : [padAnsi(clioTheme().fg("accent", effect), width, GLYPH.ellipsis), ...list];
	}

	private renderList(width: number, bodyRows: number): string[] {
		return renderModelOverlayLines({
			rows: this.rows,
			summary: this.summary,
			selectedIndex: this.selectedIndex,
			query: this.query,
			width,
			bodyRows,
			showAll: this.showAll,
			refreshing: this.refreshing,
			refreshError: this.refreshError,
			selectionError: this.selectionError,
			...(this.extras.switchCost ? { switchCost: this.extras.switchCost } : {}),
		});
	}

	invalidate(): void {}

	/** While a query is typed, s, r, R and * type into it, and Esc clears it instead of closing. */
	railHint(innerWidth: number): string {
		const use: HintEntry = { key: "Enter", verb: "use this session", short: "use" };
		// A narrow rail keeps its last extras, so r and R lead here to be the first to go.
		return this.query.length > 0
			? buildResponsiveHint([FILTER_HINT, use, { key: "Tab", verb: "focus/all" }], "clear filter")(innerWidth)
			: buildResponsiveHint([
					{ key: "r", verb: "refresh target", short: "refresh" },
					{ key: "R", verb: "refresh all" },
					FILTER_HINT,
					use,
					...(this.extras.onSave ? [{ key: "s", verb: "save as default", short: "save" }] : []),
					{ key: "Tab", verb: "focus/all" },
					{ key: "*", verb: "fav" },
				])(innerWidth);
	}

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
		if (kb.matches(data, "tui.select.pageUp") || kb.matches(data, "tui.select.pageDown")) {
			this.selectionError = null;
			const count = this.filteredRows().length;
			const page = Math.max(MODEL_MIN_VISIBLE_ROWS, this.bodyRows - MODEL_CHROME_ROWS);
			const next = this.selectedIndex + (kb.matches(data, "tui.select.pageDown") ? page : -page);
			this.selectedIndex = Math.max(0, Math.min(next, count - 1));
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || matchesKey(data, "enter") || data === "\n") {
			const row = this.selectedRow();
			if (row?.selectable) {
				// Close the picker before handing the selection to its owner, which
				// may open another overlay that closing afterwards would dismiss.
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
		if (data === "s" && this.query.length === 0 && this.extras.onSave) {
			const row = this.selectedRow();
			if (row?.selectable) {
				this.onClose();
				this.extras.onSave({ target: row.target, model: row.model });
			}
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
		deps.turnEffect,
		{
			...(deps.onSave ? { onSave: deps.onSave } : {}),
			...(deps.switchCost ? { switchCost: deps.switchCost } : {}),
		},
	);
	if (deps.initialSelection) view.setSelectedValue(deps.initialSelection);
	else if (activeTarget && activeModel) view.setSelectedValue(`${activeTarget}/${activeModel}`);
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
		footerHint: (innerWidth) => view.railHint(innerWidth),
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
