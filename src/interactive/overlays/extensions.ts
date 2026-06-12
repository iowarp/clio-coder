import type { OverlayHandle, TUI } from "../../engine/tui.js";
import type { SlashCommandContext } from "../slash-commands.js";
import { clioTheme } from "../theme/index.js";
import { type ListOverlayItem, openListOverlay } from "./list-overlay.js";

export function openExtensionsOverlay(tui: TUI, ctx: SlashCommandContext, onClose: () => void): OverlayHandle {
	const list = ctx.listExtensions?.() ?? [];
	const items: ListOverlayItem[] = list.map((ext) => {
		const state = !ext.enabled ? "disabled" : ext.effective ? "active" : `shadowed:${ext.overriddenBy ?? "higher"}`;

		let meta = state;
		if (state === "active") {
			meta = clioTheme().fg("success", "active");
		} else if (state === "disabled") {
			meta = clioTheme().fg("dim", "disabled");
		} else {
			meta = clioTheme().fg("warning", state);
		}

		const label = `${ext.id.padEnd(22)} ${ext.scope.padEnd(7)} ${ext.description}`;

		return {
			id: ext.id,
			label,
			meta,
			group: "Extensions",
			detail: () => {
				const lines = [
					`# Extension: ${ext.id}`,
					`**Version:** ${ext.version}`,
					`**Scope:** ${ext.scope}`,
					`**Description:** ${ext.description}`,
					`**State:** ${state}`,
				];
				if (ext.overriddenBy) {
					lines.push(`**Overridden By:** ${ext.overriddenBy}`);
				}
				return lines;
			},
		};
	});

	return openListOverlay(tui, {
		title: "Extensions Reference",
		mode: "browse",
		items,
		filterable: true,
		emptyMessage: "No extensions found",
		onClose,
	});
}
