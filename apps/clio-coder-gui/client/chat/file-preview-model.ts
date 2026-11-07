import type { FilePreview } from "../../contracts/sessions.js";

/** The most lines a preview lays out at once; a longer file shows the stretch around the named line. */
export const PREVIEW_WINDOW_LINES = 600;

export interface PreviewLine {
	readonly number: number;
	readonly text: string;
	readonly focus: boolean;
}

export interface PreviewView {
	readonly lines: readonly PreviewLine[];
	/** The line the reference named, when the preview holds it. */
	readonly focus: number | null;
	/** Plain words for whatever the view does not show: a window, a cut, a line past the end. */
	readonly notes: readonly string[];
}

const count = (n: number) => n.toLocaleString("en-US");

/** The lines to show for a reference into a file preview, centred on the line it names. */
export function previewView(
	preview: Extract<FilePreview, { status: "text" }>,
	line: number | null,
	window = PREVIEW_WINDOW_LINES,
): PreviewView {
	const all = preview.text.split("\n");
	if (all.at(-1) === "") all.pop();
	const total = all.length;
	const notes: string[] = [];
	const target = line !== null && line >= 1 && line <= total ? line : null;
	if (line !== null && target === null)
		notes.push(
			preview.truncated
				? `Line ${count(line)} is past the first ${count(total)} lines this preview reads.`
				: `The file has ${count(total)} lines, so line ${count(line)} is not in it now.`,
		);
	let start = 0;
	let end = total;
	if (total > window) {
		start = target === null ? 0 : Math.max(0, Math.min(target - 1 - Math.floor(window / 3), total - window));
		end = start + window;
		notes.push(`Showing lines ${count(start + 1)} to ${count(end)} of ${count(total)}.`);
	}
	if (preview.truncated)
		notes.push(`The file is ${count(preview.size)} bytes; the preview stops at the first ${count(total)} lines.`);
	return {
		lines: all.slice(start, end).map((text, index) => ({
			number: start + index + 1,
			text,
			focus: start + index + 1 === target,
		})),
		focus: target,
		notes,
	};
}
