/**
 * Token and dollar labels shared by the terminal footer and the /view artifact
 * providers, which also serve ACP clients (ACP ask 03), so both surfaces print
 * the same numbers the same way.
 */

/**
 * Render a token count with a single-letter magnitude suffix so the footer
 * stays short on long-running sessions. Values under 1,000 render as the
 * raw integer; 1,000-999,999 render with a `k` suffix and one decimal when
 * that digit is non-zero; 1,000,000+ uses `M`.
 */
export function formatFooterTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	const value = Math.round(n);
	if (value < 1000) return value.toString();
	if (value < 1_000_000) {
		const scaled = value / 1000;
		const fixed = scaled.toFixed(1);
		return fixed.endsWith(".0") ? `${fixed.slice(0, -2)}k` : `${fixed}k`;
	}
	const scaled = value / 1_000_000;
	const fixed = scaled.toFixed(1);
	return fixed.endsWith(".0") ? `${fixed.slice(0, -2)}M` : `${fixed}M`;
}

export function formatUsd(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0.00";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}
