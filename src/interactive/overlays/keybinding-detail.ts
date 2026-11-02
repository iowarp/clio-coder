import { clioTheme, type Fact, factRows, statusChip } from "../theme/index.js";

export interface KeybindingDetailEntry {
	id: string;
	keys: string;
	action: string;
	source?: "default" | "user";
	warnings?: ReadonlyArray<string>;
}

/**
 * One key's page as two fact tables: what it is, then how to change it. The
 * label names the field once and a long value wraps under its own column,
 * which is the shared fact-table rule; a warning carries the warning glyph.
 */
export function formatKeybindingDetailBodyLines(entry: KeybindingDetailEntry, contentWidth: number): string[] {
	const theme = clioTheme();
	const identity: Fact[] = [
		{ label: "Action", value: entry.action },
		{ label: "Id", value: entry.id },
		{ label: "Keys", value: theme.style("decisionKey", entry.keys, { bold: true }) },
		{ label: "Source", value: entry.source ?? "static" },
	];
	const change: Fact[] = [
		{
			label: "Change",
			value:
				"Edit settings.yaml under interface.keybindings; changes reload live. [] disables direct and leader access; commands remain. Fixed leader suffixes do not follow direct remaps.",
		},
	];
	if (entry.id.startsWith("clio-coder.")) change.push({ label: "Example", value: `${entry.id}: "alt+<key>"` });
	for (const warning of entry.warnings ?? [])
		change.push({ label: "Warning", value: statusChip(theme, "warning", warning) });
	const options = { labelRole: "fieldName" as const, stack: "never" as const };
	return [...factRows(theme, identity, contentWidth, options), "", ...factRows(theme, change, contentWidth, options)];
}
