import type { ExtensionPanelV2 } from "../../domains/extensions/public-api-v2.js";
import {
	type Component,
	isKeyRelease,
	type KeyId,
	matchesKey,
	type OverlayHandle,
	type TUI,
} from "../../engine/tui.js";
import { buildHint, showClioOverlayFrame } from "../overlay-frame.js";
import { type RenderedView, renderView, type ViewTarget } from "../surfaces/view-renderer.js";
import { clioTheme, GLYPH } from "../theme/index.js";
import { skinEpoch } from "../theme/tokens.js";

interface PanelDeps {
	panel(): ExtensionPanelV2 | undefined;
	press(target: ViewTarget): Promise<void>;
	close(): void;
	refresh(): void;
}

/** The host draws and navigates data; no extension component owns overlay input. */
class ExtensionViewPanel implements Component {
	readonly keyboardScope = "browse";
	private offset = 0;
	private selected = 0;
	private rows = 16;
	private busy = false;
	private cache: { panel: ExtensionPanelV2; width: number; epoch: number; view: RenderedView } | undefined;
	private view: RenderedView = { lines: [], targets: [] };
	constructor(private readonly deps: PanelDeps) {}

	setBodyRows(rows: number): void {
		this.rows = Math.max(1, Math.min(16, rows));
	}
	render(width: number): string[] {
		const panel = this.deps.panel();
		if (!panel) {
			this.view = { lines: [], targets: [] };
			return [clioTheme().fg("annotation", "Extension panel expired. Escape closes it.")];
		}
		const inner = Math.max(1, width - 2);
		if (this.cache?.panel !== panel || this.cache.width !== inner || this.cache.epoch !== skinEpoch()) {
			const previous = this.view.targets[this.selected];
			this.view = renderView(panel.view, inner);
			this.view.targets.sort((a, b) => a.row - b.row || a.col - b.col);
			const index = previous
				? this.view.targets.findIndex(
						(target) => target.action === previous.action && target.key === previous.key && target.col === previous.col,
					)
				: -1;
			this.selected = Math.max(0, Math.min(index < 0 ? this.selected : index, this.view.targets.length - 1));
			this.cache = { panel, width: inner, epoch: skinEpoch(), view: this.view };
			this.reveal();
		}
		this.offset = Math.min(this.offset, Math.max(0, this.view.lines.length - this.rows));
		const chosen = this.view.targets[this.selected];
		return this.view.lines
			.slice(this.offset, this.offset + this.rows)
			.map(
				(line, index) =>
					`${chosen?.row === this.offset + index ? clioTheme().fg("selectedOption", GLYPH.cursor) : " "} ${line}`,
			);
	}
	private reveal(): void {
		const target = this.view.targets[this.selected];
		if (!target) return;
		if (target.row < this.offset) this.offset = target.row;
		if (target.row >= this.offset + this.rows) this.offset = target.row - this.rows + 1;
	}
	private press(target: ViewTarget): void {
		if (this.busy || !this.deps.panel()) return;
		this.busy = true;
		void this.deps.press(target).finally(() => {
			this.busy = false;
			this.deps.refresh();
		});
	}
	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.deps.close();
			return;
		}
		if (matchesKey(data, "pageDown") || matchesKey(data, "pageUp")) {
			this.offset = Math.max(
				0,
				Math.min(this.view.lines.length - this.rows, this.offset + (matchesKey(data, "pageDown") ? this.rows : -this.rows)),
			);
		} else if (
			matchesKey(data, "up") ||
			matchesKey(data, "shift+tab") ||
			matchesKey(data, "down") ||
			matchesKey(data, "tab")
		) {
			const delta = matchesKey(data, "up") || matchesKey(data, "shift+tab") ? -1 : 1;
			if (this.view.targets.length) {
				this.selected = (this.selected + delta + this.view.targets.length) % this.view.targets.length;
				this.reveal();
			} else this.offset = Math.max(0, this.offset + delta);
		} else {
			const hot = this.view.targets.find((target) => target.hotkey && matchesKey(data, target.hotkey as KeyId));
			const target = hot ?? (matchesKey(data, "enter") ? this.view.targets[this.selected] : undefined);
			if (target) this.press(target);
		}
		this.deps.refresh();
	}
	invalidate(): void {
		this.cache = undefined;
	}
}

export function openExtensionViewPanel(tui: TUI, owner: string, deps: Omit<PanelDeps, "refresh">): OverlayHandle {
	return showClioOverlayFrame(tui, new ExtensionViewPanel({ ...deps, refresh: () => tui.requestRender() }), {
		anchor: "center",
		width: 88,
		markerId: "extension-panel",
		title: () => `Extension: ${owner} · ${deps.panel()?.title ?? "expired"}`,
		footerHint: buildHint([
			{ key: "Up/Down/Tab", verb: "select" },
			{ key: "Enter", verb: "press" },
			{ key: "PgUp/PgDn", verb: "scroll" },
		]),
	});
}
