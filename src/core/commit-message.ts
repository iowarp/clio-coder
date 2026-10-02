/**
 * A line Git reads as a trailer: a token of letters, digits and hyphens,
 * optional blanks, then a colon. Git does not require a blank after the colon,
 * so `Co-authored-by:Evil <e@x>` is a trailer to it and must be one here. The
 * token may start with a hyphen, as in Git's own separator scan. Only the
 * default `:` separator is matched; a `trailer.separators` override is not
 * visible from a message string.
 */
const TRAILER_LINE = /^[A-Za-z0-9-]+[ \t]*:/u;
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

const COMMIT_SUBJECT_MAX_CHARS = 72;

/**
 * A one-line commit subject drawn from prose such as a worker's summary or its
 * task: the first sentence of the first nonblank line, without its closing
 * punctuation, cut at a word boundary under 72 characters. Null when nothing
 * is left, so the caller keeps its own fallback.
 */
export function taskCommitSubject(text: string | null | undefined): string | null {
	if (typeof text !== "string") return null;
	const line = text.split(/\r?\n/u).find((candidate) => candidate.trim().length > 0) ?? "";
	const sentence = (line.trim().split(/(?<=[.!?])\s+/u)[0] ?? "").replace(/[.!?]+$/u, "").trim();
	if (sentence.length === 0) return null;
	if (sentence.length <= COMMIT_SUBJECT_MAX_CHARS) return sentence;
	const cut = sentence.slice(0, COMMIT_SUBJECT_MAX_CHARS - 1);
	const space = cut.lastIndexOf(" ");
	return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
