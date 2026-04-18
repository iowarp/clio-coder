import type { ClioSettings } from "../../core/config.js";
import type { ProvidersContract } from "../../domains/providers/index.js";
import {
	Box,
	type OverlayHandle,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	type TUI,
} from "../../engine/tui.js";
import { modelsForEndpoint } from "./model-selector.js";

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

export interface ScopedItemsInput {
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
export function buildScopedModelItems(input: ScopedItemsInput): SelectItem[] {
	const active = new Set(input.currentScope);
	const items: SelectItem[] = [];
	for (const status of input.providers.list()) {
		const ep = status.endpoint;
		const epKey = ep.id;
		items.push({
			value: epKey,
			label: `${active.has(epKey) ? "[x]" : "[ ]"} ${epKey}`,
			description: "endpoint-level scope",
		});
		for (const wireModel of modelsForEndpoint(status)) {
			const key = `${ep.id}/${wireModel}`;
			items.push({
				value: key,
				label: `${active.has(key) ? "[x]" : "[ ]"} ${key}`,
				description: "endpoint/model scope",
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
	const items = buildScopedModelItems({ providers: deps.providers, currentScope: deps.currentScope });
	const selected = new Set<string>(deps.currentScope);
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
	return [...(settings.scope ?? [])];
}
