import { basename, dirname } from "node:path";
import { runCommandVector } from "../../core/safe-exec.js";
import { formatSize } from "../truncate.js";
import { type DocumentRequest, RENDER_CAP_BYTES, type Rendered } from "./shared.js";

/**
 * PDF text through poppler's pdfinfo and pdftotext, run through safe-exec
 * with a timeout and an output cap. Pages render under "--- page N ---"
 * markers; without pages, the first PDF_DEFAULT_PAGES are shown and the
 * header names the next range.
 */

const PDF_TIMEOUT_MS = 60_000;

const PDF_DEFAULT_PAGES = 50;
const POPPLER_MISSING =
	"PDF text needs poppler's pdftotext and pdfinfo on PATH (install poppler-utils), or use run_script with pypdf";

function parsePages(spec: string | undefined, pageCount: number): { first: number; last: number } | { error: string } {
	if (spec === undefined) return { first: 1, last: Math.min(pageCount, PDF_DEFAULT_PAGES) };
	const match = /^\s*(\d+)\s*(?:-\s*(\d*)\s*)?$/u.exec(spec);
	if (match === null) return { error: `pages must look like "3", "3-7" or "3-"; got ${JSON.stringify(spec)}` };
	const first = Number(match[1]);
	const last = match[2] === undefined ? first : match[2] === "" ? pageCount : Number(match[2]);
	if (first < 1 || last < first || first > pageCount) {
		return { error: `pages ${spec} is outside 1-${pageCount}` };
	}
	return { first, last: Math.min(last, pageCount) };
}

export async function renderPdf(
	filePath: string,
	request: DocumentRequest,
): Promise<Rendered & { pageStarts?: Array<{ page: number; offset: number }> }> {
	const cwd = dirname(filePath);
	const exec = (file: string, args: string[]) =>
		runCommandVector(file, args, {
			cwd,
			workspaceRoot: cwd,
			timeoutMs: PDF_TIMEOUT_MS,
			maxOutputBytes: RENDER_CAP_BYTES,
			...(request.signal !== undefined ? { signal: request.signal } : {}),
		});
	const info = await exec("pdfinfo", [filePath]);
	if (info.stderr.includes("ENOENT") && info.exitCode === null) return { error: POPPLER_MISSING };
	if (info.aborted) return { error: "cancelled" };
	const pageCount = Number(/^Pages:\s+(\d+)/mu.exec(info.stdout)?.[1] ?? Number.NaN);
	if (info.exitCode !== 0 || !Number.isFinite(pageCount)) {
		return { error: `pdfinfo could not read the PDF: ${info.stderr.trim() || `exit ${info.exitCode}`}` };
	}
	const range = parsePages(request.pages, pageCount);
	if ("error" in range) return range;
	const text = await exec("pdftotext", [
		"-f",
		String(range.first),
		"-l",
		String(range.last),
		"-enc",
		"UTF-8",
		"-q",
		filePath,
		"-",
	]);
	if (text.stderr.includes("ENOENT") && text.exitCode === null) return { error: POPPLER_MISSING };
	if (text.aborted) return { error: "cancelled" };
	if (text.timedOut) return { error: `pdftotext ran past ${PDF_TIMEOUT_MS / 1000}s; pass a narrower pages range` };
	if (text.exitCode !== 0 && !text.outputCapped) {
		return { error: `pdftotext failed: ${text.stderr.trim() || `exit ${text.exitCode}`}` };
	}
	const pages = text.stdout.split("\f");
	if (pages[pages.length - 1]?.trim() === "") pages.pop();
	const lines = [
		`# Extracted PDF text ${basename(filePath)}: ${pageCount} pages, showing pages ${range.first}-${range.last}`,
	];
	if (range.last < pageCount) {
		lines.push(
			`[text truncated to this page range; more pages follow: pass pages=${range.last + 1}-${Math.min(pageCount, range.last + PDF_DEFAULT_PAGES)}]`,
		);
	}
	if (text.outputCapped) lines.push(`[text cut at ${formatSize(RENDER_CAP_BYTES)}; pass a narrower pages range]`);
	if (pages.every((page) => page.trim().length === 0)) {
		lines.push("[no extractable text on these pages; they may be scanned images, and OCR is not supported]");
	}
	// Attachment caps use renderer offsets so page-like text in the PDF cannot spoof coverage (#438).
	let offset = lines.join("\n").length;
	const pageStarts = pages.map((page, index) => {
		const pageNumber = range.first + index;
		const heading = `--- page ${pageNumber} ---`;
		const body = page.replace(/\n+$/u, "");
		const start = offset + heading.length + 3;
		offset = start + body.length;
		lines.push("", heading, body);
		return { page: pageNumber, offset: start };
	});
	return { text: lines.join("\n"), pageStarts };
}
