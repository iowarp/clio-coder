import type { ClioSettings } from "../../core/config.js";
import { PROVIDER_CATALOG } from "../../domains/providers/catalog.js";
import type { ProviderListEntry, ProvidersContract } from "../../domains/providers/contract.js";
import { resolveModelScope } from "../../domains/providers/resolver.js";
import {
	Box,
	type OverlayHandle,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	type TUI,
} from "../../engine/tui.js";

export const MODEL_OVERLAY_WIDTH = 78;
const VISIBLE_ROWS = 12;

const IDENTITY = (s: string): string => s;

const MODEL_THEME: SelectListTheme = {
	selectedPrefix: IDENTITY,
	selectedText: IDENTITY,
	description: IDENTITY,
	scrollInfo: IDENTITY,
	noMatch: IDENTITY,
};

export interface ModelSelection {
	providerId: string;
	modelId: string;
	endpoint?: string;
}

export interface OpenModelOverlayDeps {
	settings: Readonly<ClioSettings>;
	providers: ProvidersContract;
	onSelect: (ref: ModelSelection) => void;
	onClose: () => void;
}

function healthGlyph(entry: ProviderListEntry | undefined): string {
	if (!entry) return "·";
	switch (entry.health.status) {
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

export interface ModelItemsResult {
	items: SelectItem[];
	/** Parallel to items. onSelect of items[i] resolves to refs[i]. */
	refs: ModelSelection[];
}

/**
 * Builds the grouped model list shown in the /model overlay. Each row carries
 * three markers: health from `providers.list()`, scope ★ from
 * `settings.provider.scope`, and price/context from the catalog. Local engines
 * (llamacpp, lmstudio, ollama, openai-compat) emit one row per configured
 * endpoint that has a `defaultModel` set; endpoints without a default model are
 * skipped because the selection needs both provider and model to persist.
 */
export function buildModelItems(deps: {
	settings: Readonly<ClioSettings>;
	providers: ProvidersContract;
}): ModelItemsResult {
	const list = deps.providers.list();
	const byId = new Map(list.map((entry) => [entry.id, entry]));
	const scopeSet = new Set(
		resolveModelScope(deps.settings.provider.scope ?? []).matches.map((ref) => `${ref.providerId}::${ref.modelId}`),
	);
	const items: SelectItem[] = [];
	const refs: ModelSelection[] = [];
	for (const provider of PROVIDER_CATALOG) {
		const listEntry = byId.get(provider.id);
		const health = healthGlyph(listEntry);
		if (provider.models.length === 0) {
			const endpoints = listEntry?.endpoints ?? [];
			for (const ep of endpoints) {
				if (!ep.defaultModel) continue;
				const key = `${provider.id}::${ep.defaultModel}`;
				const scoped = scopeSet.has(key) ? "★" : " ";
				items.push({
					value: `${provider.id}/${ep.name}/${ep.defaultModel}`,
					label: `${health}${scoped} ${provider.id}/${ep.name}  ${ep.defaultModel}`,
					description: ep.probe?.ok ? `endpoint ok ${ep.url}` : `endpoint ${ep.probe?.error ?? "unprobed"}`,
				});
				refs.push({ providerId: provider.id, modelId: ep.defaultModel, endpoint: ep.name });
			}
			continue;
		}
		for (const model of provider.models) {
			const key = `${provider.id}::${model.id}`;
			const scoped = scopeSet.has(key) ? "★" : " ";
			const price =
				model.pricePer1MInput !== undefined && model.pricePer1MOutput !== undefined
					? ` $${model.pricePer1MInput}/${model.pricePer1MOutput}`
					: "";
			items.push({
				value: `${provider.id}/${model.id}`,
				label: `${health}${scoped} ${provider.id}/${model.id}`,
				description: `${Math.round(model.contextWindow / 1000)}k${price}`,
			});
			refs.push({ providerId: provider.id, modelId: model.id });
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
	const list = new SelectList(items, visible, MODEL_THEME);
	const activeProvider = deps.settings.orchestrator?.provider?.trim();
	const activeModel = deps.settings.orchestrator?.model?.trim();
	if (activeProvider && activeModel) {
		const idx = refs.findIndex((r) => r.providerId === activeProvider && r.modelId === activeModel);
		if (idx >= 0) list.setSelectedIndex(idx);
	}
	list.onSelect = (item: SelectItem): void => {
		const idx = items.findIndex((i) => i.value === item.value);
		if (idx >= 0) {
			const ref = refs[idx];
			if (ref) deps.onSelect(ref);
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
