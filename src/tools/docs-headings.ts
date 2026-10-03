export interface DocsHeadingState {
	fence?: { marker: string; length: number };
}

/** Shared by ranked retrieval and read's index so fenced examples never become sections (DF-2). */
export function docsHeading(line: string, state: DocsHeadingState): { level: number; heading: string } | null {
	const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
	if (fence) {
		const marker = fence[1] ?? "";
		if (!state.fence) {
			state.fence = { marker: marker[0] ?? "", length: marker.length };
		} else if (
			marker[0] === state.fence.marker &&
			marker.length >= state.fence.length &&
			(fence[2] ?? "").trim().length === 0
		) {
			delete state.fence;
		}
		return null;
	}
	if (state.fence) return null;
	const match = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
	return match ? { level: (match[1] ?? "").length, heading: (match[2] ?? "").trim() } : null;
}
