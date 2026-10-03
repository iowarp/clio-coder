import type { FileHandle } from "node:fs/promises";
import { splitLinesForCounting, truncateHead, truncateTail } from "../truncate.js";
import { truncateUtf8 } from "../truncate-utf8.js";
import { renderTar, renderZip } from "./archive.js";
import { renderNotebook } from "./notebook.js";
import { renderPdf } from "./pdf.js";
import type { DocumentRequest, Rendered } from "./shared.js";

export type { DocumentRequest } from "./shared.js";

/**
 * Document renderers for `read`: Jupyter notebooks, PDF text through poppler,
 * and zip or tar archives. Loaded on first use so the read chunk never carries
 * them. Each renderer turns its file into bounded text, and `windowDocument`
 * applies read's offset, limit, tail, and line_numbers to that text, so a
 * notebook or a PDF pages exactly like a source file. Nothing is extracted to
 * disk: archive members are inflated in memory up to RENDER_CAP_BYTES.
 */

export type DocumentKind = "notebook" | "pdf" | "zip" | "tar" | "gzip";

export interface DocumentView {
	output: string;
	shownCount: number;
	totalCount: number;
	totalBytes: number;
	truncated: boolean;
	next?: string;
}

/** A rendered line longer than this is cut, so one minified line never hides the rest of a window. */
const LINE_CAP_BYTES = 8 * 1024;

/** Apply read's line window to rendered text, with the same continuation hints. */
export function windowDocument(text: string, request: DocumentRequest, cap: number): DocumentView | { error: string } {
	const lines = splitLinesForCounting(text).map((line) =>
		Buffer.byteLength(line) > LINE_CAP_BYTES ? truncateUtf8(line, LINE_CAP_BYTES, " [line cut]") : line,
	);
	const total = lines.length;
	const label = (index: number, line: string): string => (request.numbered ? `${index + 1} | ${line}` : line);
	if (request.tail !== null) {
		const start = Math.max(0, total - request.tail);
		const truncation = truncateTail(
			lines
				.slice(start)
				.map((line, index) => label(start + index, line))
				.join("\n"),
			{ maxBytes: cap },
		);
		const shown = truncation.outputLines;
		const truncated = start > 0 || truncation.truncated;
		const firstShown = total - shown + 1;
		return {
			output: truncation.content,
			shownCount: shown,
			totalCount: total,
			totalBytes: Buffer.byteLength(text),
			truncated,
			...(truncated && shown > 0 && firstShown > 1
				? {
						next: `offset=${Math.max(1, firstShown - shown)} limit=${shown}${request.numbered ? " line_numbers=true" : ""}`,
					}
				: {}),
		};
	}
	const start = request.offset - 1;
	if (start > 0 && start >= total) {
		return { error: `offset ${request.offset} is past the end of the rendered document (${total} lines)` };
	}
	const end = request.limit === null ? total : Math.min(total, start + request.limit);
	const truncation = truncateHead(
		lines
			.slice(start, end)
			.map((line, index) => label(start + index, line))
			.join("\n"),
		{ maxBytes: cap },
	);
	const shown = truncation.outputLines;
	const moreAfter = start + shown < total;
	return {
		output: truncation.content,
		shownCount: shown,
		totalCount: total,
		totalBytes: Buffer.byteLength(text),
		truncated: moreAfter,
		...(moreAfter ? { next: `offset=${start + shown + 1}${request.numbered ? " line_numbers=true" : ""}` } : {}),
	};
}

export async function renderDocument(
	kind: DocumentKind,
	filePath: string,
	handle: FileHandle,
	size: number,
	request: DocumentRequest,
): Promise<Rendered> {
	if (request.pages !== undefined && kind !== "pdf") return { error: "pages applies to a PDF" };
	if (request.member !== undefined && kind !== "zip" && kind !== "tar" && kind !== "gzip") {
		return { error: "member applies to a zip or tar archive" };
	}
	switch (kind) {
		case "notebook":
			return await renderNotebook(handle, size);
		case "pdf":
			return await renderPdf(filePath, request);
		case "zip":
			return await renderZip(filePath, handle, size, request);
		case "tar":
		case "gzip":
			return await renderTar(filePath, kind === "gzip", request);
	}
}
