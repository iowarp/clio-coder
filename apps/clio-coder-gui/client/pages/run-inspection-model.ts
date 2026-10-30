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

export type InspectionSort = "newest" | "oldest" | "name";
export function inspectionSort(value: string | null): InspectionSort {
	return value === "oldest" || value === "name" ? value : "newest";
}

/** Sorting changes only the retained window; it never implies a search of unloaded artifacts. */
export function sortInspectionRecords<T>(
	rows: readonly T[],
	sort: InspectionSort,
	identity: (row: T) => { name: string; date: string; id: string },
): T[] {
	return [...rows].sort((a, b) => {
		const av = identity(a),
			bv = identity(b);
		const at = Date.parse(av.date),
			bt = Date.parse(bv.date);
		if (sort !== "name" && Number.isFinite(at) !== Number.isFinite(bt)) return Number.isFinite(at) ? -1 : 1;
		const time = Number.isFinite(at) && Number.isFinite(bt) ? at - bt : 0;
		return (
			(sort === "name" ? av.name.localeCompare(bv.name) : sort === "oldest" ? time : -time) || av.id.localeCompare(bv.id)
		);
	});
}

export function evidenceVerdictTone(verdict: string) {
	return verdict === "compromised"
		? "fail"
		: verdict === "reviewed" || verdict === "grounded"
			? "success"
			: "unverified";
}

export function evidenceRequestIdentity(workspace: string, run: string, kind: "build" | "verify"): string {
	return JSON.stringify([workspace, run.trim(), kind]);
}
