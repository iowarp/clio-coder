// The filter engine for bounded lists. Facet values are derived from the rows actually present, so
// a chip can never offer a value that matches nothing, and the summary sentence states the window
// explicitly, so narrowing a projection is never mistaken for searching the whole record.

export interface FacetValue {
	readonly value: string;
	readonly label: string;
	readonly count: number;
}

export interface FacetDefinition<Row> {
	readonly key: string;
	readonly label: string;
	/** The facet value for a row, or null when the row has none. */
	readonly of: (row: Row) => string | null;
	/** Display label for a value. Defaults to the value itself. */
	readonly display?: (value: string) => string;
	/**
	 * When set, the facet lists exactly these values in this order and hides the ones no row has.
	 * Use for closed vocabularies such as outcome; omit for open ones such as agent id, which sort
	 * by count.
	 */
	readonly order?: readonly string[];
}

export interface FilterState {
	readonly query: string;
	/** facet key to selected value, or absent. One value per facet. */
	readonly facets: Readonly<Record<string, string | null>>;
}

export const EMPTY_FILTER: FilterState = { query: "", facets: {} };

export function isFilterActive(filter: FilterState): boolean {
	return filter.query.trim().length > 0 || Object.values(filter.facets).some((value) => value !== null);
}

function countBy(values: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return counts;
}

export function deriveFacets<Row>(
	rows: readonly Row[],
	definitions: readonly FacetDefinition<Row>[],
): Record<string, FacetValue[]> {
	const result: Record<string, FacetValue[]> = {};
	for (const definition of definitions) {
		const counts = countBy(
			rows.flatMap((row) => {
				const value = definition.of(row);
				return value === null ? [] : [value];
			}),
		);
		const display = definition.display ?? ((value: string) => value);
		result[definition.key] = definition.order
			? definition.order
					.filter((value) => counts.has(value))
					.map((value) => ({ value, label: display(value), count: counts.get(value) ?? 0 }))
			: // Count descending with a locale-explicit label tiebreak, so chip order does not shuffle
				// between refreshes of the same window.
				[...counts.entries()]
					.map(([value, count]) => ({ value, label: display(value), count }))
					.sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "en-US"));
	}
	return result;
}

function normalise(text: string): string {
	return text.toLocaleLowerCase("en-US");
}

/**
 * Prefix match on any word of the row's bounded identifiers or its prose preview. An id is one
 * token, so "run-a" finds "run-alpha"; a task preview is prose, so any of its words may start with
 * the query. The split class tokenises run ids, dotted model names, slashed paths and snake or kebab
 * identifiers alike.
 */
export function matchesQuery(haystacks: readonly string[], query: string): boolean {
	const needle = normalise(query.trim());
	if (needle.length === 0) return true;
	return haystacks.some((text) => {
		const lowered = normalise(text);
		return lowered.startsWith(needle) || lowered.split(/[\s/:._-]+/u).some((word) => word.startsWith(needle));
	});
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

/** AND across every selected facet, then the query. The filter never reaches the server. */
export function applyFilter<Row>(
	rows: readonly Row[],
	definitions: readonly FacetDefinition<Row>[],
	filter: FilterState,
	haystacks: (row: Row) => readonly string[],
): Row[] {
	return rows.filter((row) => {
		for (const definition of definitions) {
			const selected = filter.facets[definition.key] ?? null;
			if (selected !== null && definition.of(row) !== selected) return false;
		}
		return matchesQuery(haystacks(row), filter.query);
	});
}

/**
 * Three facts the sentence always carries: the filter is a projection over rows already fetched,
 * older rows exist outside the window, and a server-side cut is stated separately from the filter's
 * own narrowing.
 */
export function filterSummary(
	shown: number,
	total: number,
	truncated: boolean,
	active: boolean,
	noun: { one: string; many: string },
	source: string,
): string {
	const window = `${total.toLocaleString("en-US")} most recent ${total === 1 ? noun.one : noun.many} ${source} reports`;
	const cut = truncated ? " The window itself was cut at this bound." : "";
	if (!active) return `Showing all ${window}. Older ${noun.many} are not in this window.${cut}`;
	if (shown === 0)
		return `No ${noun.many} in this window match. Clear the filter to see all ${total.toLocaleString("en-US")}.${cut}`;
	return `Showing ${shown.toLocaleString("en-US")} of the ${window}. Older ${noun.many} are not in this window.${cut}`;
}
