const HEADER_PREFIX = "SPLIT RECOMMENDATION: ";
const SUBTASK_PREFIX = "- ";
const MAX_HEAD_BYTES = 800;
const MAX_RATIONALE_BYTES = 200;
const MAX_SUBTASK_BYTES = 120;
const MAX_SUBTASKS = 4;

export interface ScoutSplitRecommendation {
	rationale: string;
	subtasks: string[];
}

interface LineBounds {
	contentEnd: number;
	next: number;
}

function lineBounds(text: string, start: number): LineBounds {
	const newline = text.indexOf("\n", start);
	const rawEnd = newline === -1 ? text.length : newline;
	const contentEnd = rawEnd > start && text.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd;
	return { contentEnd, next: newline === -1 ? text.length : newline + 1 };
}

function byteLengthWithin(value: string, min: number, max: number): boolean {
	const bytes = Buffer.byteLength(value, "utf8");
	return bytes >= min && bytes <= max;
}

function containsLineBreak(value: string): boolean {
	return /[\r\n\u2028\u2029]/u.test(value);
}

/**
 * Parse the bounded Scout-only split protocol from the first non-empty lines
 * of an unformatted final answer. All malformed and ambiguous inputs fail
 * closed to null; this advisory parser must never fail a dispatch result.
 */
export function parseScoutSplitRecommendation(text: string): ScoutSplitRecommendation | null {
	try {
		let markerStart = 0;
		// The producer contract says first non-empty line. Accepting exact empty
		// lines keeps the raw-byte parser faithful without allowing prose or
		// indentation before the marker.
		while (markerStart < text.length) {
			if (text.startsWith("\r\n", markerStart)) {
				markerStart += 2;
				continue;
			}
			if (text.charCodeAt(markerStart) === 10) {
				markerStart += 1;
				continue;
			}
			break;
		}

		if (Buffer.byteLength(text.slice(0, markerStart), "utf8") >= MAX_HEAD_BYTES) return null;
		if (!text.startsWith(HEADER_PREFIX, markerStart)) return null;

		const header = lineBounds(text, markerStart);
		const rationaleStart = markerStart + HEADER_PREFIX.length;
		const rationale = text.slice(rationaleStart, header.contentEnd);
		if (containsLineBreak(rationale) || !byteLengthWithin(rationale, 1, MAX_RATIONALE_BYTES)) return null;

		const subtasks: string[] = [];
		let blockEnd = header.contentEnd;
		let cursor = header.next;
		while (cursor < text.length && text.startsWith(SUBTASK_PREFIX, cursor)) {
			const bullet = lineBounds(text, cursor);
			const subtask = text.slice(cursor + SUBTASK_PREFIX.length, bullet.contentEnd);
			if (containsLineBreak(subtask) || !byteLengthWithin(subtask, 1, MAX_SUBTASK_BYTES)) return null;
			subtasks.push(subtask);
			if (subtasks.length > MAX_SUBTASKS) return null;
			blockEnd = bullet.contentEnd;
			cursor = bullet.next;
		}

		if (subtasks.length === 0) return null;
		// A dangling or non-grammar dash line immediately after recognized bullets
		// is an incomplete/ambiguous continuation, not ordinary answer prose.
		if (cursor < text.length && text.charCodeAt(cursor) === 45) return null;
		if (Buffer.byteLength(text.slice(0, blockEnd), "utf8") > MAX_HEAD_BYTES) return null;

		return { rationale, subtasks };
	} catch {
		return null;
	}
}
