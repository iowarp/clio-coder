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

/** Prefer a canonical environment variable and temporarily fall back to its released alias. */
export function readNamingEnvironment(
	environment: NodeJS.ProcessEnv,
	canonical: string,
	legacy: string,
): string | undefined {
	const current = environment[canonical]?.trim();
	if (current) return current;
	const fallback = environment[legacy]?.trim();
	if (!fallback) return undefined;
	warnLegacyNaming(legacy, canonical);
	return fallback;
}

/** Parent-to-child bridge used only during the two-minor compatibility window. */
export function namingCompatibilityEnvironment(
	canonical: string,
	legacy: string,
	value: string,
): Record<string, string> {
	return { [canonical]: value, [legacy]: value };
}
