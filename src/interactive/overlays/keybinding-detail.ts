import { truncateToWidth } from "../../engine/tui.js";
import { brandedBottomBorder, brandedContentRow, brandedTopBorder } from "../overlay-frame.js";

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
	lines.push(brandedTopBorder(" Keybinding ", contentWidth + 2));
	lines.push(brandedContentRow(pad(`Action    ${entry.action}`, contentWidth), contentWidth));
	lines.push(brandedContentRow(pad(`Id        ${entry.id}`, contentWidth), contentWidth));
	lines.push(brandedContentRow(pad(`Keys      ${entry.keys}`, contentWidth), contentWidth));
	lines.push(brandedContentRow(pad(`Source    ${entry.source ?? "static"}`, contentWidth), contentWidth));
	lines.push(brandedContentRow(pad("", contentWidth), contentWidth));
	for (const detail of row(
		"Change",
		"Edit settings.yaml > keybindings, then restart Clio or reopen the TUI.",
		contentWidth,
	)) {
		lines.push(brandedContentRow(detail, contentWidth));
	}
	if (entry.id.startsWith("clio.")) {
		const example = `${entry.id}: "alt+<key>"`;
		lines.push(brandedContentRow(pad(`Example   ${example}`, contentWidth), contentWidth));
	}
	for (const warning of entry.warnings ?? []) {
		lines.push(brandedContentRow(pad(`Warning   ${warning}`, contentWidth), contentWidth));
	}
	lines.push(brandedContentRow(pad("[Esc] close", contentWidth), contentWidth));
	lines.push(brandedBottomBorder(contentWidth + 2));
	return lines;
}
