import type { ClioSettings } from "../../core/config.js";
import type { CapabilityFlags, EndpointStatus, ProvidersContract } from "../../domains/providers/index.js";
import { listKnownModelsForRuntime, resolveModelCapabilities } from "../../domains/providers/index.js";
import {
	Box,
	type OverlayHandle,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SelectListTheme,
	type TUI,
} from "../../engine/tui.js";

export const MODEL_OVERLAY_WIDTH = 82;
const VISIBLE_ROWS = 12;

const IDENTITY = (s: string): string => s;

const MODEL_THEME: SelectListTheme = {
	selectedPrefix: IDENTITY,
	selectedText: IDENTITY,
	description: IDENTITY,
	scrollInfo: IDENTITY,
	noMatch: IDENTITY,
};

const MODEL_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 40,
	maxPrimaryColumnWidth: 60,
	truncatePrimary: ({ text, maxWidth }) => truncateModelLabel(text, maxWidth),
};

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

function contextWindowLabel(caps: CapabilityFlags): string {
	if (caps.contextWindow <= 0) return "?ctx";
	return `${Math.round(caps.contextWindow / 1000)}kctx`;
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

function truncateModelLabel(text: string, maxWidth: number): string {
	if (maxWidth <= 0 || text.length <= maxWidth) return text;
	if (maxWidth <= 8) return text.slice(0, maxWidth);
	const suffixWidth = Math.min(14, Math.max(6, Math.floor(maxWidth / 3)));
	const prefixWidth = maxWidth - suffixWidth - 1;
	if (prefixWidth <= 0) return text.slice(0, maxWidth);
	return `${text.slice(0, prefixWidth)}…${text.slice(-suffixWidth)}`;
}

/**
 * Enumerate the wire model ids to present for an endpoint. The order of
 * preference below keeps the overlay predictable across live probes:
 *   1. An explicit `endpoint.wireModels` list always wins.
 *   2. Otherwise, if the probe discovered more than one model, show each.
 *   3. Otherwise fall back to `endpoint.defaultModel`, then the first
 *      discovered model, then an empty list for endpoints that have no
 *      resolvable wire model id.
 */
export function modelsForEndpoint(status: EndpointStatus): string[] {
	const wireModels = uniqueModels(status.endpoint.wireModels ?? []);
	if (wireModels.length > 0) return wireModels;
	if (status.discoveredModels.length > 0) {
		return uniqueModels([status.endpoint.defaultModel ?? "", ...status.discoveredModels]);
	}
	const knownModels = listKnownModelsForRuntime(status.runtime?.id ?? status.endpoint.runtime);
	if (knownModels.length > 0) {
		return uniqueModels([status.endpoint.defaultModel ?? "", ...knownModels]);
	}
	if (status.endpoint.defaultModel) return [status.endpoint.defaultModel];
	return [];
}

export interface ModelItemsResult {
	items: SelectItem[];
	/** Parallel to items. onSelect of items[i] resolves to refs[i]. */
	refs: ModelSelection[];
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
	const list = [...deps.providers.list()].sort((a, b) => {
		const aActive = a.endpoint.id === activeEndpoint ? 0 : 1;
		const bActive = b.endpoint.id === activeEndpoint ? 0 : 1;
		return (
			aActive - bActive ||
			(a.available === b.available ? 0 : a.available ? -1 : 1) ||
			(a.runtime?.displayName ?? a.endpoint.runtime).localeCompare(b.runtime?.displayName ?? b.endpoint.runtime) ||
			a.endpoint.id.localeCompare(b.endpoint.id)
		);
	});
	const scopeSet = new Set(deps.settings.scope ?? []);
	const items: SelectItem[] = [];
	const refs: ModelSelection[] = [];
	for (const status of list) {
		const { endpoint } = status;
		const runtimeName = status.runtime?.displayName ?? endpoint.runtime;
		const wireModels = modelsForEndpoint(status);
		const authText = status.runtime
			? (() => {
					const auth = deps.providers.auth.statusForTarget(
						status.endpoint,
						status.runtime as NonNullable<typeof status.runtime>,
					);
					if (!auth.available) return "disconnected";
					if (auth.source === "environment") return auth.detail ? `env:${auth.detail}` : "environment";
					return auth.source;
				})()
			: "unknown";
		if (wireModels.length === 0) {
			items.push({
				value: endpoint.id,
				label: `${healthGlyph(status)}  ${runtimeName}`,
				description: `endpoint=${endpoint.id}  auth=${authText}  ${status.reason}`,
			});
			refs.push({ endpoint: endpoint.id, model: endpoint.defaultModel ?? "" });
			continue;
		}
		for (const wireModel of wireModels) {
			const rowCaps = resolveModelCapabilities(status, wireModel, deps.providers.knowledgeBase);
			const badges = capabilityBadges(rowCaps);
			const scopeHit = scopeSet.has(endpoint.id) || scopeSet.has(`${endpoint.id}/${wireModel}`);
			const scopedMark = scopeHit ? "★" : " ";
			const stateText = status.available ? "" : `  ${status.reason}`;
			items.push({
				value: `${endpoint.id}/${wireModel}`,
				label: `${healthGlyph(status)}${scopedMark} ${wireModel}`,
				description: `${contextWindowLabel(rowCaps)}  ${badges}  ${runtimeName}  endpoint=${endpoint.id}  auth=${authText}${stateText}`,
			});
			refs.push({ endpoint: endpoint.id, model: wireModel });
		}
	}
	return { items, refs };
}

// pi-tui Box has no input handling; forward keystrokes to the SelectList
// child so Up/Down/Enter/Esc reach it while the overlay owns focus.
class ModelOverlayBox extends Box {
	constructor(private readonly list: SelectList) {
		super(1, 0);
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}
}

export function openModelOverlay(tui: TUI, deps: OpenModelOverlayDeps): OverlayHandle {
	const { items, refs } = buildModelItems({ settings: deps.settings, providers: deps.providers });
	const visible = Math.min(VISIBLE_ROWS, Math.max(1, items.length));
	const list = new SelectList(items, visible, MODEL_THEME, MODEL_LAYOUT);
	const activeEndpoint = deps.settings.orchestrator?.endpoint?.trim();
	const activeModel = deps.settings.orchestrator?.model?.trim();
	if (activeEndpoint && activeModel) {
		const idx = refs.findIndex((r) => r.endpoint === activeEndpoint && r.model === activeModel);
		if (idx >= 0) list.setSelectedIndex(idx);
	}
	list.onSelect = (item: SelectItem): void => {
		const idx = items.findIndex((i) => i.value === item.value);
		if (idx >= 0) {
			const ref = refs[idx];
			if (ref && ref.model.length > 0) deps.onSelect(ref);
		}
		deps.onClose();
	};
	list.onCancel = (): void => {
		deps.onClose();
	};
	const box = new ModelOverlayBox(list);
	box.addChild(list);
	return tui.showOverlay(box, { anchor: "center", width: MODEL_OVERLAY_WIDTH });
}
