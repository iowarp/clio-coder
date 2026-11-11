/**
 * What a reminder said, as one line: its first line, up to the end of its first
 * sentence or the colon that introduces a list. A reminder is written to the
 * model, so every operator surface shows this gist and never the instruction.
 */
export function reminderGist(text: string): string {
	// The list a reminder introduces can arrive flattened onto its first line, so the colon ends the gist too.
	const firstLine = (text.split("\n")[0] ?? "").trim();
	return (/^(.+?)(?::\s|:$|[.!?](?:\s|$))/u.exec(firstLine)?.[1] ?? firstLine).trim();
}
