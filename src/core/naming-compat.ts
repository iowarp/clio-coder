/**
 * Released naming aliases retained for the v0.5 and v0.6 compatibility window.
 * Canonical writers must never call this helper; it exists only at read and
 * protocol boundaries where an older Clio Coder installation can still be the
 * producer.
 */

const warned = new Set<string>();

export const LEGACY_NAMING_COMPATIBILITY_RETIREMENT = "v0.7.0";

/** Emit one deprecation diagnostic per legacy/canonical pair in this process. */
export function warnLegacyNaming(legacy: string, canonical: string): void {
	const key = `${legacy}\0${canonical}`;
	if (warned.has(key)) return;
	warned.add(key);
	process.emitWarning(
		`'${legacy}' is a deprecated Clio Coder identifier; use '${canonical}'. ` +
			`Legacy naming compatibility is scheduled for removal in ${LEGACY_NAMING_COMPATIBILITY_RETIREMENT}.`,
		{ code: "CLIO_CODER_LEGACY_NAMING", type: "DeprecationWarning" },
	);
}

/** Test-only reset for assertions that need to observe one-time diagnostics. */
export function resetLegacyNamingWarningsForTest(): void {
	warned.clear();
}
