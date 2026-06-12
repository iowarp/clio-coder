import { BusChannels } from "../../core/bus-events.js";
import type { ClioSettings } from "../../core/config.js";
import type { SafeEventBus } from "../../core/event-bus.js";
import type {
	CapabilityFlags,
	EndpointStatus,
	ProvidersContract,
	ResolvedRuntimeTarget,
	RuntimeCapabilityDecision,
	RuntimeResolutionDiagnostic,
	ThinkingLevel,
} from "../../domains/providers/index.js";
import {
	isTargetEligibleRuntime,
	listKnownModelsForRuntime,
	resolveRuntimeTarget,
} from "../../domains/providers/index.js";
import {
	type Component,
	getKeybindings,
	matchesKey,
	type OverlayHandle,
	type SelectItem,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "../../engine/tui.js";
import {
	buildHint,
	clioError,
	clioFrame,
	clioTitle,
	formatRuntimeResolutionDiagnostic,
	runtimeResolutionDiagnosticLine,
	showClioOverlayFrame,
} from "../overlay-frame.js";

export const MODEL_OVERLAY_WIDTH = 82;
const MODEL_OVERLAY_MAX_WIDTH = 120;
const MODEL_OVERLAY_TERMINAL_PADDING = 8;
const VISIBLE_ROWS = 10;
const MODEL_MIN_WIDTH = 14;
const CONTEXT_COL_WIDTH = 7;
const CAPS_COL_WIDTH = 5;
const TARGET_COL_WIDTH_NARROW = 8;
const TARGET_COL_WIDTH_WIDE = 12;
const RUNTIME_COL_WIDTH_NARROW = 10;
const RUNTIME_COL_WIDTH_MEDIUM = 14;
const RUNTIME_COL_WIDTH_WIDE = 18;
const SELECTED_PREFIX_WIDTH = 6;
const BACKSPACE = "\x7f";
const BACKSPACE_ALT = "\b";
const CTRL_U = "\x15";
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
	endpoint: string;
	model: string;
}

export interface OpenModelOverlayDeps {
	settings: Readonly<ClioSettings>;
	/** Optional live settings resolver so refreshes pick up target/config edits made while the overlay is open. */
	getSettings?: () => Readonly<ClioSettings>;
	providers: ProvidersContract;
	bus?: SafeEventBus;
	onSelect: (ref: ModelSelection) => void;
	onToggleFavorite?: (ref: ModelSelection, favorite: boolean) => void;
	onClose: () => void;
}

