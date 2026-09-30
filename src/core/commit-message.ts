/**
 * A line Git reads as a trailer: a token, optional blanks, a colon, then a
 * blank or the end of the line. Looser than Git's own parser on purpose, so a
 * spelling Git would accept is never let through.
 */
const TRAILER_LINE = /^[A-Za-z0-9][A-Za-z0-9-]*[ \t]*:(?:[ \t]|$)/u;
const CONTINUATION_LINE = /^[ \t]+\S/u;
const PARAGRAPH_BREAK = /\n[ \t]*\n/u;

/** Drop trailer lines and the indented continuation lines folded under them. */
function withoutTrailerLines(lines: ReadonlyArray<string>): string[] {
	const kept: string[] = [];
	let inTrailer = false;
	for (const line of lines) {
		if (TRAILER_LINE.test(line)) {
			inTrailer = true;
			continue;
		}
		if (inTrailer && CONTINUATION_LINE.test(line)) continue;
		inTrailer = false;
		kept.push(line);
	}
	return kept;
}

function isTrailerBlock(lines: ReadonlyArray<string>): boolean {
	const fields = lines.filter((line) => !CONTINUATION_LINE.test(line));
	return fields.length > 0 && fields.every((line) => TRAILER_LINE.test(line));
}

/**
 * Reduce model-authored commit text to its subject and body. Only Clio's
 * managed prepare-commit-msg hook may write trailers such as `Clio-Evidence:`
 * or `Co-authored-by:`, so a trailer the worker typed is removed wherever Git
 * could read it as one: any line after the subject in the final paragraph, and
 * any paragraph made only of trailers. The subject line is always kept.
 */
export function stripAuthoredTrailers(message: string): string {
	const paragraphs = message.replace(/\r\n?/gu, "\n").trim().split(PARAGRAPH_BREAK);
	const last = paragraphs.length - 1;
	const out: string[] = [];
	for (const [index, paragraph] of paragraphs.entries()) {
		const lines = paragraph.split("\n");
		if (index === 0) {
			const [subject = "", ...rest] = lines;
			out.push([subject, ...withoutTrailerLines(rest)].join("\n"));
			continue;
		}
		if (index === last) {
			const kept = withoutTrailerLines(lines);
			if (kept.some((line) => line.trim().length > 0)) out.push(kept.join("\n"));
			continue;
		}
		if (!isTrailerBlock(lines)) out.push(paragraph);
	}
	return out.join("\n\n").trim();
}
