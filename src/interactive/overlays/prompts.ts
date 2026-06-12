import type { OverlayHandle, TUI } from "../../engine/tui.js";
import type { SlashCommandContext } from "../slash-commands.js";
import { type ListOverlayItem, openListOverlay } from "./list-overlay.js";

export function openPromptsOverlay(tui: TUI, ctx: SlashCommandContext, onClose: () => void): OverlayHandle {
	const promptsList = ctx.listPrompts();
	const items: ListOverlayItem[] = promptsList.items.map((template) => {
		const usage = `/${template.name}${template.argumentHint ? ` ${template.argumentHint}` : ""}`;
		const label = `${usage.padEnd(28)}${template.description}`;
		const item: ListOverlayItem = {
			id: template.name,
			label,
			group: "Prompt Templates",
			detail: () => {
				const lines = [`# Prompt Template: /${template.name}`, `**Description:** ${template.description}`];
				if (template.argumentHint) {
					lines.push(`**Argument Hint:** \`${template.argumentHint}\``);
				}
				return lines;
			},
		};
		if (template.argumentHint) {
			item.meta = template.argumentHint;
		}
		return item;
	});

	const diagnosticItems: ListOverlayItem[] = promptsList.diagnostics.map((diag, idx) => {
		const item: ListOverlayItem = {
			id: `diag-${idx}`,
			label: `Diagnostic: ${diag.type}: ${diag.message}`,
			group: "Diagnostics",
			detail: () => [
				`# Diagnostic`,
				`**Severity:** ${diag.type}`,
				`**Message:** ${diag.message}`,
				`**File:** ${diag.path ?? "unknown"}`,
			],
		};
		if (diag.path) {
			item.meta = diag.path;
		}
		return item;
	});

	const allItems = [...items, ...diagnosticItems];

	return openListOverlay(tui, {
		title: "Prompt Templates",
		mode: "commit",
		items: allItems,
		filterable: true,
		emptyMessage: "No prompt templates found",
		onSelect: (item) => {
			if (item.group !== "Diagnostics") {
				ctx.setEditorText?.(`/${item.id} `);
			}
			onClose();
		},
		onClose,
	});
}
