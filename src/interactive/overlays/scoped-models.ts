import type { ClioSettings } from "../../core/config.js";
import type { ProvidersContract } from "../../domains/providers/index.js";
import { matchesKey, type OverlayHandle, type SelectItem, SelectList, type TUI } from "../../engine/tui.js";
import { DEFAULT_SELECT_THEME, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";
import { modelsForEndpoint, resolveOverlayRuntimeTarget, runtimeCapabilitySummary } from "./model-selector.js";

export const SCOPED_OVERLAY_WIDTH = 72;
const VISIBLE_ROWS = 12;

interface ScopedItemsInput {
	providers: ProvidersContract;
	currentScope: ReadonlyArray<string>;
}

/**
 * Build the /scoped-models checklist. Each configured endpoint renders:
 *   - one `endpointId` row (endpoint-level scope, keeps `.model` on cycle)
 *   - one `endpointId/wireModelId` row per candidate wire model so users
 *     can pin a specific model inside the cycle set.
 * Rows pre-check the entries already present in `currentScope`. Globs are
 * gone; every entry is a literal string match.
 */
function buildScopedModelItems(input: ScopedItemsInput): SelectItem[] {
	const active = new Set(input.currentScope);
	const items: SelectItem[] = [];
	for (const status of input.providers.list()) {
		const ep = status.endpoint;
		const runtimeName = status.runtime?.displayName ?? ep.runtime;
		const epKey = ep.id;
		const defaultModel = ep.defaultModel?.trim();
		const endpointResolution = defaultModel
			? resolveOverlayRuntimeTarget({ providers: input.providers, status, wireModelId: defaultModel })
			: null;
		items.push({
			value: epKey,
			label: `${active.has(epKey) ? "[x]" : "[ ]"} ${runtimeName}  ${epKey}`,
			description: endpointResolution
				? `endpoint-level scope  ${runtimeCapabilitySummary(endpointResolution)}`
				: "endpoint-level scope",
		});
		for (const wireModel of modelsForEndpoint(status)) {
			const key = `${ep.id}/${wireModel}`;
			const resolved = resolveOverlayRuntimeTarget({ providers: input.providers, status, wireModelId: wireModel });
			items.push({
				value: key,
				label: `${active.has(key) ? "[x]" : "[ ]"} ${runtimeName}  ${ep.id}/${wireModel}`,
				description: resolved.diagnostics.some((entry) => entry.severity === "error")
					? (resolved.diagnostics.find((entry) => entry.severity === "error")?.message ?? "unresolved target")
					: runtimeCapabilitySummary(resolved),
			});
		}
	}
	return items;
}

export interface OpenScopedOverlayDeps {
	providers: ProvidersContract;
	currentScope: ReadonlyArray<string>;
	onCommit: (nextScope: string[]) => void;
	onClose: () => void;
}

export function openScopedOverlay(tui: TUI, deps: OpenScopedOverlayDeps): OverlayHandle {
	const items = buildScopedModelItems({ providers: deps.providers, currentScope: deps.currentScope });
	const selected = new Set<string>(deps.currentScope);
	const visible = Math.min(VISIBLE_ROWS, Math.max(1, items.length));
	const list = new SelectList(items, visible, DEFAULT_SELECT_THEME);
	list.onCancel = (): void => {
		deps.onClose();
	};
	const rebuildLabels = (): void => {
		for (const item of items) {
			const sel = selected.has(item.value);
			const rest = item.label.replace(/^\[(x| )\]\s+/, "");
			item.label = `${sel ? "[x]" : "[ ]"} ${rest}`;
		}
	};
	const box = new FocusBox(list, {
		onInput: (data) => {
			if (data === " ") {
				const current = list.getSelectedItem();
				if (!current) return;
				if (selected.has(current.value)) selected.delete(current.value);
				else selected.add(current.value);
				rebuildLabels();
				list.invalidate();
				return;
			}
			if (matchesKey(data, "enter") || data === "\n") {
				const next = items.filter((i) => selected.has(i.value)).map((i) => i.value);
				deps.onCommit(next);
				deps.onClose();
				return;
			}
			list.handleInput(data);
		},
	});
	return showClioOverlayFrame(tui, box, { anchor: "center", width: SCOPED_OVERLAY_WIDTH, title: "Scoped models" });
}

export function extractScopeFromSettings(settings: Readonly<ClioSettings>): string[] {
	return [...(settings.scope ?? [])];
}
