/**
 * Word-level diff rendering adapted from pi-coding-agent 0.84.0's
 * `dist/modes/interactive/components/diff.js`.
 *
 * Clio's edit-diff producer already emits compact numbered rows, so this
 * component styles that durable result instead of recomputing a patch from
 * tool arguments. The plain mode is used for replay and export.
 */
import * as Diff from "diff";
import { visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { type ClioTheme, clioTheme } from "../theme/index.js";

export interface DiffRenderOptions {
	color?: boolean;
	theme?: ClioTheme;
}

interface ParsedDiffLine {
	prefix: "+" | "-" | " ";
	lineNum: string;
	content: string;
}

const ESC = String.fromCharCode(27);
const SGR_INVERSE = `${ESC}[7m`;
const SGR_INVERSE_OFF = `${ESC}[27m`;

function parseDiffLine(line: string): ParsedDiffLine | null {
	const match = /^([+\-\s])(\s*\d*)\s(.*)$/u.exec(line);
	if (!match?.[1] || match[2] === undefined || match[3] === undefined) return null;
	if (match[1] !== "+" && match[1] !== "-" && match[1] !== " ") return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

function replaceTabs(text: string): string {
	return text.replace(/\t/gu, "   ");
}

function inverse(text: string, enabled: boolean): string {
	return enabled && text.length > 0 ? `${SGR_INVERSE}${text}${SGR_INVERSE_OFF}` : text;
}

/** Changed words use inverse video inside the line's add/remove theme color. */
function renderIntraLineDiff(
	oldContent: string,
	newContent: string,
	color: boolean,
): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);
	let removedLine = "";
	let addedLine = "";
	let firstRemoved = true;
	let firstAdded = true;
	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			if (firstRemoved) {
				const leading = /^(\s*)/u.exec(value)?.[1] ?? "";
				removedLine += leading;
				value = value.slice(leading.length);
				firstRemoved = false;
			}
			removedLine += inverse(value, color);
		} else if (part.added) {
			let value = part.value;
			if (firstAdded) {
				const leading = /^(\s*)/u.exec(value)?.[1] ?? "";
				addedLine += leading;
				value = value.slice(leading.length);
				firstAdded = false;
			}
			addedLine += inverse(value, color);
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}
	return { removedLine, addedLine };
}

function styleLine(line: string, prefix: ParsedDiffLine["prefix"] | null, color: boolean, theme: ClioTheme): string {
	if (!color) return line;
	if (prefix === "-") return theme.fg("error", line);
	if (prefix === "+") return theme.fg("success", line);
	return theme.fg("dim", line);
}

/** Narrower than this, a hanging diff row would leave too little room for its content. */
const MIN_HANGING_CONTENT = 12;

/**
 * Render Clio's numbered diff string as width-bounded transcript rows. A row
 * too long for the width wraps its content under itself, past the sign and the
 * line number, so the gutter column stays the sign and number alone.
 */
export function renderDiffLines(diffText: string, width: number, options: DiffRenderOptions = {}): string[] {
	const color = options.color ?? true;
	const theme = options.theme ?? clioTheme();
	const rendered: Array<{ gutter: string; content: string; prefix: ParsedDiffLine["prefix"] | null }> = [];
	const push = (prefix: ParsedDiffLine["prefix"], lineNum: string, content: string) =>
		rendered.push({ gutter: `${prefix}${lineNum} `, content, prefix });
	const lines = diffText.split("\n");
	let index = 0;
	while (index < lines.length) {
		const line = lines[index] ?? "";
		const parsed = parseDiffLine(line);
		if (!parsed) {
			rendered.push({ gutter: "", content: line, prefix: null });
			index += 1;
			continue;
		}
		if (parsed.prefix !== "-") {
			push(parsed.prefix, parsed.lineNum, replaceTabs(parsed.content));
			index += 1;
			continue;
		}

		const removed: Array<Pick<ParsedDiffLine, "lineNum" | "content">> = [];
		while (index < lines.length) {
			const candidate = parseDiffLine(lines[index] ?? "");
			if (candidate?.prefix !== "-") break;
			removed.push(candidate);
			index += 1;
		}
		const added: Array<Pick<ParsedDiffLine, "lineNum" | "content">> = [];
		while (index < lines.length) {
			const candidate = parseDiffLine(lines[index] ?? "");
			if (candidate?.prefix !== "+") break;
			added.push(candidate);
			index += 1;
		}
		if (removed.length === 1 && added.length === 1 && removed[0] && added[0]) {
			const intra = renderIntraLineDiff(replaceTabs(removed[0].content), replaceTabs(added[0].content), color);
			push("-", removed[0].lineNum, intra.removedLine);
			push("+", added[0].lineNum, intra.addedLine);
			continue;
		}
		for (const row of removed) push("-", row.lineNum, replaceTabs(row.content));
		for (const row of added) push("+", row.lineNum, replaceTabs(row.content));
	}

	const bounded = Math.max(1, width);
	return rendered.flatMap((row) => {
		const gutterWidth = visibleWidth(row.gutter);
		if (row.prefix === null || bounded - gutterWidth < MIN_HANGING_CONTENT) {
			return wrapTextWithAnsi(styleLine(`${row.gutter}${row.content}`, row.prefix, color, theme), bounded);
		}
		const hang = " ".repeat(gutterWidth);
		return wrapTextWithAnsi(row.content, bounded - gutterWidth).map((content, part) =>
			styleLine(`${part === 0 ? row.gutter : hang}${content}`, row.prefix, color, theme),
		);
	});
}
