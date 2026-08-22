/**
 * Ordinal string comparison for determinism-critical orderings.
 *
 * `String.prototype.localeCompare` collates through ICU, so its answer depends
 * on the process locale and the ICU build. Evidence rows, "latest" selectors,
 * and verifier catalogs must order identically on every machine that rebuilds
 * them, so they compare UTF-16 code units instead. That order is the code
 * point order for all BMP text and never reads the environment.
 */
export function compareCodepoints(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
