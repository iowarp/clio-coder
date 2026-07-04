import { truncateToWidth, visibleWidth } from "../../engine/tui.js";
import { clioTheme, GLYPH } from "../theme/index.js";

export interface KeybindingDetailEntry {
	id: string;
	keys: string;
	action: string;
	source?: "default" | "user";
	warnings?: ReadonlyArray<string>;
}

const ELLIPSIS = "…";
const LABEL_WIDTH = 10;

function fitCell(text: string, width: number): string {
	const clipped = visibleWidth(text) >= width ? truncateToWidth(text, width, ELLIPSIS, true) : text;
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function fitLine(text: string, width: number): string {
	const safeWidth = Math.max(1, width);
	if (visibleWidth(text) <= safeWidth) return text;
	return truncateToWidth(text, safeWidth, ELLIPSIS, true);
}

function row(
	label: string,
	value: string,
	width: number,
	options: {
		valueStyle?: (text: string) => string;
		firstValuePrefix?: string;
	} = {},
): string[] {
	const theme = clioTheme();
	const prefix = `${fitCell(theme.fg("dim", label), LABEL_WIDTH)} `;
	const available = Math.max(8, width - visibleWidth(prefix));
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
	const valueStyle = options.valueStyle ?? ((text: string) => theme.fg("muted", text));
	return lines.map((line, index) => {
		const rawValue = line.slice(prefix.length);
		const styledPrefix = index === 0 ? (options.firstValuePrefix ?? "") : "";
		return fitLine(`${prefix}${styledPrefix}${valueStyle(rawValue)}`, width);
	});
}

export function formatKeybindingDetailBodyLines(entry: KeybindingDetailEntry, contentWidth: number): string[] {
	const theme = clioTheme();
	const lines: string[] = [];
	lines.push(...row("Action", entry.action, contentWidth));
	lines.push(...row("Id", entry.id, contentWidth));
	lines.push(
		...row("Keys", entry.keys, contentWidth, { valueStyle: (text) => theme.style("accent", text, { bold: true }) }),
	);
	lines.push(...row("Source", entry.source ?? "static", contentWidth));
	lines.push("");
	for (const detail of row(
		"Change",
		"Edit settings.yaml under keybindings, then restart Clio or reopen the TUI.",
		contentWidth,
	)) {
		lines.push(detail);
	}
	if (entry.id.startsWith("clio.")) {
		const example = `${entry.id}: "alt+<key>"`;
		lines.push(...row("Example", example, contentWidth));
	}
	for (const warning of entry.warnings ?? []) {
		lines.push(
			...row("Warning", warning, contentWidth, { firstValuePrefix: theme.fg("warning", `${GLYPH.warnInline} `) }),
		);
	}
	return lines;
}
