import type { ExtensionPanel } from "../../domains/extensions/public-api.js";
import { extensionPanelText } from "../../domains/extensions/runtime-schema.js";
import {
	type Component,
	matchesKey,
	type OverlayHandle,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "../../engine/tui.js";
import { buildHint, type RowBudgetedBody, showClioOverlayFrame, windowRows } from "../overlay-frame.js";
import { clioTheme, emptyState } from "../theme/index.js";

/** Rows the panel shows while the frame has not said how many it has. */
const EXTENSION_PANEL_DEFAULT_ROWS = 12;

/** Host-owned plain-text rendering. Extension code supplies no components or input handlers. */
export class ExtensionPanelView implements Component, RowBudgetedBody {
	private offset = 0;
	private rows = 0;
	private text: string;
	constructor(
		panel: ExtensionPanel,
		private valid: () => boolean,
		private refresh: () => void,
		private close: () => void = () => {},
	) {
		this.text = extensionPanelText(panel);
	}
	setBodyRows(rows: number): void {
		this.rows = Math.max(0, Math.floor(rows));
	}
	render(width: number): string[] {
		const safe = Math.max(1, width);
		if (!this.valid())
			return emptyState(clioTheme(), "Extension panel expired.", safe, {
				remedy: "Close it and invoke the command again.",
			});
		const lines = this.text.split("\n").flatMap((line) => wrapTextWithAnsi(line, safe));
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
			title: `Extension: ${owner}`,
			footerHint: buildHint([{ key: "Up/Down", verb: "scroll" }]),
		},
	);
	return handle;
}
