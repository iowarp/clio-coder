import { truncateToWidth, visibleWidth } from "../../engine/tui.js";
import { clioTheme, type Fact, factRows, GLYPH } from "../theme/index.js";

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

export function highlightJsonLine(line: string): string {
	const theme = clioTheme();
	const token =
		/("(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b|[{}:,]|\[|\])/giu;
	return line.replace(token, (part) => {
		if (/^"(?:\\.|[^"\\])*"$/u.test(part))
			return theme.fg(part.endsWith('"') && line.includes(`${part}:`) ? "syntaxKey" : "syntaxString", part);
		if (/^-?\d/u.test(part) || part === "true" || part === "false" || part === "null")
			return theme.fg("syntaxLiteral", part);
		return theme.fg("syntaxComment", part);
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
			line.startsWith("... ") && line.endsWith(" hidden") ? clioTheme().fg("toolMetadata", line) : highlightJsonLine(line);
		return fit(styled, width);
	});
}

/** Widest key column of a JSON result's fact rows; a longer key takes its own row. */
const JSON_FACT_LABEL_WIDTH = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A C0 or C1 control code point, which a terminal would act on rather than print. */
function isControl(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return code < 0x20 || (code >= 0x7f && code < 0xa0);
}

/** A scalar as one line of text: control characters and runs of whitespace read as one space. */
function scalarText(value: unknown): string {
	const text = typeof value === "string" ? value : String(value);
	return Array.from(text, (char) => (isControl(char) ? " " : char))
		.join("")
		.replace(/\s+/gu, " ")
		.trim();
}

function isScalar(value: unknown): boolean {
	return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/**
 * A value below the first level, summarized: a list of scalars as its items, any other list as its length, and an
 * object as its scalar fields with their keys (deeper values as their own summary), so no row prints raw JSON.
 */
function summarizeJsonValue(value: unknown, depth = 0): string {
	if (isScalar(value)) return scalarText(value);
	if (Array.isArray(value)) {
		if (value.length > 0 && depth === 0 && value.every(isScalar)) return value.map(scalarText).join(` ${GLYPH.dot} `);
		return String(value.length);
	}
	if (!isRecord(value)) return scalarText(value);
	const parts = Object.entries(value)
		.filter(([, field]) => field !== undefined)
		.map(
			([key, field]) =>
				`${scalarText(key)} ${depth === 0 ? summarizeJsonValue(field, 1) : isScalar(field) ? scalarText(field) : Array.isArray(field) ? field.length : GLYPH.ellipsis}`,
		);
	return parts.length === 0 ? "0" : parts.join(` ${GLYPH.dot} `);
}

/**
 * A JSON result as fact rows of its first level: one row per key (or per item of a top-level list), its value
 * summarized and cut at the row end. Null when the text is not a JSON object or list, so the caller keeps its
 * plain preview.
 */
export function jsonFactRows(text: string, width: number): string[] | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	const entries: Array<[string, unknown]> = Array.isArray(parsed)
		? parsed.map((item, index) => [String(index + 1), item])
		: isRecord(parsed)
			? Object.entries(parsed)
			: [];
	if (entries.length === 0) return null;
	const facts: Fact[] = entries.map(([key, value]) => ({
		label: scalarText(key),
		value: summarizeJsonValue(value),
		fit: "clip",
	}));
	return factRows(clioTheme(), facts, width, { labelWidth: JSON_FACT_LABEL_WIDTH, stack: "never" });
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
		if (part === "<" || part === "</" || part === ">" || part === "/>") return theme.fg("syntaxComment", part);
		if (part.startsWith("<")) return theme.fg("syntaxKeyword", part);
		return part.includes("=") ? theme.fg("syntaxKeyword", part) : theme.fg("syntaxString", part);
	});
}

export function tryRenderXml(text: string, width: number, options: StructuredRenderOptions = {}): string[] | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("<") || !trimmed.endsWith(">")) return null;
	const limit = Math.max(1, options.lineLimit ?? 80);
	return collapseLines(prettyXml(trimmed), limit).map((line) => {
		const styled =
			line.startsWith("... ") && line.endsWith(" hidden") ? clioTheme().fg("toolMetadata", line) : colorXmlLine(line);
		return fit(styled, width);
	});
}
