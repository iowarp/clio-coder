/** Physical source lines: a final newline terminates a line, not an extra line. */
export function sourceLineCount(source: string): number {
	return source.length === 0 ? 0 : source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
}

/**
 * Conservative whole-block prefix offsets, preserving original bytes. This is
 * deliberately not a Markdown parser: container fences stop selection at the
 * preceding safe boundary. Ordinary fences are indivisible, including longer
 * opening runs and misleading shorter closing runs.
 */
export function safePrefixOffsets(source: string, maxOffset: number): number[] {
	const offsets = [0];
	let offset = 0;
	let fence: { char: string; length: number } | null = null;
	for (const match of source.matchAll(/[^\n]*(?:\n|$)/g)) {
		if (match[0].length === 0) break;
		offset += match[0].length;
		if (offset > maxOffset) break;
		const line = match[0].replace(/\r?\n$/, "");
		if (!fence && /^\s*(?:>|[-+*]|\d+[.)])\s*.*(?:`{3,}|~{3,})/.test(line)) break;
		const run = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
		if (run) {
			const [, marker = "", tail = ""] = run;
			if (!fence) fence = { char: marker.charAt(0), length: marker.length };
			else if (marker.charAt(0) === fence.char && marker.length >= fence.length && tail.trim() === "") fence = null;
		}
		if (!fence && (line.trim() === "" || offset === source.length)) offsets.push(offset);
	}
	return offsets;
}
