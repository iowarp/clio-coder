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
		// The usage already carries the argument synopsis. Repeating it in the
		// right-aligned metadata column starves the description at 60 columns, and
		// a usage longer than the alignment stop used to join directly to its first
		// word (`[description]Capture`). Two literal cells remain a separator even
		// when the command has outgrown the nominal column.
		const label = `${usage.padEnd(28)}  ${template.description}`;
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
				if (template.unavailable !== undefined) {
					lines.push(`**Unavailable:** ${template.unavailable}`);
				}
				if (!template.trusted) {
					lines.push(
						"**Untrusted:** set `integrations.projectResources.trustProjectImports` before this template will expand.",
					);
				}
				return lines;
			},
		};
		// A template that loaded in a refusing state is listed, because the
		// operator's command does exist; the marker is what says it will not run.
		const marker =
			template.unavailable !== undefined
				? clioTheme().fg("error", "unavailable")
				: template.trusted
					? undefined
					: clioTheme().fg("warning", "untrusted");
		if (marker) item.meta = marker;
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
		markerId: "prompts",
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
