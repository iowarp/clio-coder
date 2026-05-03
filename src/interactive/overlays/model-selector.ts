import type { ClioSettings } from "../../core/config.js";
import type { CapabilityFlags, EndpointStatus, ProvidersContract } from "../../domains/providers/index.js";
import { listKnownModelsForRuntime, resolveModelCapabilities } from "../../domains/providers/index.js";
import {
	type Component,
	getKeybindings,
	type OverlayHandle,
	type SelectItem,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "../../engine/tui.js";
import { clioFrame, clioTitle, showClioOverlayFrame } from "../overlay-frame.js";

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
const ENTER = "\r";
const ENTER_LF = "\n";

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
	providers: ProvidersContract;
	onSelect: (ref: ModelSelection) => void;
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

export function capabilityBadges(caps: CapabilityFlags): string {
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

function contextWindowLabel(caps: CapabilityFlags): string {
	return `${compactTokenCount(caps.contextWindow)}ctx`;
}

function maxTokensLabel(caps: CapabilityFlags): string {
	return compactTokenCount(caps.maxTokens);
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
type ModelBucket = "local" | "cloud" | "cli";

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
	badges: string;
	context: string;
	maxTokens: string;
	active: boolean;
	scoped: boolean;
	selectable: boolean;
}

export interface ModelOverlaySummary {
	totalModels: number;
	targets: number;
	localModels: number;
	cloudModels: number;
	cliModels: number;
	activeRef: string;
}

/**
 * Enumerate the wire model ids to present for an endpoint. The order of
 * preference below keeps the overlay predictable across live probes:
 *   1. An explicit `endpoint.wireModels` list always wins.
 *   2. Otherwise, if the probe discovered models, show each.
 *   3. Otherwise fall back to `endpoint.defaultModel`, then the first
 *      discovered model, then an empty list for endpoints that have no
 *      resolvable wire model id.
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
	const wireModels = uniqueModels(status.endpoint.wireModels ?? []);
	if (wireModels.length > 0) return wireModels.map((id) => ({ id, source: "configured" }));
	if (status.discoveredModels.length > 0) {
		const discovered = uniqueModels(status.discoveredModels);
		const discoveredSet = new Set(discovered);
		return uniqueModels([status.endpoint.defaultModel ?? "", ...discovered]).map((id) => ({
			id,
			source: discoveredSet.has(id) ? "live" : "default",
		}));
	}
	const knownModels = listKnownModelsForRuntime(status.runtime?.id ?? status.endpoint.runtime);
	if (knownModels.length > 0) {
		const knownSet = new Set(knownModels);
		return uniqueModels([status.endpoint.defaultModel ?? "", ...knownModels]).map((id) => ({
			id,
			source: knownSet.has(id) ? "catalog" : "default",
		}));
	}
	if (status.endpoint.defaultModel) return [{ id: status.endpoint.defaultModel, source: "default" }];
	return [];
}

function modelBucket(status: EndpointStatus): ModelBucket {
	const tier = status.runtime?.tier;
	if (
		tier === "cli" ||
		tier === "cli-gold" ||
		tier === "cli-silver" ||
		tier === "cli-bronze" ||
		status.runtime?.kind === "subprocess"
	) {
		return "cli";
	}
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
	let cliModels = 0;
	for (const row of rows) {
		if (!row.selectable) continue;
		if (row.bucket === "local") localModels++;
		else if (row.bucket === "cli") cliModels++;
		else cloudModels++;
	}
	return {
		totalModels: localModels + cloudModels + cliModels,
		targets,
		localModels,
		cloudModels,
		cliModels,
		activeRef,
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
	const list = [...deps.providers.list()].sort((a, b) => {
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
		if (candidates.length === 0) {
			const rowCaps = status.capabilities;
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
				badges: capabilityBadges(rowCaps),
				context: contextWindowLabel(rowCaps),
				maxTokens: maxTokensLabel(rowCaps),
				active: endpoint.id === activeEndpoint,
				scoped: scopeSet.has(endpoint.id),
				selectable: false,
			};
			items.push({
				value: endpoint.id,
				label: `${row.healthGlyph}  ${runtimeName}`,
				description: `endpoint=${endpoint.id}  auth=${authText}${status.reason ? `  ${status.reason}` : ""}`,
			});
			refs.push({ endpoint: endpoint.id, model: endpoint.defaultModel ?? "" });
			rows.push(row);
			continue;
		}
		for (const candidate of candidates) {
			const wireModel = candidate.id;
			const detectedReasoning = deps.providers.getDetectedReasoning(endpoint.id, wireModel);
			const rowCaps = resolveModelCapabilities(status, wireModel, deps.providers.knowledgeBase, {
				detectedReasoning,
			});
			const badges = capabilityBadges(rowCaps);
			const scopeHit = scopeSet.has(endpoint.id) || scopeSet.has(`${endpoint.id}/${wireModel}`);
			const active = endpoint.id === activeEndpoint && wireModel === activeModel;
			const row: ModelRow = {
				value: `${endpoint.id}/${wireModel}`,
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
				badges,
				context: contextWindowLabel(rowCaps),
				maxTokens: maxTokensLabel(rowCaps),
				active,
				scoped: scopeHit,
				selectable: true,
			};
			items.push({
				value: `${endpoint.id}/${wireModel}`,
				label: `${row.healthGlyph}${scopeHit ? "★" : active ? "◆" : " "} ${wireModel}`,
				description: `${row.context}  ${badges}  ${runtimeShortName}  endpoint=${endpoint.id}`,
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
	if (row.scoped) return clioFrame("★");
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

export function formatModelRow(row: ModelRow, width: number, selected: boolean): string {
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
	const state = row.active ? "current" : row.scoped ? "in scope" : row.selectable ? "candidate" : "not selectable";
	const availability = row.available ? row.healthText : `${row.healthText}; ${row.reason || "unavailable"}`;
	return [
		fitLine(`${state} ${ref} · ${availability} · auth ${row.authText}`, width),
		fitLine(
			`source ${sourceLabel(row.source)} · ${row.runtimeName} · ${row.apiFamily} · max output ${row.maxTokens} · ${capabilityNames(row.caps)}`,
			width,
		),
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

export function renderModelOverlayLines(input: {
	rows: ReadonlyArray<ModelRow>;
	summary: ModelOverlaySummary;
	selectedIndex: number;
	query: string;
	width: number;
}): string[] {
	const width = Math.max(1, input.width);
	const filtered = input.rows.filter((row) => matchesQuery(row, input.query));
	const selectedIndex = Math.max(0, Math.min(input.selectedIndex, Math.max(0, filtered.length - 1)));
	const selected = filtered[selectedIndex] ?? null;
	const active = input.summary.activeRef || "not configured";
	const queryLabel = input.query.trim().length > 0 ? `filter "${input.query.trim()}" · ${filtered.length}/` : "";
	const lines = [
		fitLine(
			`${queryLabel}${input.summary.totalModels} models · ${input.summary.targets} targets · ${input.summary.localModels} local  ${input.summary.cloudModels} cloud  ${input.summary.cliModels} cli`,
			width,
		),
		fitLine(`current ${active}`, width),
		formatModelHeader(width),
	];
	if (filtered.length === 0) {
		lines.push(fitLine("  no models match the current filter", width));
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
	lines.push(clioFrame(fitLine("[type] filter  [Up/Down] select  [Enter] use  [Esc] close", width)));
	return lines.map((line) => fitLine(line, width));
}

class ModelOverlayView implements Component {
	private selectedIndex = 0;
	private query = "";

	constructor(
		private readonly rows: ReadonlyArray<ModelRow>,
		private readonly summary: ModelOverlaySummary,
		private readonly onSelect: (ref: ModelSelection) => void,
		private readonly onClose: () => void,
	) {}

	setSelectedIndex(index: number): void {
		const filtered = this.filteredRows();
		this.selectedIndex = Math.max(0, Math.min(index, Math.max(0, filtered.length - 1)));
	}

	private filteredRows(): ModelRow[] {
		return this.rows.filter((row) => matchesQuery(row, this.query));
	}

	private selectedRow(): ModelRow | null {
		return this.filteredRows()[this.selectedIndex] ?? null;
	}

	private move(delta: number): void {
		const count = this.filteredRows().length;
		if (count === 0) {
			this.selectedIndex = 0;
			return;
		}
		this.selectedIndex = (this.selectedIndex + delta + count) % count;
	}

	private appendQuery(data: string): void {
		this.query += data;
		this.selectedIndex = 0;
	}

	private deleteQueryChar(): void {
		if (this.query.length === 0) return;
		this.query = this.query.slice(0, -1);
		this.selectedIndex = 0;
	}

	private clearQuery(): void {
		if (this.query.length === 0) return;
		this.query = "";
		this.selectedIndex = 0;
	}

	render(width: number): string[] {
		return renderModelOverlayLines({
			rows: this.rows,
			summary: this.summary,
			selectedIndex: this.selectedIndex,
			query: this.query,
			width,
		});
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || data === ENTER || data === ENTER_LF) {
			const row = this.selectedRow();
			if (row?.selectable) this.onSelect({ endpoint: row.endpoint, model: row.model });
			this.onClose();
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
		if (data.length === 1 && data >= " " && data !== "\x7f") this.appendQuery(data);
	}
}

export function openModelOverlay(tui: TUI, deps: OpenModelOverlayDeps): OverlayHandle {
	const { rows, summary } = buildModelItems({ settings: deps.settings, providers: deps.providers });
	const overlayWidth = resolveOverlayWidth(tui.terminal?.columns ?? 0);
	const activeEndpoint = deps.settings.orchestrator?.endpoint?.trim();
	const activeModel = deps.settings.orchestrator?.model?.trim();
	const view = new ModelOverlayView(
		rows,
		summary,
		(ref) => deps.onSelect(ref),
		() => deps.onClose(),
	);
	if (activeEndpoint && activeModel) {
		const idx = rows.findIndex((r) => r.endpoint === activeEndpoint && r.model === activeModel);
		if (idx >= 0) view.setSelectedIndex(idx);
	}
	return showClioOverlayFrame(tui, view, { anchor: "center", width: overlayWidth, title: "Models" });
}

export const __modelSelectorTest = {
	formatModelRow,
	modelColumns,
	renderModelOverlayLines,
	resolveOverlayWidth,
	truncateMiddle,
};
