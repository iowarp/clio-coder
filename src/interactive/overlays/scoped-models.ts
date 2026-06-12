import type { ClioSettings } from "../../core/config.js";
import type { ProvidersContract } from "../../domains/providers/index.js";
import { matchesKey, type OverlayHandle, type SelectItem, SelectList, type TUI } from "../../engine/tui.js";
import { buildHint, DEFAULT_SELECT_THEME, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";
import { modelsForEndpoint, resolveOverlayRuntimeTarget, runtimeCapabilitySummary } from "./model-selector.js";

export const SCOPED_OVERLAY_WIDTH = 72;
const VISIBLE_ROWS = 12;

interface ScopedItemsInput {
	providers: ProvidersContract;
	currentScope: ReadonlyArray<string>;
}

/**
 * Build the /scoped-models checklist. Each configured endpoint renders:
 *   - one `endpointId` row (target-level scope, keeps `.model` on cycle)
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
				? `target-level scope  ${runtimeCapabilitySummary(endpointResolution)}`
				: "target-level scope",
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

export function commitScopedModelSelection(
	currentScope: ReadonlyArray<string>,
	items: ReadonlyArray<SelectItem>,
	selected: ReadonlySet<string>,
): string[] {
	const itemValues = new Set(items.map((item) => item.value));
	const visibleSelection = items.filter((item) => selected.has(item.value)).map((item) => item.value);
	const retainedUnmatched = currentScope.filter((entry) => selected.has(entry) && !itemValues.has(entry));
	return [...visibleSelection, ...retainedUnmatched];
}

export interface OpenScopedOverlayDeps {
	providers: ProvidersContract;
	currentScope: ReadonlyArray<string>;
	onCommit: (nextScope: string[]) => void;
	onClose: () => void;
	autoRefresh?: boolean;
}

export function openScopedOverlay(tui: TUI, deps: OpenScopedOverlayDeps): OverlayHandle {
	const items = buildScopedModelItems({ providers: deps.providers, currentScope: deps.currentScope });
	const selected = new Set<string>(deps.currentScope);
	let disposed = false;
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
				const next = commitScopedModelSelection(deps.currentScope, items, selected);
				deps.onCommit(next);
				deps.onClose();
				return;
			}
			list.handleInput(data);
		},
	});
	const handle = showClioOverlayFrame(tui, box, {
		anchor: "center",
		width: SCOPED_OVERLAY_WIDTH,
		title: "Scoped models",
		footerHint: buildHint("commit", [
			{ key: "Space", verb: "toggle" },
			{ key: "Enter", verb: "commit" },
		]),
	});
	if (deps.autoRefresh !== false) {
		void (async () => {
			await deps.providers.probeAllLive();
			if (disposed) return;
			const next = buildScopedModelItems({ providers: deps.providers, currentScope: [...selected] });
			items.splice(0, items.length, ...next);
			rebuildLabels();
			list.setSelectedIndex(0);
			list.invalidate();
			tui.requestRender();
		})().catch(() => {
			// Cached/configured rows remain usable when a live refresh fails.
		});
	}
	return {
		...handle,
		hide(): void {
			disposed = true;
			handle.hide();
		},
	};
}

export function extractScopeFromSettings(settings: Readonly<ClioSettings>): string[] {
	return [...(settings.scope ?? [])];
}
