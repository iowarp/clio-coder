import { htmlTemplate } from "./template.js";
import { renderTranscriptHtml, transcriptHtmlBlocks } from "./tool-renderer.js";

export const MAX_HTML_EXPORT_BYTES = 2 * 1024 * 1024;
const TEMPLATE_RESERVE_BYTES = 8 * 1024;
/** Lines or blocks converted between two hand-backs of the event loop in {@link renderSessionHtmlAsync}. */
const EXPORT_CHUNK = 256;

export interface HtmlSessionExportInput {
	sessionId: string;
	exportedAt: string;
	ansiLines: ReadonlyArray<string>;
	maxBytes?: number;
}

/**
 * Build the bounded, self-contained HTML document used by `/export`.
 * Whole rendered rows are admitted until the byte budget is full, so the
 * result never cuts an ANSI sequence, Unicode scalar, span, or tool section.
 */
export function renderSessionHtml(input: HtmlSessionExportInput): string {
	const steps = sessionHtmlSteps(input);
	for (;;) {
		const step = steps.next();
		if (step.done) return step.value;
	}
}

/**
 * {@link renderSessionHtml}, handing the event loop back every {@link EXPORT_CHUNK} lines or blocks, so `/export` of a
 * long session no longer holds the prompt for the whole conversion (TUI-10). The document is byte-for-byte the same.
 */
export async function renderSessionHtmlAsync(input: HtmlSessionExportInput): Promise<string> {
	const steps = sessionHtmlSteps(input);
	for (;;) {
		const step = steps.next();
		if (step.done) return step.value;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

/** The conversion, pausing (a `yield`) after each chunk; whoever drives it decides whether a pause yields the loop. */
function* sessionHtmlSteps(input: HtmlSessionExportInput): Generator<void, string, undefined> {
	const maxBytes = input.maxBytes ?? MAX_HTML_EXPORT_BYTES;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < TEMPLATE_RESERVE_BYTES * 2) {
		throw new Error(`HTML export size limit must be at least ${TEMPLATE_RESERVE_BYTES * 2} bytes`);
	}
	const lineBudget = maxBytes - TEMPLATE_RESERVE_BYTES;
	const selected: string[] = [];
	let renderedBytes = 0;
	let truncated = false;
	for (const line of input.ansiLines) {
		const rendered = renderTranscriptHtml([line]);
		const bytes = Buffer.byteLength(rendered, "utf8") + 1;
		if (renderedBytes + bytes > lineBudget) {
			truncated = true;
			break;
		}
		selected.push(line);
		renderedBytes += bytes;
		if (selected.length % EXPORT_CHUNK === 0) yield;
	}
	const blocks: string[] = [];
	for (const block of transcriptHtmlBlocks(selected)) {
		blocks.push(block);
		if (blocks.length % EXPORT_CHUNK === 0) yield;
	}
	const html = htmlTemplate({
		sessionId: input.sessionId,
		exportedAt: input.exportedAt,
		transcriptHtml: blocks.join("\n"),
		truncated,
	});
	if (Buffer.byteLength(html, "utf8") > maxBytes) {
		throw new Error(`HTML export exceeded its ${maxBytes}-byte size limit`);
	}
	return html;
}

export { ansiLinesToHtml, ansiToHtml } from "./ansi-to-html.js";
export { renderTranscriptHtml } from "./tool-renderer.js";