function healthGlyph(status: EndpointStatus): string {
	switch (status.health.status) {
		case "healthy":
			return "●";
		case "degraded":
			return "◐";
		case "down":
			return "○";
		default:
			return "·";
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

function uniqueModels(ids: ReadonlyArray<string>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of ids) {
		const trimmed = id.trim();
		if (trimmed.length === 0 || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

function truncateMiddle(text: string, maxWidth: number): string {
	if (maxWidth <= 0 || text.length <= maxWidth) return text;
	if (maxWidth <= 8) return truncateToWidth(text, maxWidth, "", true);
	const suffixWidth = Math.min(14, Math.max(6, Math.floor(maxWidth / 3)));
	const prefixWidth = maxWidth - suffixWidth - 1;
	if (prefixWidth <= 0) return truncateToWidth(text, maxWidth, "", true);
	return `${text.slice(0, prefixWidth)}…${text.slice(-suffixWidth)}`;
}

type ModelSource = "configured" | "live" | "catalog" | "default" | "missing";
type ModelBucket = "local" | "cloud";
type ModelRefreshScope = "selected" | "all";

interface ModelCandidate {
	id: string;
	source: ModelSource;
}

export interface ModelRow {
	value: string;
	endpoint: string;
	model: string;
	runtimeName: string;
	runtimeShortName: string;
	runtimeId: string;
	apiFamily: string;
	bucket: ModelBucket;
	source: ModelSource;
	authText: string;
	available: boolean;
	reason: string;
	healthGlyph: string;
	healthText: string;
	caps: CapabilityFlags;
	capabilityDecisions?: RuntimeCapabilityDecision;
	thinking?: string;
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
}

/**
 * Enumerate the wire model ids to present for an endpoint. Configured
 * `endpoint.wireModels` remain first so operator-curated choices keep their
 * muscle memory, but live probe discoveries are appended so a runtime refresh
 * can surface newly installed or newly entitled models without restarting
 * Clio. If neither config nor a live probe has model ids, fall back to the
 * provider/runtime catalog and finally the target default.
 */
export function modelsForEndpoint(status: EndpointStatus): string[] {
	return modelCandidatesForEndpoint(status).map((candidate) => candidate.id);
}

export interface ModelItemsResult {
	items: SelectItem[];
	/** Parallel to items. onSelect of items[i] resolves to refs[i]. */
	refs: ModelSelection[];
	rows: ModelRow[];
	summary: ModelOverlaySummary;
}

function modelCandidatesForEndpoint(status: EndpointStatus): ModelCandidate[] {
	const configured = uniqueModels(status.endpoint.wireModels ?? []);
	const discovered = uniqueModels(status.discoveredModels);
	const defaultModel = status.endpoint.defaultModel?.trim() ?? "";
	const out: ModelCandidate[] = [];
	const seen = new Set<string>();
	const add = (id: string, source: ModelSource): void => {
		const trimmed = id.trim();
		if (trimmed.length === 0 || seen.has(trimmed)) return;
		seen.add(trimmed);
		out.push({ id: trimmed, source });
	};

	if (configured.length > 0 || discovered.length > 0) {
		const discoveredSet = new Set(discovered);
		for (const id of configured) add(id, "configured");
		if (defaultModel) add(defaultModel, discoveredSet.has(defaultModel) ? "live" : "default");
		for (const id of discovered) add(id, "live");
		return out;
	}

	const knownModels = listKnownModelsForRuntime(status.runtime?.id ?? status.endpoint.runtime);
	if (knownModels.length > 0) {
		const knownSet = new Set(knownModels);
		for (const id of uniqueModels([defaultModel, ...knownModels])) {
			add(id, knownSet.has(id) ? "catalog" : "default");
		}
		return out;
	}
	if (defaultModel) return [{ id: defaultModel, source: "default" }];
	return [];
}

function fallbackCapabilityDecisions(status: EndpointStatus, caps: CapabilityFlags): RuntimeCapabilityDecision {
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

function providersWithStatusFallback(providers: ProvidersContract, status: EndpointStatus): ProvidersContract {
	return {
		...providers,
		getEndpoint: (id) => providers.getEndpoint(id) ?? (id === status.endpoint.id ? status.endpoint : null),
		getRuntime: (id) => providers.getRuntime(id) ?? (status.runtime && id === status.runtime.id ? status.runtime : null),
	};
}

interface OverlayRuntimeResolution {
	target: ResolvedRuntimeTarget | null;
	diagnostics: RuntimeResolutionDiagnostic[];
	capabilities: CapabilityFlags;
	capabilityDecisions: RuntimeCapabilityDecision;
	thinking: string;
	streaming: boolean;
}

/** Resolve the same runtime/capability descriptor used by the footer and chat loop for one overlay row. */
export function resolveOverlayRuntimeTarget(input: {
	providers: ProvidersContract;
	status: EndpointStatus;
	wireModelId: string;
	requestedThinkingLevel?: ThinkingLevel;
}): OverlayRuntimeResolution {
	const resolution = resolveRuntimeTarget(providersWithStatusFallback(input.providers, input.status), {
		endpointId: input.status.endpoint.id,
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
		streaming: decisions.streaming,
	};
}

export function runtimeCapabilitySummary(resolution: OverlayRuntimeResolution): string {
	const caps = resolution.capabilityDecisions;
	const parts = [
		`${compactTokenCount(caps.contextWindow)}ctx`,
		`${compactTokenCount(caps.maxTokens)}max`,
		`thinking:${resolution.thinking}`,
		`streaming:${caps.streaming ? "yes" : "no"}`,
	];
	if (caps.tools) parts.push("tools");
	if (caps.vision) parts.push("vision");
	return parts.join("  ");
}

function modelBucket(status: EndpointStatus): ModelBucket {
	const tier = status.runtime?.tier;
	if (
		tier === "protocol" ||
		tier === "local-native" ||
		status.endpoint.url?.includes("127.0.0.1") ||
		status.endpoint.url?.includes("localhost")
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

function authLabel(deps: { providers: ProvidersContract; status: EndpointStatus }): string {
	const { providers, status } = deps;
	if (!status.runtime) return "unknown";
	const auth = providers.auth.statusForTarget(status.endpoint, status.runtime);
	if (!auth.available) return "disconnected";
	if (auth.source === "environment") return auth.detail ? `env:${auth.detail}` : "environment";
	if (auth.source === "none") return "not required";
	return auth.detail ? `${auth.source}:${auth.detail}` : auth.source;
}

function healthText(status: EndpointStatus): string {
	const latency =
		typeof status.health.latencyMs === "number" && Number.isFinite(status.health.latencyMs)
			? ` ${Math.round(status.health.latencyMs)}ms`
			: "";
	if (status.health.status === "unknown") return "unknown";
	if (status.health.lastError) return `${status.health.status}: ${status.health.lastError}`;
	return `${status.health.status}${latency}`;
}

function statusPriority(status: EndpointStatus): number {
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
 * row per candidate wire model (see `modelsForEndpoint`). Targets without
 * a resolvable wire model still render a single "no-model" row so users can
 * see the target exists and why it is not selectable. Scope stars come from
 * `settings.scope`: both plain `targetId` and `targetId/wireModelId` refs
 * match so a user can pin either granularity.
 */
export function buildModelItems(deps: {
	settings: Readonly<ClioSettings>;
	providers: ProvidersContract;
}): ModelItemsResult {
	const activeEndpoint = deps.settings.orchestrator?.endpoint?.trim() ?? "";
	const activeModel = deps.settings.orchestrator?.model?.trim() ?? "";
	const activeRef = activeEndpoint && activeModel ? `${activeEndpoint}/${activeModel}` : activeEndpoint;
	const favoriteSet = new Set(deps.settings.modelSelector?.favorites ?? []);
	const recentSet = new Set(deps.settings.state?.recentModels ?? []);
	const list = [...deps.providers.list()]
		.filter((status) => {
			return status.runtime !== null && isTargetEligibleRuntime(status.runtime);
		})
		.sort((a, b) => {
			const aActive = a.endpoint.id === activeEndpoint ? 0 : 1;
			const bActive = b.endpoint.id === activeEndpoint ? 0 : 1;
			return (
				aActive - bActive ||
				statusPriority(a) - statusPriority(b) ||
				(a.runtime?.displayName ?? a.endpoint.runtime).localeCompare(b.runtime?.displayName ?? b.endpoint.runtime) ||
				a.endpoint.id.localeCompare(b.endpoint.id)
			);
		});
	const scopeSet = new Set(deps.settings.scope ?? []);
	const items: SelectItem[] = [];
	const refs: ModelSelection[] = [];
	const rows: ModelRow[] = [];
	for (const status of list) {
		const { endpoint } = status;
		const runtimeName = status.runtime?.displayName ?? endpoint.runtime;
		const runtimeShortName = shortRuntimeName(runtimeName);
		const candidates = modelCandidatesForEndpoint(status);
		const authText = authLabel({ providers: deps.providers, status });
		const bucket = modelBucket(status);
		const singleEndpoint = list.length === 1;
		if (candidates.length === 0) {
			const fallbackModel = endpoint.defaultModel?.trim() ?? "";
			const resolution =
				fallbackModel.length > 0
					? resolveOverlayRuntimeTarget({
							providers: deps.providers,
							status,
							wireModelId: fallbackModel,
							requestedThinkingLevel: deps.settings.orchestrator?.thinkingLevel,
						})
					: null;
			const rowCaps = resolution?.capabilities ?? status.capabilities;
			const decisions = resolution?.capabilityDecisions ?? fallbackCapabilityDecisions(status, rowCaps);
			const row: ModelRow = {
				value: endpoint.id,
				endpoint: endpoint.id,
				model: "",
				runtimeName,
				runtimeShortName,
				runtimeId: status.runtime?.id ?? endpoint.runtime,
				apiFamily: status.runtime?.apiFamily ?? "unknown",
				bucket,
				source: "missing",
				authText,
				available: status.available,
				reason: status.reason,
				healthGlyph: healthGlyph(status),
				healthText: healthText(status),
				caps: rowCaps,
				capabilityDecisions: decisions,
				thinking: resolution?.thinking ?? "unresolved",
				streaming: decisions.streaming,
				diagnostics: resolution?.diagnostics ?? [
					{ severity: "error", code: "model-not-configured", message: `target '${endpoint.id}' has no model configured` },
				],
				badges: capabilityBadges(rowCaps),
				context: contextDecisionLabel(decisions),
				maxTokens: maxTokensDecisionLabel(decisions),
				active: endpoint.id === activeEndpoint,
				scoped: scopeSet.has(endpoint.id),
				favorite: false,
				recent: false,
				defaultModel: false,
				visibleByDefault: endpoint.id === activeEndpoint || scopeSet.has(endpoint.id),
				selectable: false,
			};
			items.push({
				value: endpoint.id,
				label: `${row.healthGlyph}  ${runtimeName}`,
				description: `target=${endpoint.id}  auth=${authText}${status.reason ? `  ${status.reason}` : ""}`,
			});
			refs.push({ endpoint: endpoint.id, model: endpoint.defaultModel ?? "" });
			rows.push(row);
			continue;
		}
		for (const candidate of candidates) {
			const wireModel = candidate.id;
			const rowRef = `${endpoint.id}/${wireModel}`;
			const resolution = resolveOverlayRuntimeTarget({
				providers: deps.providers,
				status,
				wireModelId: wireModel,
				requestedThinkingLevel: deps.settings.orchestrator?.thinkingLevel,
			});
			const rowCaps = resolution.capabilities;
			const decisions = resolution.capabilityDecisions;
			const badges = capabilityBadges(rowCaps);
			const exactScopeHit = scopeSet.has(rowRef);
			const endpointScopeHit = scopeSet.has(endpoint.id);
			const scopeHit = exactScopeHit || endpointScopeHit;
			const active = endpoint.id === activeEndpoint && wireModel === activeModel;
			const favorite = favoriteSet.has(rowRef) || exactScopeHit;
			const recent = recentSet.has(rowRef);
			const defaultModel = wireModel === endpoint.defaultModel;
			const endpointScopedFocus = endpointScopeHit && (active || defaultModel);
			const focusPinned = singleEndpoint && candidate.source === "configured";
			const row: ModelRow = {
				value: rowRef,
				endpoint: endpoint.id,
				model: wireModel,
				runtimeName,
				runtimeShortName,
				runtimeId: status.runtime?.id ?? endpoint.runtime,
				apiFamily: status.runtime?.apiFamily ?? "unknown",
				bucket,
				source: candidate.source,
				authText,
				available: status.available,
				reason: status.reason,
				healthGlyph: healthGlyph(status),
				healthText: healthText(status),
				caps: rowCaps,
				capabilityDecisions: decisions,
				thinking: resolution.thinking,
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
				visibleByDefault: active || favorite || recent || defaultModel || endpointScopedFocus || focusPinned,
				selectable: true,
			};
			items.push({
				value: rowRef,
				label: `${row.healthGlyph}${favorite ? "★" : scopeHit ? "◇" : active ? "◆" : " "} ${wireModel}`,
				description: `${row.context}  ${badges}  ${runtimeShortName}  target=${endpoint.id}`,
			});
			refs.push({ endpoint: endpoint.id, model: wireModel });
			rows.push(row);
		}
	}
	return { items, refs, rows, summary: buildSummary(rows, list.length, activeRef) };
}

interface ModelColumns {
	modelWidth: number;
	targetWidth: number;
	runtimeWidth: number;
	showTarget: boolean;
	showRuntime: boolean;
}

function modelColumns(width: number): ModelColumns {
	const targetWidth = width >= 92 ? TARGET_COL_WIDTH_WIDE : TARGET_COL_WIDTH_NARROW;
	const runtimeWidth =
		width >= 96 ? RUNTIME_COL_WIDTH_WIDE : width >= 78 ? RUNTIME_COL_WIDTH_MEDIUM : RUNTIME_COL_WIDTH_NARROW;
	let showTarget = width >= 58;
	let showRuntime = width >= 68;
	const calcModel = (): number => {
		let fixed = SELECTED_PREFIX_WIDTH + CONTEXT_COL_WIDTH + 1 + CAPS_COL_WIDTH;
		if (showTarget) fixed += 1 + targetWidth;
		if (showRuntime) fixed += 1 + runtimeWidth;
		return width - fixed;
	};
	let modelWidth = calcModel();
	if (modelWidth < MODEL_MIN_WIDTH && showRuntime) {
		showRuntime = false;
		modelWidth = calcModel();
	}
	if (modelWidth < MODEL_MIN_WIDTH && showTarget) {
		showTarget = false;
		modelWidth = calcModel();
	}
	return {
		modelWidth: Math.max(1, modelWidth),
		targetWidth,
		runtimeWidth,
		showTarget,
		showRuntime,
	};
}

function fitCell(text: string, width: number, align: "left" | "right" = "left"): string {
	const clipped = truncateToWidth(text, width, "", true);
	const pad = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	return align === "right" ? `${pad}${clipped}` : `${clipped}${pad}`;
}

function fitLine(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "", true);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function activeMark(row: ModelRow): string {
	if (row.active) return clioTitle("◆");
	if (row.favorite) return clioFrame("★");
	if (row.recent) return clioFrame("↺");
	if (row.scoped) return clioFrame("◇");
	if (row.defaultModel) return clioFrame("d");
	return "·";
}

function formatModelHeader(width: number): string {
	const columns = modelColumns(width);
	let line =
		`${" ".repeat(SELECTED_PREFIX_WIDTH)}` +
		`${fitCell("model", columns.modelWidth)}` +
		`${fitCell("ctx", CONTEXT_COL_WIDTH, "right")} ` +
		`${fitCell("caps", CAPS_COL_WIDTH)}`;
	if (columns.showTarget) line += ` ${fitCell("target", columns.targetWidth)}`;
	if (columns.showRuntime) line += ` ${fitCell("runtime", columns.runtimeWidth)}`;
	return clioFrame(fitLine(line, width));
}

function formatModelRow(row: ModelRow, width: number, selected: boolean): string {
	const columns = modelColumns(width);
	const pointer = selected ? "→" : " ";
	const prefix = `${pointer} ${row.healthGlyph} ${activeMark(row)} `;
	const modelLabel = row.model.length > 0 ? row.model : "(no model ids)";
	let line =
		prefix +
		`${fitCell(truncateMiddle(modelLabel, columns.modelWidth), columns.modelWidth)}` +
		`${fitCell(row.context, CONTEXT_COL_WIDTH, "right")} ` +
		`${fitCell(row.badges, CAPS_COL_WIDTH)}`;
	if (columns.showTarget) line += ` ${fitCell(row.endpoint, columns.targetWidth)}`;
	if (columns.showRuntime) line += ` ${fitCell(row.runtimeShortName, columns.runtimeWidth)}`;
	line = fitLine(line, width);
	return selected ? clioTitle(line) : line;
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
		case "catalog":
			return "catalog";
		case "default":
			return "target default";
		default:
			return "no model ids";
	}
}

function formatModelDetail(row: ModelRow, width: number): string[] {
	const ref = row.model.length > 0 ? `${row.endpoint}/${row.model}` : row.endpoint;
	const tags: string[] = [];
	if (row.active) tags.push("current");
	if (row.favorite) tags.push("favorite");
	if (row.recent) tags.push("recent");
	if (row.scoped) tags.push("scoped");
	if (row.defaultModel) tags.push("default");
	const state = tags.length > 0 ? tags.join("+") : row.selectable ? "candidate" : "not selectable";
	const availability = row.available ? row.healthText : `${row.healthText}; ${row.reason || "unavailable"}`;
	return [
		fitLine(`${state} ${ref} · ${availability} · auth ${row.authText}`, width),
		fitLine(
			`source ${sourceLabel(row.source)} · ${row.runtimeName} · ${row.apiFamily} · max output ${row.maxTokens} · thinking ${row.thinking ?? "-"} · streaming ${row.streaming === false ? "no" : "yes"} · ${capabilityNames(row.caps)}`,
			width,
		),
		...(row.diagnostics ?? [])
			.filter((entry) => entry.severity !== "info")
			.slice(0, 2)
			.map((entry) => runtimeResolutionDiagnosticLine(entry, width)),
	];
}

function matchesQuery(row: ModelRow, query: string): boolean {
	const tokens = query
		.toLowerCase()
		.split(/\s+/)
		.map((token) => token.trim())
		.filter(Boolean);
	if (tokens.length === 0) return true;
	const haystack = [
		row.endpoint,
		row.model,
		row.runtimeName,
		row.runtimeShortName,
		row.runtimeId,
		row.apiFamily,
		row.bucket,
		row.source,
		row.badges,
		row.context,
		row.maxTokens,
		row.authText,
		row.healthText,
	]
		.join(" ")
		.toLowerCase();
	return tokens.every((token) => haystack.includes(token));
}

function visibleSlice<T>(
	items: ReadonlyArray<T>,
	selectedIndex: number,
	maxVisible: number,
): { start: number; rows: T[] } {
	const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible));
	return { start, rows: items.slice(start, start + maxVisible) };
}

function refreshStatusLine(
	refreshing: ModelRefreshScope | null | undefined,
	error: RuntimeResolutionDiagnostic | null | undefined,
): string | null {
	if (refreshing)
		return refreshing === "all" ? "refreshing all targets and model catalogs…" : "refreshing selected target models…";
	return error ? formatRuntimeResolutionDiagnostic(error) : null;
}

function renderModelOverlayLines(input: {
	rows: ReadonlyArray<ModelRow>;
	summary: ModelOverlaySummary;
	selectedIndex: number;
	query: string;
	width: number;
	showAll?: boolean;
	refreshing?: ModelRefreshScope | null;
	refreshError?: RuntimeResolutionDiagnostic | null;
	selectionError?: string | null;
}): string[] {
	const width = Math.max(1, input.width);
	const query = input.query.trim();
	const searching = query.length > 0;
	const allMatches = input.rows.filter((row) => matchesQuery(row, input.query));
	const focusedMatches = allMatches.filter((row) => row.visibleByDefault !== false);
	const filtered = searching || input.showAll ? allMatches : focusedMatches;
	const selectableFiltered = filtered.filter((row) => row.selectable).length;
	const selectedIndex = Math.max(0, Math.min(input.selectedIndex, Math.max(0, filtered.length - 1)));
	const selected = filtered[selectedIndex] ?? null;
	const active = input.summary.activeRef || "not configured";
	const modeLabel = searching ? `search "${query}"` : input.showAll ? "all" : "focus";
	const lines = [
		fitLine(
			`${modeLabel} · ${selectableFiltered}/${input.summary.totalModels} models · ${input.summary.targets} targets · ${input.summary.localModels} local  ${input.summary.cloudModels} cloud`,
			width,
		),
		fitLine(`current ${active} · focus shows current, favorites, recent, and target defaults`, width),
	];
	const refreshLine = refreshStatusLine(input.refreshing, input.refreshError);
	if (refreshLine) lines.push((input.refreshError ? clioError : clioFrame)(fitLine(refreshLine, width)));
	if (input.selectionError) lines.push(clioError(fitLine(input.selectionError, width)));
	lines.push(formatModelHeader(width));
	if (filtered.length === 0) {
		lines.push(
			fitLine(
				searching ? "  no models match the current filter" : "  no focused models; type to search or press Tab for all",
				width,
			),
		);
	} else {
		const { start, rows } = visibleSlice(filtered, selectedIndex, VISIBLE_ROWS);
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			if (!row) continue;
			lines.push(formatModelRow(row, width, start + i === selectedIndex));
		}
		if (filtered.length > VISIBLE_ROWS) {
			lines.push(clioFrame(fitLine(`  (${selectedIndex + 1}/${filtered.length})`, width)));
		}
	}
	lines.push("");
	if (selected) lines.push(...formatModelDetail(selected, width));
	else lines.push(fitLine("no selected model", width), "");
	return lines.map((line) => fitLine(line, width));
}

interface ModelRefreshActions {
	selected?: (endpointId: string) => Promise<ModelItemsResult>;
	all?: () => Promise<ModelItemsResult>;
	requestRender?: () => void;
}

export class ModelOverlayView implements Component {
	private selectedIndex = 0;
	private query = "";
	private showAll = false;
	private rows: ModelRow[];
	private summary: ModelOverlaySummary;
	private refreshing: ModelRefreshScope | null = null;
	private refreshError: RuntimeResolutionDiagnostic | null = null;
	private selectionError: string | null = null;
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
		const matches = this.rows.filter((row) => matchesQuery(row, this.query));
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

	private appendQuery(data: string): void {
		this.selectionError = null;
		this.query += data;
		this.selectedIndex = 0;
	}

	private deleteQueryChar(): void {
		if (this.query.length === 0) return;
		this.selectionError = null;
		this.query = this.query.slice(0, -1);
		this.selectedIndex = 0;
	}

	private clearQuery(): void {
		if (this.query.length === 0) return;
		this.selectionError = null;
		this.query = "";
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
		this.onToggleFavorite({ endpoint: row.endpoint, model: row.model }, row.favorite === true);
	}

	private async refresh(scope: ModelRefreshScope): Promise<void> {
		if (this.refreshing || this.lifecycle.signal.aborted) return;
		const signal = this.lifecycle.signal;
		const selected = this.selectedRow();
		const preferredValue = selected?.value ?? null;
		if (scope === "all" && !this.refreshActions.all) return;
		if (scope === "selected" && (!this.refreshActions.selected || !selected?.endpoint)) return;
		this.refreshing = scope;
		this.refreshError = null;
		this.selectionError = null;
		this.refreshActions.requestRender?.();
		try {
			const next =
				scope === "all"
					? await this.refreshActions.all?.()
					: await this.refreshActions.selected?.(selected?.endpoint ?? "");
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

	render(width: number): string[] {
		return renderModelOverlayLines({
			rows: this.rows,
			summary: this.summary,
			selectedIndex: this.selectedIndex,
			query: this.query,
			width,
			showAll: this.showAll,
			refreshing: this.refreshing,
			refreshError: this.refreshError,
			selectionError: this.selectionError,
		});
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.lifecycle.signal.aborted) return;
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
				this.onSelect({ endpoint: row.endpoint, model: row.model });
				this.onClose();
				return;
			}
			this.selectionError = row ? `target ${row.endpoint} has no selectable model id` : "no model is selected";
			this.refreshActions.requestRender?.();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onClose();
			return;
		}
		if (data === BACKSPACE || data === BACKSPACE_ALT) {
			this.deleteQueryChar();
			return;
		}
		if (data === CTRL_U) {
			this.clearQuery();
			return;
		}
		if (data === TAB) {
			this.toggleShowAll();
			return;
		}
		if (data === "r" && this.query.length === 0) {
			void this.refresh("selected");
			return;
		}
		if (data === "R" && this.query.length === 0) {
			void this.refresh("all");
			return;
		}
		if (data === "*" && this.query.length === 0) {
			this.toggleFavorite();
			return;
		}
		if (data.length === 1 && data >= " " && data !== "\x7f") this.appendQuery(data);
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
	const activeEndpoint = currentSettings().orchestrator?.endpoint?.trim();
	const activeModel = currentSettings().orchestrator?.model?.trim();
	const view = new ModelOverlayView(
		initial.rows,
		initial.summary,
		(ref) => deps.onSelect(ref),
		deps.onToggleFavorite ? (ref, favorite) => deps.onToggleFavorite?.(ref, favorite) : undefined,
		() => deps.onClose(),
		{
			selected: async (endpointId) => {
				await deps.providers.probeEndpoint(endpointId);
				return build({ reloadCatalog: true });
			},
			all: async () => {
				await deps.providers.probeAllLive();
				return build({ reloadCatalog: true });
			},
			requestRender: () => tui.requestRender(),
		},
	);
	if (activeEndpoint && activeModel) view.setSelectedValue(`${activeEndpoint}/${activeModel}`);
	const unsubscribeHealth = deps.bus?.on(BusChannels.ProviderHealth, () => {
		if (view.isDisposed()) return;
		view.replaceItems(build());
		tui.requestRender();
	});
	const handle = showClioOverlayFrame(tui, view, {
		anchor: "center",
		width: overlayWidth,
		title: "Models",
		footerHint: buildHint("browse", [
			{ key: "type", verb: "search" },
			{ key: "Tab", verb: "focus/all" },
			{ key: "r", verb: "refresh target" },
			{ key: "R", verb: "refresh all" },
			{ key: "*", verb: "fav" },
			{ key: "Enter", verb: "use" },
		]),
	});
	return {
		...handle,
		hide(): void {
			view.dispose();
			unsubscribeHealth?.();
			handle.hide();
		},
	};
}
