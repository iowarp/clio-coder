import { truncateToWidth, visibleWidth } from "../../engine/tui.js";
import { clioTheme } from "../theme/index.js";

export interface StructuredRenderOptions {
	lineLimit?: number;
}

function fit(line: string, width: number): string {
	const safeWidth = Math.max(1, Math.floor(width));
	return visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, "", true) : line;
}

function collapseLines(lines: string[], lineLimit: number): string[] {
	if (lines.length <= lineLimit) return lines;
	const visible = Math.max(1, lineLimit - 1);
	const hidden = lines.length - visible;
	return [...lines.slice(0, visible), `... ${hidden} more lines hidden`];
}

function parseJson(value: unknown): unknown | null {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function colorJsonLine(line: string): string {
	const theme = clioTheme();
	const token =
		/("(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b|[{}:,]|\[|\])/giu;
	return line.replace(token, (part) => {
		if (/^"(?:\\.|[^"\\])*"$/u.test(part))
			return theme.fg(part.endsWith('"') && line.includes(`${part}:`) ? "accent" : "success", part);
		if (/^-?\d/u.test(part) || part === "true" || part === "false" || part === "null") return theme.fg("info", part);
		return theme.fg("dim", part);
	});
}

export function tryRenderJson(value: unknown, width: number, options: StructuredRenderOptions = {}): string[] | null {
	const parsed = parseJson(value);
	if (parsed === null) return null;
	let pretty: string;
	try {
		pretty = JSON.stringify(parsed, null, 2);
	} catch {
		return null;
	}
	const limit = Math.max(1, options.lineLimit ?? 80);
	return collapseLines(pretty.split("\n"), limit).map((line) => {
		const styled =
			line.startsWith("... ") && line.endsWith(" hidden") ? clioTheme().fg("dim", line) : colorJsonLine(line);
		return fit(styled, width);
	});
}

export function renderJson(value: unknown, width: number, options: StructuredRenderOptions = {}): string[] {
	return tryRenderJson(value, width, options) ?? [fit(String(value), width)];
}

function prettyXml(text: string): string[] {
	const tokens = text.match(/<[^>]+>|[^<]+/gu) ?? [text];
	const lines: string[] = [];
	let indent = 0;
	for (const token of tokens) {
		const trimmed = token.trim();
		if (trimmed.length === 0) continue;
		if (/^<\//u.test(trimmed)) indent = Math.max(0, indent - 1);
		lines.push(`${"  ".repeat(indent)}${trimmed}`);
		if (/^<[^!?/][^>]*[^/]>/u.test(trimmed) && !/^<[^>]+>[^<]+<\/[^>]+>$/u.test(trimmed)) indent += 1;
	}
	return lines;
}

function colorXmlLine(line: string): string {
	const theme = clioTheme();
	return line.replace(/(<\/?|>|\/>|[^<>]+)/gu, (part) => {
		if (part === "<" || part === "</" || part === ">" || part === "/>") return theme.fg("dim", part);
		if (part.startsWith("<")) return theme.fg("reason", part);
		return part.includes("=") ? theme.fg("reason", part) : theme.fg("success", part);
	});
}

export function tryRenderXml(text: string, width: number, options: StructuredRenderOptions = {}): string[] | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("<") || !trimmed.endsWith(">")) return null;
	const limit = Math.max(1, options.lineLimit ?? 80);
	return collapseLines(prettyXml(trimmed), limit).map((line) => {
		const styled = line.startsWith("... ") && line.endsWith(" hidden") ? clioTheme().fg("dim", line) : colorXmlLine(line);
		return fit(styled, width);
	});
}

export function renderXml(text: string, width: number, options: StructuredRenderOptions = {}): string[] {
	return tryRenderXml(text, width, options) ?? [fit(text, width)];
}
