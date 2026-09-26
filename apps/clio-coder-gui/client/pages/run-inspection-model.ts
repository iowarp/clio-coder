/** Only page-owned filters travel to the list; launch credentials never do. */
export function listDestination(path: string, search: URLSearchParams, keys: readonly string[]): string {
	const next = new URLSearchParams();
	for (const key of keys) {
		const value = search.get(key);
		if (value) next.set(key, value);
	}
	return `${path}${next.size ? `?${next}` : ""}`;
}

export function matchesText(query: string, values: readonly (string | null | undefined)[]): boolean {
	const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
	const text = values.filter(Boolean).join(" ").toLocaleLowerCase();
	return terms.every((term) => text.includes(term));
}

export function evidenceDestination(runId: string): string {
	return `/evidence?${new URLSearchParams({ run: runId })}`;
}
