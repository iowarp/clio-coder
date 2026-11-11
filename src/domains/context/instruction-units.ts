// Hard-wrapped handbooks produced fragments such as "clio MUST NOT decide routing,".
// Both adoption and authored policy need the same complete Markdown units.
// Each unit carries the file and 1-based line it starts on, so an adopted rule can cite where it was stated.
// `firstLine` is the source line `content` starts on when a caller stripped a prefix such as frontmatter.
export function instructionUnits(
	content: string,
	maxChars: number,
	file = "",
	firstLine = 1,
): Array<{
	text: string;
	heading: string;
	listItem: boolean;
	file: string;
	line: number;
}> {
	const units: Array<{ text: string; heading: string; listItem: boolean; adjacent: boolean; line: number }> = [];
	let heading = "";
	let fence: { marker: string; length: number } | null = null;
	let pending: { lines: string[]; heading: string; listItem: boolean; adjacent: boolean; line: number } | null = null;
	let adjacent = false;
	const flush = (): void => {
		if (pending === null) return;
		units.push({
			text: pending.lines.join(" ").replace(/\s+/g, " ").trim(),
			heading: pending.heading,
			listItem: pending.listItem,
			adjacent: pending.adjacent,
			line: pending.line,
		});
		pending = null;
		adjacent = true;
	};
	// Comment bodies and fenced examples are not policy; physical-line fragments lose that context.
	// Keep a removed comment's line breaks so later units keep their source line numbers.
	const text = content.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\n]/g, ""));
	const rawLines = text.split(/\r?\n/);
	for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex++) {
		const raw = rawLines[lineIndex] ?? "";
		const line = raw.trim();
		const fenceMatch = /^(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence !== null) {
			if (fenceMatch?.[0] === fence.marker && fenceMatch.length >= fence.length && /^\s*[`~]+\s*$/.test(raw)) fence = null;
			continue;
		}
		if (fenceMatch !== undefined) {
			flush();
			fence = { marker: fenceMatch[0] ?? "`", length: fenceMatch.length };
			adjacent = false;
			continue;
		}
		const title = /^#{1,6}\s+(.+)$/.exec(line)?.[1];
		// Blank lines, headings and tables end a unit so unrelated rules cannot become one fragment.
		if (line.length === 0 || title !== undefined || line.startsWith("|")) {
			flush();
			if (title !== undefined) heading = title;
			adjacent = false;
			continue;
		}
		const item = /^(?:[-*+]\s+|\d+[.)]\s+)(.*)$/.exec(line)?.[1];
		if (item !== undefined) flush();
		if (pending === null)
			pending = { lines: [], heading, listItem: item !== undefined, adjacent, line: firstLine + lineIndex };
		pending.lines.push(item ?? line);
	}
	flush();
	const result: Array<{ text: string; heading: string; listItem: boolean; file: string; line: number }> = [];
	for (let index = 0; index < units.length; index++) {
		const unit = units[index];
		if (unit === undefined) continue;
		// "DO NOT add without approval:" lost its dependency list when split by physical lines; keep them together.
		const intro = /:(?:\*\*|__)?$/.test(unit.text);
		if (intro && units[index + 1]?.listItem && units[index + 1]?.adjacent) {
			let end = index + 1;
			while (units[end]?.listItem && units[end]?.adjacent) end++;
			const combined = `${unit.text} ${units
				.slice(index + 1, end)
				.map((item) => item.text)
				.join("; ")}`;
			if (combined.length <= maxChars) {
				result.push({ text: combined, heading: unit.heading, listItem: unit.listItem, file, line: unit.line });
				index = end - 1;
			}
			// An oversized intro plus list would recreate the observed incomplete prohibition; drop the intro.
			continue;
		}
		// An intro without its list states no complete rule, even when bold markup follows the colon.
		if (intro) continue;
		// Never truncate a unit into fragments such as "— these are host-only.".
		if (unit.text.length > 0 && unit.text.length <= maxChars)
			result.push({ text: unit.text, heading: unit.heading, listItem: unit.listItem, file, line: unit.line });
	}
	return result;
}
