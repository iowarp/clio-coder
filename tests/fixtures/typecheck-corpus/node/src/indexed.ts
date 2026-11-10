// noUncheckedIndexedAccess: element and record reads may be undefined.
export function first(values: string[]): string {
	return values[0];
}
export function lookup(table: Record<string, number>, key: string): number {
	const value = table[key];
	return value + 1;
}
export function guarded(values: readonly string[]): string {
	return values[0] ?? "";
}
