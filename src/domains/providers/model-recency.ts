/** #416: only the leading name identifies a family; version suffixes do not. */
export function modelFamilyForId(id: string): string | null {
	const tokens = id.toLowerCase().split(/[-_.:/]+/u);
	const version = tokens.findIndex((token) => /\d/u.test(token));
	if (version <= 0) return null;
	return tokens.slice(0, version).join("-");
}

export function modelDateMs(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

/** #416: an upgrade notice requires provider dates for both concrete ids. */
export function newerModelNotice(
	targetId: string,
	model: string,
	models: ReadonlyArray<string>,
	createdAt: Readonly<Record<string, string>> | undefined,
): string | null {
	const currentDate = modelDateMs(createdAt?.[model]);
	const family = modelFamilyForId(model);
	if (currentDate === null || family === null) return null;
	let newest = model;
	let newestDate = currentDate;
	for (const candidate of models) {
		if (modelFamilyForId(candidate) !== family) continue;
		const date = modelDateMs(createdAt?.[candidate]);
		if (date !== null && date > newestDate) {
			newest = candidate;
			newestDate = date;
		}
	}
	return newest === model
		? null
		: `Newer model available: ${targetId}/${newest} (current ${model}). Use /model to switch.`;
}
