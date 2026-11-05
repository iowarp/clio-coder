import type { ExtensionPanel } from "../../domains/extensions/public-api.js";
import { extensionPlainText } from "../../domains/extensions/runtime-schema.js";
import {
	type Component,
	matchesKey,
	type OverlayHandle,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../../engine/tui.js";
import { buildHint, type RowBudgetedBody, showClioOverlayFrame, windowRows } from "../overlay-frame.js";
import { extensionOwnerLabel } from "../surfaces/owner-label.js";
import { clioTheme, emptyState } from "../theme/index.js";

/** Rows the panel shows while the frame has not said how many it has. */
const EXTENSION_PANEL_DEFAULT_ROWS = 12;

/** Pads a cell to a column width, cutting it with an ellipsis when it is wider. */
function cell(text: string, width: number): string {
	const cut = visibleWidth(text) > width ? truncateToWidth(text, width, "…") : text;
	return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

/**
 * The panel laid out for a width: the title over a rule, text as paragraphs,
 * metrics as aligned label and value pairs, and a table as aligned columns
 * under a header rule. A table too wide for the panel lists each row as its
 * labelled values instead, so no column is cut away. Text stays the plain
 * characters the extension sent; layout is the host's only addition.
 */
function extensionPanelRows(panel: ExtensionPanel, width: number): string[] {
	const safe = Math.max(1, width);
	const plain = (text: string): string => extensionPlainText(text);
	const wrap = (text: string): string[] =>
		plain(text)
			.split("\n")
			.flatMap((line) => wrapTextWithAnsi(line, safe));
	const rows: string[] = [
		...wrap(panel.title),
		"─".repeat(Math.min(safe, Math.max(1, visibleWidth(plain(panel.title))))),
	];
	for (const section of panel.sections) {
		rows.push("");
		if (section.kind === "text") {
			rows.push(...wrap(section.text));
			continue;
		}
		if (section.kind === "metrics") {
			const labelWidth = Math.min(
				Math.floor(safe / 2),
				Math.max(0, ...section.items.map((item) => visibleWidth(plain(item.label)))),
			);
			for (const item of section.items)
				rows.push(...wrapTextWithAnsi(`${cell(plain(item.label), labelWidth)}  ${plain(item.value)}`, safe));
			continue;
		}
		const columns = section.columns.map(plain);
		const body = section.rows.map((row) => columns.map((_, index) => plain(row[index] ?? "")));
		const widths = columns.map((column, index) =>
			Math.max(visibleWidth(column), ...body.map((row) => visibleWidth(row[index] ?? ""))),
		);
		const total = widths.reduce((sum, value) => sum + value, 0) + 2 * Math.max(0, widths.length - 1);
		if (total <= safe) {
			rows.push(
				columns
					.map((column, index) => cell(column, widths[index] ?? 0))
					.join("  ")
					.trimEnd(),
			);
			rows.push("─".repeat(total));
			for (const row of body)
				rows.push(
					row
						.map((value, index) => cell(value, widths[index] ?? 0))
						.join("  ")
						.trimEnd(),
				);
			continue;
		}
		for (const [index, row] of body.entries()) {
			if (index > 0) rows.push("");
			for (const [column, value] of row.entries())
				rows.push(...wrapTextWithAnsi(`${columns[column] ?? ""}: ${value}`, safe));
		}
	}
	return rows.map((line) => truncateToWidth(line, safe));
}

/** Host-owned plain-text rendering. Extension code supplies no components or input handlers. */
export class ExtensionPanelView implements Component, RowBudgetedBody {
	private offset = 0;
	private rows = 0;
	constructor(
		private panel: ExtensionPanel,
		private valid: () => boolean,
		private refresh: () => void,
		private close: () => void = () => {},
	) {}
	setBodyRows(rows: number): void {
		this.rows = Math.max(0, Math.floor(rows));
	}
	render(width: number): string[] {
		const safe = Math.max(1, width);
		if (!this.valid())
			return emptyState(clioTheme(), "Extension panel expired.", safe, {
				remedy: "Close it and invoke the command again.",
			});
		const lines = extensionPanelRows(this.panel, safe);
		// Extension text is shown as the plain bytes it arrived as; the panel adds
		// no painted rows of its own, only the window the dock has room for.
		const { window, start } = windowRows(lines, this.offset, this.rows > 0 ? this.rows : EXTENSION_PANEL_DEFAULT_ROWS);
		this.offset = start;
		return window.map((line) => truncateToWidth(line, safe));
	}
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "pageDown")) this.offset += 5;
		if (matchesKey(data, "up") || matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - 5);
		this.refresh();
	}
	invalidate(): void {}
}
export function openExtensionPanel(
	tui: TUI,
	owner: string,
	panel: ExtensionPanel,
	valid: () => boolean,
	onClose?: () => void,
): OverlayHandle {
	let handle: OverlayHandle;
	handle = showClioOverlayFrame(
		tui,
		new ExtensionPanelView(
			panel,
			valid,
			() => tui.requestRender(),
			() => {
				if (onClose) onClose();
				else handle.hide();
			},
		),
		{
			anchor: "center",
			width: 88,
			markerId: "extension-panel",
			title: extensionOwnerLabel(owner),
			footerHint: buildHint([{ key: "Up/Down", verb: "scroll" }]),
		},
	);
	return handle;
}
