import type { ClioSettings } from "../../core/config.js";
import { PROVIDER_CATALOG } from "../../domains/providers/catalog.js";
import { resolveModelScope } from "../../domains/providers/resolver.js";
import {
	Box,
	type OverlayHandle,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	type TUI,
} from "../../engine/tui.js";

export const SCOPED_OVERLAY_WIDTH = 72;
const VISIBLE_ROWS = 12;

const IDENTITY = (s: string): string => s;

const SCOPED_THEME: SelectListTheme = {
	selectedPrefix: IDENTITY,
	selectedText: IDENTITY,
	description: IDENTITY,
	scrollInfo: IDENTITY,
	noMatch: IDENTITY,
};

/**
 * Builds one SelectItem per static catalog (provider, model) pair. Local-engine
 * rows are intentionally omitted; patterns for local engines must be typed
 * manually in settings.yaml because endpoints are user-configured.
 */
export function buildScopedModelItems(currentScope: ReadonlyArray<string>): SelectItem[] {
	const activeResolved = new Set(
		resolveModelScope(currentScope).matches.map((ref) => `${ref.providerId}::${ref.modelId}`),
	);
	const items: SelectItem[] = [];
	for (const provider of PROVIDER_CATALOG) {
		for (const model of provider.models) {
			const key = `${provider.id}::${model.id}`;
			const selected = activeResolved.has(key);
			items.push({
				value: `${provider.id}/${model.id}`,
				label: `${selected ? "[x]" : "[ ]"} ${provider.id}/${model.id}`,
				description: model.thinkingCapable ? "thinking" : "",
			});
		}
	}
	return items;
}

export interface OpenScopedOverlayDeps {
	currentScope: ReadonlyArray<string>;
	onCommit: (nextScope: string[]) => void;
	onClose: () => void;
}

/**
 * pi-tui's SelectList exposes selectedIndex privately; we intercept handleInput
 * to own the multi-select toggle without reaching into the private API.
 */
class ScopedOverlayBox extends Box {
	constructor(
		private readonly list: SelectList,
		private readonly items: SelectItem[],
		private readonly selected: Set<string>,
		private readonly deps: OpenScopedOverlayDeps,
	) {
		super(1, 0);
	}

	private rebuildLabels(): void {
		for (const item of this.items) {
			const sel = this.selected.has(item.value);
			const rest = item.value;
			item.label = `${sel ? "[x]" : "[ ]"} ${rest}`;
		}
	}

	handleInput(data: string): void {
		if (data === " ") {
			const current = this.list.getSelectedItem();
			if (!current) return;
			if (this.selected.has(current.value)) this.selected.delete(current.value);
			else this.selected.add(current.value);
			this.rebuildLabels();
			this.list.invalidate();
			return;
		}
		if (data === "\r") {
			const next = this.items.filter((i) => this.selected.has(i.value)).map((i) => i.value);
			this.deps.onCommit(next);
			this.deps.onClose();
			return;
		}
		this.list.handleInput(data);
	}
}

export function openScopedOverlay(tui: TUI, deps: OpenScopedOverlayDeps): OverlayHandle {
	const items = buildScopedModelItems(deps.currentScope);
	const selected = new Set(
		resolveModelScope(deps.currentScope).matches.map((ref) => `${ref.providerId}/${ref.modelId}`),
	);
	const visible = Math.min(VISIBLE_ROWS, Math.max(1, items.length));
	const list = new SelectList(items, visible, SCOPED_THEME);
	list.onCancel = (): void => {
		deps.onClose();
	};
	const box = new ScopedOverlayBox(list, items, selected, deps);
	box.addChild(list);
	return tui.showOverlay(box, { anchor: "center", width: SCOPED_OVERLAY_WIDTH });
}

export function extractScopeFromSettings(settings: Readonly<ClioSettings>): string[] {
	return [...(settings.provider.scope ?? [])];
}
