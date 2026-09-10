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
import { buildHint, showClioOverlayFrame } from "../overlay-frame.js";

/** Host-owned plain-text rendering. Extension code supplies no components or input handlers. */
export class ExtensionPanelView implements Component {
	private offset = 0;
	private text: string;
	constructor(
		panel: ExtensionPanel,
		private valid: () => boolean,
		private refresh: () => void,
	) {
		this.text = extensionPanelText(panel);
	}
	render(width: number): string[] {
		if (!this.valid()) return [truncateToWidth("Extension panel expired. Close it and invoke the command again.", width)];
		const lines = this.text.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
		this.offset = Math.min(this.offset, Math.max(0, lines.length - 12));
		return lines.slice(this.offset, this.offset + 12).map((line) => truncateToWidth(line, width));
	}
	handleInput(data: string): void {
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
): OverlayHandle {
	return showClioOverlayFrame(tui, new ExtensionPanelView(panel, valid, () => tui.requestRender()), {
		anchor: "center",
		width: 88,
		markerId: "extension-panel",
		title: `Extension: ${owner}`,
		footerHint: buildHint([{ key: "Up/Down", verb: "scroll" }]),
	});
}
