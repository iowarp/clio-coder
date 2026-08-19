import { htmlTemplate } from "./template.js";
import { renderTranscriptHtml } from "./tool-renderer.js";

export const MAX_HTML_EXPORT_BYTES = 2 * 1024 * 1024;
const TEMPLATE_RESERVE_BYTES = 8 * 1024;

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
	}
	const html = htmlTemplate({
		sessionId: input.sessionId,
		exportedAt: input.exportedAt,
		transcriptHtml: renderTranscriptHtml(selected),
		truncated,
	});
	if (Buffer.byteLength(html, "utf8") > maxBytes) {
		throw new Error(`HTML export exceeded its ${maxBytes}-byte size limit`);
	}
	return html;
}

export { ansiLinesToHtml, ansiToHtml } from "./ansi-to-html.js";
export { renderTranscriptHtml } from "./tool-renderer.js";
