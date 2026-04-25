import { truncateToWidth } from "../../engine/tui.js";

export const KEYBINDING_DETAIL_OVERLAY_WIDTH = 74;

export interface KeybindingDetailEntry {
	id: string;
	keys: string;
	action: string;
	source?: "default" | "user";
	warnings?: ReadonlyArray<string>;
}

function pad(text: string, width: number): string {
	if (text.length >= width) return truncateToWidth(text, width, "", true);
	return text.padEnd(width);
}

function row(label: string, value: string, width: number): string[] {
	const labelWidth = 10;
	const prefix = `${label.padEnd(labelWidth)} `;
	const available = Math.max(8, width - prefix.length);
	const lines: string[] = [];
	const words = value.split(/\s+/g).filter(Boolean);
	let current = "";
	for (const word of words) {
		const next = current.length === 0 ? word : `${current} ${word}`;
		if (next.length <= available) {
			current = next;
			continue;
		}
		if (current.length > 0) lines.push(`${prefix}${current}`);
		current = word;
	}
	if (current.length > 0) lines.push(`${prefix}${current}`);
	if (lines.length === 0) lines.push(prefix.trimEnd());
	return lines.map((line) => pad(line, width));
}

export function formatKeybindingDetailLines(
	entry: KeybindingDetailEntry,
	contentWidth: number = KEYBINDING_DETAIL_OVERLAY_WIDTH - 4,
): string[] {
	const lines: string[] = [];
	lines.push(`┌${" Keybinding ".padEnd(contentWidth + 2, "─")}┐`);
	lines.push(`│ ${pad(`Action    ${entry.action}`, contentWidth)} │`);
	lines.push(`│ ${pad(`Id        ${entry.id}`, contentWidth)} │`);
	lines.push(`│ ${pad(`Keys      ${entry.keys}`, contentWidth)} │`);
	lines.push(`│ ${pad(`Source    ${entry.source ?? "static"}`, contentWidth)} │`);
	lines.push(`│ ${pad("", contentWidth)} │`);
	for (const detail of row(
		"Change",
		"Edit settings.yaml > keybindings, then restart Clio or reopen the TUI.",
		contentWidth,
	)) {
		lines.push(`│ ${detail} │`);
	}
	if (entry.id.startsWith("clio.")) {
		const example = `${entry.id}: "alt+<key>"`;
		lines.push(`│ ${pad(`Example   ${example}`, contentWidth)} │`);
	}
	for (const warning of entry.warnings ?? []) {
		lines.push(`│ ${pad(`Warning   ${warning}`, contentWidth)} │`);
	}
	lines.push(`│ ${pad("[Esc] close", contentWidth)} │`);
	lines.push(`└${"─".repeat(contentWidth + 2)}┘`);
	return lines;
}
