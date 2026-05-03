/**
 * Pure unified-diff renderer for tool-execution result blocks (Slice B of the
 * pi-coding-agent parity work). The edit tool emits an `old_string` /
 * `new_string` pair on `args`; rather than printing the raw confirmation
 * string, the chat surfaces should show a colored unified diff so the human
 * supervisor can see exactly what bytes the tool changed.
 *
 * This module is intentionally I/O-free and free of pi-* value imports.
 * `tool-execution.ts` (the chat-panel renderer) calls `renderUnifiedDiff`
 * with the chat-pane width; the function returns ANSI-styled, width-wrapped
 * lines ready to splice into the transcript.
 */
import { structuredPatch } from "diff";
import { visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";

export interface DiffRenderInput {
	oldText: string;
	newText: string;
	filename?: string;
	/** Lines of context around each hunk. Defaults to 3. */
	context?: number;
}

// Raw ANSI escape constants. Mirrors the sibling renderer
// (`tool-execution.ts`) so the diff renderer stays free of the `chalk`
// dependency. Visible widths are computed against the un-escaped content
// because `wrapTextWithAnsi` is ANSI-aware.
const ANSI_RESET = "[0m";
const ANSI_DIM = "[2m";
const ANSI_RED = "[31m";
const ANSI_GREEN = "[32m";
const ANSI_CYAN = "[36m";

const dim = (text: string): string => `${ANSI_DIM}${text}${ANSI_RESET}`;
const red = (text: string): string => `${ANSI_RED}${text}${ANSI_RESET}`;
const green = (text: string): string => `${ANSI_GREEN}${text}${ANSI_RESET}`;
const cyan = (text: string): string => `${ANSI_CYAN}${text}${ANSI_RESET}`;

const DEFAULT_FILENAME = "file";
const DEFAULT_CONTEXT = 3;
const NO_CHANGES_LINE = "  (no changes)";

function wrap(line: string, width: number): string[] {
	return wrapTextWithAnsi(line, width);
}

function wrapWithPrefix(prefix: string, content: string, width: number, style: (text: string) => string): string[] {
	const prefixWidth = visibleWidth(prefix);
	const contentWidth = Math.max(1, width - prefixWidth);
	const continuation = " ".repeat(prefixWidth);
	const wrapped = wrapTextWithAnsi(style(content), contentWidth);
	if (wrapped.length === 0) return [style(prefix)];
	const out: string[] = [];
	for (let i = 0; i < wrapped.length; i += 1) {
		out.push(`${style(i === 0 ? prefix : continuation)}${wrapped[i] ?? ""}`);
	}
	return out;
}

function renderNumberedDiffLine(
	oldLine: number | null,
	newLine: number | null,
	marker: " " | "+" | "-",
	content: string,
	lineNumberWidth: number,
	width: number,
): string[] {
	const oldCell = oldLine === null ? " ".repeat(lineNumberWidth) : String(oldLine).padStart(lineNumberWidth);
	const newCell = newLine === null ? " ".repeat(lineNumberWidth) : String(newLine).padStart(lineNumberWidth);
	const prefix = `${oldCell} ${newCell} ${marker}`;
	if (marker === "-") return wrapWithPrefix(prefix, content, width, red);
	if (marker === "+") return wrapWithPrefix(prefix, content, width, green);
	return wrapWithPrefix(prefix, content, width, dim);
}

/**
 * Render a unified diff between `oldText` and `newText` as ANSI-styled,
 * width-wrapped lines. Pure: no I/O, no module-level state.
 *
 * Output shape:
 *   --- a/<filename>
 *   +++ b/<filename>
 *   @@ -<oldStart>,<oldLines> +<newStart>,<newLines> @@
 *   ` context line`
 *   `-removed line`
 *   `+added line`
 *
 * When the two texts are byte-identical, returns a single `(no changes)`
 * marker (no headers) so the caller renders a tight one-line block instead
 * of an empty diff.
 */
export function renderUnifiedDiff(input: DiffRenderInput, width: number): string[] {
	const safeWidth = Math.max(1, width);
	if (input.oldText === input.newText) {
		return wrap(NO_CHANGES_LINE, safeWidth);
	}

	const filename = input.filename ?? DEFAULT_FILENAME;
	const context = input.context ?? DEFAULT_CONTEXT;

	const patch = structuredPatch(filename, filename, input.oldText, input.newText, undefined, undefined, { context });

	const out: string[] = [];
	out.push(...wrap(dim(`--- a/${filename}`), safeWidth));
	out.push(...wrap(dim(`+++ b/${filename}`), safeWidth));

	for (const hunk of patch.hunks) {
		const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
		out.push(...wrap(cyan(header), safeWidth));
		let oldLine = hunk.oldStart;
		let newLine = hunk.newStart;
		const maxOld = hunk.oldStart + Math.max(0, hunk.oldLines - 1);
		const maxNew = hunk.newStart + Math.max(0, hunk.newLines - 1);
		const lineNumberWidth = Math.max(1, String(Math.max(maxOld, maxNew)).length);
		for (const raw of hunk.lines) {
			const marker = raw.charAt(0);
			if (marker === "-") {
				out.push(...renderNumberedDiffLine(oldLine, null, "-", raw.slice(1), lineNumberWidth, safeWidth));
				oldLine += 1;
			} else if (marker === "+") {
				out.push(...renderNumberedDiffLine(null, newLine, "+", raw.slice(1), lineNumberWidth, safeWidth));
				newLine += 1;
			} else if (marker === " ") {
				out.push(...renderNumberedDiffLine(oldLine, newLine, " ", raw.slice(1), lineNumberWidth, safeWidth));
				oldLine += 1;
				newLine += 1;
			} else {
				out.push(...wrap(dim(raw), safeWidth));
			}
		}
	}

	return out;
}
