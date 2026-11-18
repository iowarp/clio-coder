/** Small helpers shared by the memory modules; each was copied file by file before. */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function positiveInteger(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Whitespace collapsed, then cut to `maxChars` with an ellipsis. */
export function shortText(value: string, maxChars: number): string {
	const normalized = value.replace(/\s+/gu, " ").trim();
	return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** Code-unit order, independent of locale: the order ids and digests are built from. */
export function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
