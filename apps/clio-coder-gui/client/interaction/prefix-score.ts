// The command palette's ranking. Text is compared case-insensitively in a fixed locale, so the order
// does not move with the viewer's language.

function normalise(text: string): string {
	return text.toLocaleLowerCase("en-US");
}

/**
 * How well one row's text answers a needle: a whole-value prefix beats a word prefix, which beats a
 * bare substring. The first haystack weighs triple, which is how a launcher puts a title match above
 * a keyword match.
 */
export function prefixScore(haystacks: readonly string[], query: string): number {
	const needle = normalise(query.trim());
	if (needle.length === 0) return 1;
	let best = 0;
	for (const [index, text] of haystacks.entries()) {
		const lowered = normalise(text);
		const weight = index === 0 ? 3 : 1;
		if (lowered.startsWith(needle)) best = Math.max(best, 3 * weight);
		else if (lowered.split(/[\s/:._-]+/u).some((word) => word.startsWith(needle))) best = Math.max(best, 2 * weight);
		else if (lowered.includes(needle)) best = Math.max(best, 1 * weight);
	}
	return best;
}
