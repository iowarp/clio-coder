import type { ClioSettings } from "../../core/config.js";
import {
	type ProvidersContract,
	type ThinkingLevel,
	availableThinkingLevels,
} from "../../domains/providers/index.js";
import {
	Box,
	type OverlayHandle,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	type TUI,
} from "../../engine/tui.js";

export const THINKING_OVERLAY_WIDTH = 44;

const IDENTITY = (s: string): string => s;

const THINKING_THEME: SelectListTheme = {
	selectedPrefix: IDENTITY,
	selectedText: IDENTITY,
	description: IDENTITY,
	scrollInfo: IDENTITY,
	noMatch: IDENTITY,
};

const DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "no reasoning tokens",
	minimal: "short structured plan",
	low: "brief chain-of-thought",
	medium: "standard reasoning",
	high: "deep reasoning",
	xhigh: "extended thinking (models that support it)",
};

export interface OpenThinkingOverlayDeps {
	current: ThinkingLevel;
	available: readonly ThinkingLevel[];
	onSelect: (next: ThinkingLevel) => void;
	onClose: () => void;
}

class ThinkingOverlayBox extends Box {
	constructor(private readonly list: SelectList) {
		super(1, 0);
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}
}

export function buildThinkingItems(current: ThinkingLevel, available: readonly ThinkingLevel[]): SelectItem[] {
	return available.map((lvl) => ({
		value: lvl,
		label: `${lvl === current ? "●" : " "} ${lvl}`,
		description: DESCRIPTIONS[lvl] ?? "",
	}));
}

export function openThinkingOverlay(tui: TUI, deps: OpenThinkingOverlayDeps): OverlayHandle {
	const items = buildThinkingItems(deps.current, deps.available);
	const list = new SelectList(items, deps.available.length, THINKING_THEME);
	const initialIndex = Math.max(0, deps.available.indexOf(deps.current));
	list.setSelectedIndex(initialIndex);
	list.onSelect = (item: SelectItem): void => {
		deps.onSelect(item.value as ThinkingLevel);
		deps.onClose();
	};
	list.onCancel = (): void => {
		deps.onClose();
	};
	const box = new ThinkingOverlayBox(list);
	box.addChild(list);
	return tui.showOverlay(box, { anchor: "center", width: THINKING_OVERLAY_WIDTH });
}

/** Current thinking level persisted under settings.orchestrator.thinkingLevel. */
export function readThinkingLevel(settings: Readonly<ClioSettings>): ThinkingLevel {
	return settings.orchestrator.thinkingLevel ?? "off";
}

/**
 * Thinking levels permitted for the active orchestrator endpoint. Looks up the
 * endpoint's merged `CapabilityFlags` via `providers.list()` and gates the list
 * through `availableThinkingLevels`. Unknown or unconfigured endpoints return
 * `["off"]` so the overlay degrades to a no-op single-option picker.
 */
export function resolveAvailableThinkingLevels(
	providers: ProvidersContract,
	settings: Readonly<ClioSettings>,
): ReadonlyArray<ThinkingLevel> {
	const endpointId = settings.orchestrator.endpoint?.trim();
	if (!endpointId) return ["off"];
	const status = providers.list().find((entry) => entry.endpoint.id === endpointId);
	if (!status) return ["off"];
	return availableThinkingLevels(status.capabilities);
}
