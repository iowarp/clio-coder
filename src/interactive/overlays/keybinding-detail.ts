import { truncateToWidth } from "../../engine/tui.js";

export interface KeybindingDetailEntry {
	id: string;
	keys: string;
	action: string;
	source?: "default" | "user";
	warnings?: ReadonlyArray<string>;
}

function fitCell(text: string, width: number): string {
	if (text.length >= width) return truncateToWidth(text, width, "", true);
	return text.padEnd(width);
}

function row(label: string, value: string, width: number): string[] {
	const labelWidth = 10;
	const prefix = `${fitCell(label, labelWidth)} `;
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
	return lines.map((line) => truncateToWidth(line, width, "", true));
}

export function formatKeybindingDetailBodyLines(entry: KeybindingDetailEntry, contentWidth: number): string[] {
	const lines: string[] = [];
	lines.push(`Action    ${entry.action}`);
	lines.push(`Id        ${entry.id}`);
	lines.push(`Keys      ${entry.keys}`);
	lines.push(`Source    ${entry.source ?? "static"}`);
	lines.push("");
	for (const detail of row(
		"Change",
		"Edit settings.yaml > keybindings, then restart Clio or reopen the TUI.",
		contentWidth,
	)) {
		lines.push(detail);
	}
	if (entry.id.startsWith("clio.")) {
		const example = `${entry.id}: "alt+<key>"`;
		lines.push(`Example   ${example}`);
	}
	for (const warning of entry.warnings ?? []) {
		lines.push(`Warning   ${warning}`);
	}
	return lines;
}
