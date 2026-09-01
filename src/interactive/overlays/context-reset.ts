import {
	type Component,
	type OverlayHandle,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../../engine/tui.js";
import { buildHint, DEFAULT_SELECT_THEME, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";
import type { ContextClearCommandOptions } from "../slash-commands.js";
import { clioTheme } from "../theme/index.js";

export const CONTEXT_RESET_OVERLAY_WIDTH = 72;
const ELLIPSIS = "…";

export type ContextResetMutationChoice = "preserve-clio-md" | "delete-clio-md";

export interface OpenContextResetOverlayDeps {
	/** Called only for one of the two mutating choices. */
	onReset: (choice: ContextResetMutationChoice) => void;
	/** Called for both the explicit Cancel row and Esc. */
	onCancel: () => void;
}

/** Translate one confirmed chooser action into the existing context-domain contract. */
export function contextResetOptions(choice: ContextResetMutationChoice): ContextClearCommandOptions {
	return choice === "delete-clio-md" ? { all: true, confirmed: true, confirmedAll: true } : { confirmed: true };
}

/** Three intentional outcomes, ordered with the least destructive action first. */
function buildContextResetItems(): SelectItem[] {
	return [
		{
			value: "preserve-clio-md",
			label: "Preserve CLIO-CODER.md",
			description: "remove generated context and keep the project handbook",
		},
		{
			value: "delete-clio-md",
			label: "Delete CLIO-CODER.md",
			description: "remove generated context and the project handbook",
		},
		{
			value: "cancel",
			label: "Cancel",
			description: "close without changing any files",
		},
	];
}

function singleLine(text: string): string {
	return text.replace(/[\r\n]+/g, " ").trim();
}

/** Keep every choice on one terminal row even when the overlay is clamped. */
function buildSelectPresentation(items: ReadonlyArray<SelectItem>): {
	items: SelectItem[];
	layout: SelectListLayoutOptions;
} {
	const descriptions = new Map(items.map((item) => [item.value, singleLine(item.description ?? "")]));
	return {
		items: items.map((item) => ({ value: item.value, label: item.label })),
		layout: {
			minPrimaryColumnWidth: 18,
			maxPrimaryColumnWidth: 64,
			truncatePrimary: ({ text, maxWidth, item, isSelected }) => {
				const label = singleLine(text);
				const description = descriptions.get(item.value) ?? "";
				// The focused description is rendered in full below the list. Keeping
				// only its label here prevents the same explanation appearing once cut
				// and once wrapped on the same decision surface.
				if (isSelected) return truncateToWidth(label, maxWidth, ELLIPSIS, true);
				if (description.length === 0 || maxWidth < 44) {
					return truncateToWidth(label, maxWidth, ELLIPSIS, true);
				}

				const labelWidth = Math.max(1, Math.min(22, maxWidth - 14));
				const fittedLabel = truncateToWidth(label, labelWidth, ELLIPSIS, true);
				const spacing = " ".repeat(Math.max(1, labelWidth + 2 - visibleWidth(fittedLabel)));
				const descriptionWidth = Math.max(1, maxWidth - visibleWidth(fittedLabel) - visibleWidth(spacing));
				const fittedDescription = truncateToWidth(description, descriptionWidth, ELLIPSIS, true);
				return `${fittedLabel}${clioTheme().fg("muted", `${spacing}${fittedDescription}`)}`;
			},
		},
	};
}

function describedSelect(list: SelectList, choices: ReadonlyArray<SelectItem>): Component {
	return {
		render(width: number): string[] {
			const rows = list.render(width);
			const selected = list.getSelectedItem();
			const description = choices.find((choice) => choice.value === selected?.value)?.description;
			if (!description) return rows;
			const indent = "  ";
			const wrapped = wrapTextWithAnsi(
				clioTheme().fg("muted", singleLine(description)),
				Math.max(1, width - visibleWidth(indent)),
			).map((line) => `${indent}${line}`);
			return [...rows, ...wrapped];
		},
		handleInput: (data: string) => list.handleInput(data),
		invalidate: () => list.invalidate(),
	};
}

/** Open the `/context reset` choice dialog. Cancel paths never reach onReset. */
export function openContextResetOverlay(tui: TUI, deps: OpenContextResetOverlayDeps): OverlayHandle {
	const choices = buildContextResetItems();
	const presentation = buildSelectPresentation(choices);
	const list = new SelectList(presentation.items, choices.length, DEFAULT_SELECT_THEME, presentation.layout);
	list.onSelect = (item: SelectItem): void => {
		if (item.value === "preserve-clio-md" || item.value === "delete-clio-md") {
			deps.onReset(item.value);
			return;
		}
		deps.onCancel();
	};
	list.onCancel = (): void => {
		deps.onCancel();
	};

	return showClioOverlayFrame(tui, new FocusBox(describedSelect(list, choices)), {
		anchor: "center",
		width: CONTEXT_RESET_OVERLAY_WIDTH,
		markerId: "context-reset",
		title: "Reset Project Context",
		footerHint: buildHint([{ key: "Enter", verb: "select" }]),
	});
}
