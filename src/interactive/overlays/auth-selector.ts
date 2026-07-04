import {
	type OverlayHandle,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "../../engine/tui.js";
import { buildHint, DEFAULT_SELECT_THEME, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme } from "../theme/index.js";
import { renderSelectListWithDesignCursor } from "./list-overlay.js";

export const AUTH_SELECTOR_WIDTH = 84;
const VISIBLE_ROWS = 10;
const ELLIPSIS = "…";

export interface OpenAuthSelectorDeps {
	items: SelectItem[];
	onSelect: (value: string) => void;
	onClose: () => void;
}

function singleLine(text: string): string {
	return text.replace(/[\r\n]+/g, " ").trim();
}

function buildSelectPresentation(items: ReadonlyArray<SelectItem>): {
	items: SelectItem[];
	layout: SelectListLayoutOptions;
} {
	const descriptions = new Map(items.map((item) => [item.value, singleLine(item.description ?? "")]));
	return {
		items: items.map((item) => ({ value: item.value, label: item.label })),
		layout: {
			minPrimaryColumnWidth: 24,
			maxPrimaryColumnWidth: 38,
			truncatePrimary: ({ text, maxWidth, item, isSelected }) => {
				const label = singleLine(text);
				const description = descriptions.get(item.value) ?? "";
				if (description.length === 0 || maxWidth < 32) {
					return truncateToWidth(label, maxWidth, ELLIPSIS, true);
				}

				const theme = clioTheme();
				const preferredLabelWidth = Math.max(24, Math.min(38, visibleWidth(label) + 2));
				const labelWidth = Math.max(1, Math.min(preferredLabelWidth, maxWidth - 12));
				const fittedLabel = truncateToWidth(label, labelWidth, ELLIPSIS, true);
				const spacing = " ".repeat(Math.max(1, labelWidth + 2 - visibleWidth(fittedLabel)));
				const descWidth = Math.max(1, maxWidth - visibleWidth(fittedLabel) - visibleWidth(spacing));
				const fittedDescription = truncateToWidth(description, descWidth, ELLIPSIS, true);
				const body = `${fittedLabel}${spacing}${fittedDescription}`;
				return isSelected ? body : `${fittedLabel}${theme.fg("muted", `${spacing}${fittedDescription}`)}`;
			},
		},
	};
}

export function openAuthSelectorOverlay(tui: TUI, deps: OpenAuthSelectorDeps): OverlayHandle {
	const visible = Math.min(VISIBLE_ROWS, Math.max(1, deps.items.length));
	const presentation = buildSelectPresentation(deps.items);
	const list = new SelectList(presentation.items, visible, DEFAULT_SELECT_THEME, presentation.layout);
	list.onSelect = (item: SelectItem): void => {
		deps.onSelect(item.value);
	};
	list.onCancel = (): void => {
		deps.onClose();
	};
	const box = new FocusBox({
		render: (width) => renderSelectListWithDesignCursor(list, width),
		handleInput: (data) => list.handleInput(data),
		invalidate: () => list.invalidate(),
	});
	return showClioOverlayFrame(tui, box, {
		anchor: "center",
		width: AUTH_SELECTOR_WIDTH,
		title: "Connect target",
		footerHint: buildHint("commit", [{ key: "Enter", verb: "select" }]),
	});
}
