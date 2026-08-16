import type { OverlayHandle, TUI } from "../../engine/tui.js";
import type { SlashCommandContext } from "../slash-commands.js";
import { clioTheme, GLYPH } from "../theme/index.js";
import { type ListOverlayItem, openListOverlay } from "./list-overlay.js";

/** @internal exported for contract tests */
export const PROMPTS_EMPTY =
	"no prompt templates found. add a markdown file to .clio-coder/prompts/ in this project or prompts/ in your clio-coder config dir, and it becomes a slash command named after the file.";

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
				lines.push(`**Source:** ${template.sourceInfo.source ?? template.sourceInfo.scope}`);
				if (!template.trusted) {
					lines.push("**Untrusted:** set `skills.trustProjectCompatRoots` before this template will expand.");
				}
				return lines;
			},
		};
		const marker = template.trusted ? undefined : clioTheme().fg("warning", "untrusted");
		if (marker) item.meta = template.argumentHint ? `${template.argumentHint} · ${marker}` : marker;
		else if (template.argumentHint) item.meta = template.argumentHint;
		return item;
	});

	const diagnosticItems: ListOverlayItem[] = promptsList.diagnostics.map((diag, idx) => {
		const theme = clioTheme();
		const marker = diag.type === "error" ? theme.fg("error", GLYPH.error) : theme.fg("warning", GLYPH.warnInline);
		const item: ListOverlayItem = {
			id: `diag-${idx}`,
			label: `${marker} ${diag.message}`,
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
		items: allItems,
		filterable: true,
		emptyMessage: PROMPTS_EMPTY,
		onSelect: (item) => {
			if (item.group !== "Diagnostics") {
				ctx.setEditorText?.(`/${item.id} `);
			}
			onClose();
		},
		onClose,
	});
}
