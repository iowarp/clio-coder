import type { ClioSettings } from "../../core/config.js";
import { type ThinkingLevel, VALID_THINKING_LEVELS } from "../../domains/providers/resolver.js";
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
	onSelect: (next: ThinkingLevel) => void;
	onClose: () => void;
}

// pi-tui Box has no input handling; forward keystrokes to the SelectList
// child so Up/Down/Enter/Esc reach it while the overlay owns focus.
class ThinkingOverlayBox extends Box {
	constructor(private readonly list: SelectList) {
		super(1, 0);
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}
}

export function buildThinkingItems(current: ThinkingLevel): SelectItem[] {
	return VALID_THINKING_LEVELS.map((lvl) => ({
		value: lvl,
		label: `${lvl === current ? "●" : " "} ${lvl}`,
		description: DESCRIPTIONS[lvl],
	}));
}

export function openThinkingOverlay(tui: TUI, deps: OpenThinkingOverlayDeps): OverlayHandle {
	const items = buildThinkingItems(deps.current);
	const list = new SelectList(items, VALID_THINKING_LEVELS.length, THINKING_THEME);
	const initialIndex = Math.max(0, VALID_THINKING_LEVELS.indexOf(deps.current));
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

/** Pure resolver used by chat-loop + footer + settings writer. */
export function readThinkingLevel(settings: Readonly<ClioSettings>): ThinkingLevel {
	return settings.orchestrator.thinkingLevel ?? "off";
}
