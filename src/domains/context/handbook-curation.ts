import type { ClioMdSection } from "./clio-md.js";

interface SectionBoundary {
	title: string | null;
	start: number;
	bodyStart: number;
}

/** Recognize legacy top-level headings without interpreting fenced examples or comments as sections. */
function sectionBoundaries(source: string): SectionBoundary[] {
	const boundaries: SectionBoundary[] = [];
	let fence: { marker: string; length: number } | undefined;
	let comment = false;
	for (const line of source.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)) {
		const text = line[1] ?? "";
		const start = line.index;
		if (fence) {
			const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(text)?.[1];
			if (close && close[0] === fence.marker && close.length >= fence.length) fence = undefined;
			continue;
		}
		if (!comment) {
			const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
			const marker = open?.[1];
			if (marker && (marker[0] !== "`" || !open?.[2]?.includes("`"))) {
				fence = { marker: marker[0] ?? "", length: marker.length };
				continue;
			}
		}
		let cursor = 0;
		let hasComment = comment;
		while (cursor < text.length) {
			const marker = text.indexOf(comment ? "-->" : "<!--", cursor);
			if (marker === -1) break;
			if (!comment && /^<!--\s*clio:fingerprint v1\b/.test(source.slice(start + marker))) {
				// The legacy footer ends the structured document. Its bytes and all
				// following authored text are outside index curation.
				boundaries.push({ title: null, start: start + marker, bodyStart: start + marker });
				return boundaries;
			}
			cursor = marker + (comment ? 3 : 4);
			comment = !comment;
			hasComment = true;
		}
		if (hasComment) continue;
		const heading = /^(#{1,2})[ \t]+(.+?)[ \t]*$/.exec(text);
		if (heading) {
			boundaries.push({
				title: heading[1] === "##" ? (heading[2] ?? null) : null,
				start,
				bodyStart: start + line[0].length,
			});
		}
	}
	return boundaries;
}

/**
 * Compatibility for legacy index-owned titles. Replace only an existing unique
 * section's body; all bytes outside that span remain exact. A title is still the
 * legacy ownership signal, so authored edits inside that body can be replaced.
 */
export function curateHandbookSource(source: string, fresh: ReadonlyArray<ClioMdSection>): string {
	const boundaries = sectionBoundaries(source);
	let result = source;
	for (let index = boundaries.length - 1; index >= 0; index -= 1) {
		const section = boundaries[index];
		if (!section?.title || boundaries.filter((item) => item.title === section.title).length !== 1) continue;
		const replacement = fresh.find((item) => item.title === section.title)?.body;
		if (replacement === undefined) continue;
		const end = boundaries[index + 1]?.start ?? source.length;
		const body = source.slice(section.bodyStart, end);
		const current = body.trim();
		if (current.replace(/\r\n?/g, "\n") === replacement) continue;
		const headingEol = /\r\n|\r|\n/.exec(source.slice(section.start, section.bodyStart))?.[0];
		const eol = headingEol ?? "\n";
		const start = current.length > 0 ? section.bodyStart + body.length - body.trimStart().length : section.bodyStart;
		const rendered =
			(headingEol === undefined ? eol : "") + replacement.replace(/\r\n?|\n/g, eol) + (current.length === 0 ? eol : "");
		result = result.slice(0, start) + rendered + result.slice(start + current.length);
	}
	return result;
}
