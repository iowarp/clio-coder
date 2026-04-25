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
import chalk from "chalk";
import { structuredPatch } from "diff";
import { wrapTextWithAnsi } from "../../engine/tui.js";

export interface DiffRenderInput {
	oldText: string;
	newText: string;
	filename?: string;
	/** Lines of context around each hunk. Defaults to 3. */
	context?: number;
}

const DEFAULT_FILENAME = "file";
const DEFAULT_CONTEXT = 3;
const NO_CHANGES_LINE = "  (no changes)";

function wrap(line: string, width: number): string[] {
	return wrapTextWithAnsi(line, width);
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
	if (input.oldText === input.newText) {
		return wrap(NO_CHANGES_LINE, width);
	}

	const filename = input.filename ?? DEFAULT_FILENAME;
	const context = input.context ?? DEFAULT_CONTEXT;

	const patch = structuredPatch(filename, filename, input.oldText, input.newText, undefined, undefined, { context });

	const out: string[] = [];
	out.push(...wrap(chalk.dim.white(`--- a/${filename}`), width));
	out.push(...wrap(chalk.dim.white(`+++ b/${filename}`), width));

	for (const hunk of patch.hunks) {
		const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
		out.push(...wrap(chalk.cyan(header), width));
		for (const raw of hunk.lines) {
			const marker = raw.charAt(0);
			let styled: string;
			if (marker === "-") {
				styled = chalk.red(raw);
			} else if (marker === "+") {
				styled = chalk.green(raw);
			} else {
				styled = raw;
			}
			out.push(...wrap(styled, width));
		}
	}

	return out;
}
