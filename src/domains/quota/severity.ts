/**
 * The one quota-severity policy.
 *
 * `/usage` colours a window by it and the background memory budget stops
 * spending a subscription window at its warning level, so an operator never
 * sees a window drawn as safe while memory has already backed off it, or the
 * reverse. A provider's own severity word wins over the percent floors.
 */

import type { UsageSnapshot, UsageWindow } from "./types.js";

/** How close a window is to its limit. */
export type QuotaSeverity = "normal" | "caution" | "warning" | "critical";

/**
 * Percent-used floors for a window the provider did not classify.
 *
 * Anthropic sends its own `severity` and that is preferred; these floors exist
 * for Codex and Antigravity, which send none.
 */
export const QUOTA_SEVERITY_FLOORS: Readonly<Record<Exclude<QuotaSeverity, "normal">, number>> = {
	caution: 60,
	warning: 80,
	critical: 95,
};

const SEVERITY_RANK: Readonly<Record<QuotaSeverity, number>> = { normal: 0, caution: 1, warning: 2, critical: 3 };

export function severityForPct(usedPct: number): QuotaSeverity {
	if (usedPct >= QUOTA_SEVERITY_FLOORS.critical) return "critical";
	if (usedPct >= QUOTA_SEVERITY_FLOORS.warning) return "warning";
	if (usedPct >= QUOTA_SEVERITY_FLOORS.caution) return "caution";
	return "normal";
}

/** A provider's own severity word when it sent a recognized one, else the floors. */
export function windowSeverity(window: UsageWindow): QuotaSeverity {
	const reported = window.severity?.toLowerCase();
	if (reported !== undefined && Object.hasOwn(SEVERITY_RANK, reported)) return reported as QuotaSeverity;
	return severityForPct(window.usedPct);
}

/** Positive when `left` is closer to its limit than `right`. */
export function compareQuotaSeverity(left: QuotaSeverity, right: QuotaSeverity): number {
	return SEVERITY_RANK[left] - SEVERITY_RANK[right];
}

/** True when the window is at or past the warning level, the point where optional spend stops. */
export function windowAtWarning(window: UsageWindow): boolean {
	return compareQuotaSeverity(windowSeverity(window), "warning") >= 0;
}

/** The window closest to biting: highest severity, then highest use. */
export function primaryWindow(snapshot: UsageSnapshot): UsageWindow | null {
	let best: UsageWindow | null = null;
	for (const window of snapshot.windows) {
		const order = best === null ? 1 : compareQuotaSeverity(windowSeverity(window), windowSeverity(best));
		if (best === null || order > 0 || (order === 0 && window.usedPct > best.usedPct)) best = window;
	}
	return best;
}
