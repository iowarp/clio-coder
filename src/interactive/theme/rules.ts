import { truncateToWidth, visibleWidth } from "../../engine/tui.js";
import type { ClioTheme } from "./tokens.js";

function padAnsi(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width), "", true);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

export interface RuleOptions {
	left?: string;
	right?: string;
}

export function rule(theme: ClioTheme, width: number, options: RuleOptions = {}): string {
	const safeWidth = Math.max(0, width);
	if (safeWidth === 0) return "";
	const left = options.left ? ` ${theme.style("accent", options.left, { bold: true })} ` : "";
	const right = options.right ? ` ${theme.fg("muted", options.right)} ` : "";
	const labelsWidth = visibleWidth(left) + visibleWidth(right);
	if (labelsWidth >= safeWidth) return truncateToWidth(`${left}${right}`.trim(), safeWidth, "", true);
	const fill = theme.fg("frame", "─".repeat(safeWidth - labelsWidth));
	return `${left}${fill}${right}`;
}

export function frame(theme: ClioTheme, title: string, lines: readonly string[], width: number): string[] {
	const safeWidth = Math.max(4, width);
	const contentWidth = Math.max(0, safeWidth - 4);
	const label = title.length > 0 ? `─ ${theme.style("title", title, { bold: true })} ` : "─ ";
	const topFill = Math.max(0, safeWidth - 2 - visibleWidth(label));
	const top = `${theme.fg("frame", "┌")}${label}${theme.fg("frame", "─".repeat(topFill))}${theme.fg("frame", "┐")}`;
	const body = lines.map((line) => `${theme.fg("frame", "│")} ${padAnsi(line, contentWidth)} ${theme.fg("frame", "│")}`);
	const bottom = `${theme.fg("frame", "└")}${theme.fg("frame", "─".repeat(safeWidth - 2))}${theme.fg("frame", "┘")}`;
	return [top, ...body, bottom];
}
