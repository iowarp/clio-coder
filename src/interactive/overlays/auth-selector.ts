import {
	Box,
	type OverlayHandle,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	type TUI,
} from "../../engine/tui.js";

export const AUTH_SELECTOR_WIDTH = 84;
const VISIBLE_ROWS = 10;

const IDENTITY = (value: string): string => value;

const AUTH_SELECTOR_THEME: SelectListTheme = {
	selectedPrefix: IDENTITY,
	selectedText: IDENTITY,
	description: IDENTITY,
	scrollInfo: IDENTITY,
	noMatch: IDENTITY,
};

class AuthSelectorBox extends Box {
	constructor(private readonly list: SelectList) {
		super(1, 0);
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}
}

export interface OpenAuthSelectorDeps {
	items: SelectItem[];
	onSelect: (value: string) => void;
	onClose: () => void;
}

export function openAuthSelectorOverlay(tui: TUI, deps: OpenAuthSelectorDeps): OverlayHandle {
	const visible = Math.min(VISIBLE_ROWS, Math.max(1, deps.items.length));
	const list = new SelectList(deps.items, visible, AUTH_SELECTOR_THEME);
	list.onSelect = (item: SelectItem): void => {
		deps.onSelect(item.value);
	};
	list.onCancel = (): void => {
		deps.onClose();
	};
	const box = new AuthSelectorBox(list);
	box.addChild(list);
	return tui.showOverlay(box, { anchor: "center", width: AUTH_SELECTOR_WIDTH });
}
