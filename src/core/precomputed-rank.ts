/**
 * Reorder a list by scores something else resolved earlier.
 *
 * Several harness surfaces rank their candidates with a System One model, and
 * none of them can await one where the ranking happens: prompt selection, the
 * skills listing and dispatch all run synchronously. So the scores arrive as
 * values an async pass already produced, and this is the one place that turns
 * a score map into an order.
 *
 * The rule every caller needs is what happens to a candidate the pass had no
 * opinion about. Reading a missing score as zero would rank an unknown
 * candidate below every known one and drop it at the first bound, which reads
 * "do not know" as "not relevant". Instead the scored candidates are
 * redistributed across the slots they already occupied, so an unscored one
 * holds the position the incoming order gave it and the incoming order still
 * decides everything the pass did not speak to.
 */

/** Scores plus the identity of whatever produced them, for a footer or a cache key. */
export interface PrecomputedRanking {
	/** Candidate key to score, higher ranks first. Absent or non-finite is an abstention. */
	readonly scores: Readonly<Record<string, number>>;
	/** Names the pass, so a surprising order can be explained and a cache can key on it. */
	readonly source: string;
}

export interface PrecomputedRanked<T> {
	readonly item: T;
	/** Null when the pass abstained, which is not the same as a zero. */
	readonly score: number | null;
}

/** A score only counts when it is a real number; anything else is an abstention. */
function precomputedScore(scores: Readonly<Record<string, number>>, key: string): number | null {
	const raw = scores[key];
	return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/**
 * Sort `items` by score, leaving every unscored entry exactly where it was.
 * Ties keep the incoming order, so the result is deterministic for any input.
 */
export function rankByPrecomputedScore<T>(
	items: ReadonlyArray<T>,
	keyOf: (item: T) => string,
	scores: Readonly<Record<string, number>>,
): Array<PrecomputedRanked<T>> {
	const ranked = items.map((item): PrecomputedRanked<T> => ({ item, score: precomputedScore(scores, keyOf(item)) }));
	const slots = ranked.flatMap((entry, index) => (entry.score === null ? [] : [index]));
	const ordered = slots
		.map((index) => ({ index, entry: ranked[index] as PrecomputedRanked<T> }))
		.sort((a, b) => (b.entry.score ?? 0) - (a.entry.score ?? 0) || a.index - b.index);
	const out = [...ranked];
	for (const [position, slot] of slots.entries()) {
		out[slot] = ordered[position]?.entry as PrecomputedRanked<T>;
	}
	return out;
}
