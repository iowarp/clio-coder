import { type OverlayHandle, type SelectItem, SelectList, type TUI } from "../../engine/tui.js";
import { DEFAULT_SELECT_THEME, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";

export const AUTH_SELECTOR_WIDTH = 84;
const VISIBLE_ROWS = 10;

export interface OpenAuthSelectorDeps {
	items: SelectItem[];
	onSelect: (value: string) => void;
	onClose: () => void;
}

export function openAuthSelectorOverlay(tui: TUI, deps: OpenAuthSelectorDeps): OverlayHandle {
	const visible = Math.min(VISIBLE_ROWS, Math.max(1, deps.items.length));
	const list = new SelectList(deps.items, visible, DEFAULT_SELECT_THEME);
	list.onSelect = (item: SelectItem): void => {
		deps.onSelect(item.value);
	};
	list.onCancel = (): void => {
		deps.onClose();
	};
	const box = new FocusBox(list);
	return showClioOverlayFrame(tui, box, {
		anchor: "center",
		width: AUTH_SELECTOR_WIDTH,
		title: "Connection",
		footerHint: "[Enter] select    [Esc] cancel",
	});
}
