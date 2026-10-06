/**
 * Pure presentation helpers for quota snapshots.
 *
 * These produce plain strings and severity words. No terminal, no theme,
 * no component imports, so the interactive layer decides colour and the
 * domain stays testable without a TTY.
 *
 * Two facts from live accounts shape everything here. A provider may report
 * no session window at all (Codex reports weekly only), so no surface may
 * assume a fixed row shape. And two credentials can sit on one account
 * (anthropic-max and claude-code), so a combined view must fold them rather
 * than present one budget twice.
 */

import type { QuotaSeverity } from "./severity.js";
import { compareQuotaSeverity, primaryWindow, windowSeverity } from "./severity.js";
import type { UsageSnapshot, UsageWindow } from "./types.js";

export type { QuotaSeverity } from "./severity.js";
export { primaryWindow, QUOTA_SEVERITY_FLOORS, severityForPct, windowAtWarning, windowSeverity } from "./severity.js";

/** The snapshot's worst severity, which is what a single indicator should show. */
export function snapshotSeverity(snapshot: UsageSnapshot): QuotaSeverity {
	let worst: QuotaSeverity = "normal";
	for (const window of snapshot.windows) {
		const severity = windowSeverity(window);
		if (compareQuotaSeverity(severity, worst) > 0) worst = severity;
	}
	return worst;
}

/** Whole percent, so a footer never jitters on a fractional change. */
export function formatPct(usedPct: number): string {
	return `${Math.round(usedPct)}%`;
}

/** The named window when the provider reports one, for surfaces that want a fixed column. */
export function windowByKey(snapshot: UsageSnapshot, key: string): UsageWindow | null {
	return snapshot.windows.find((window) => window.key === key) ?? null;
}

/**
 * Fold credentials that report the same account.
 *
 * anthropic-max and claude-code are separate credentials on one Anthropic
 * subscription, so showing both doubles the apparent budget. When their
 * windows agree, the one carrying a plan label survives.
 */
export function foldDuplicateAccounts(snapshots: ReadonlyArray<UsageSnapshot>): UsageSnapshot[] {
	const kept: UsageSnapshot[] = [];
	for (const snapshot of snapshots) {
		const twin = kept.findIndex((existing) => sameAccount(existing, snapshot));
		if (twin < 0) {
			kept.push(snapshot);
			continue;
		}
		const existing = kept[twin];
		if (existing !== undefined && existing.plan == null && snapshot.plan != null) kept[twin] = snapshot;
	}
	return kept;
}

function sameAccount(left: UsageSnapshot, right: UsageSnapshot): boolean {
	if (left.status !== "ok" || right.status !== "ok") return false;
	const anthropic = new Set(["anthropic-max", "claude-code"]);
	if (left.providerId === right.providerId || !anthropic.has(left.providerId) || !anthropic.has(right.providerId))
		return false;
	if (left.windows.length === 0 || left.windows.length !== right.windows.length) return false;
	return left.windows.every((window, index) => {
		const other = right.windows[index];
		return (
			other !== undefined &&
			other.key === window.key &&
			other.scope === window.scope &&
			(other.resetsAt === window.resetsAt ||
				(other.resetsAt !== null &&
					window.resetsAt !== null &&
					Math.abs(Date.parse(other.resetsAt) - Date.parse(window.resetsAt)) < 1000)) &&
			Math.abs(other.usedPct - window.usedPct) < 0.5
		);
	});
}

/**
 * One compact footer segment across providers.
 *
 * Weekly is the shared column because every provider observed so far
 * reports one. A session window is appended only where it exists, which
 * is what the decision log meant by 5h for Claude models.
 */
export function footerQuotaSegment(snapshots: ReadonlyArray<UsageSnapshot>): string | null {
	const parts: string[] = [];
	for (const snapshot of foldDuplicateAccounts(snapshots)) {
		if (snapshot.status !== "ok") continue;
		const weekly = windowByKey(snapshot, "weekly");
		const session = windowByKey(snapshot, "session");
		const shown: string[] = [];
		if (session) shown.push(`5h ${formatPct(session.usedPct)} used`);
		if (weekly) shown.push(`wk ${formatPct(weekly.usedPct)} used`);
		const binding = primaryWindow(snapshot);
		if (shown.length > 0 && binding?.scope && binding !== session && binding !== weekly) {
			shown.push(
				`${binding.scope}${binding.label === binding.scope ? "" : ` ${binding.label}`} ${formatPct(binding.usedPct)} used`,
			);
		}
		if (shown.length === 0) {
			const fallback = primaryWindow(snapshot);
			if (fallback) shown.push(`${fallback.short ?? fallback.label} ${formatPct(fallback.usedPct)} used`);
		}
		if (shown.length > 0) parts.push(`${shortName(snapshot.displayName)} ${shown.join("/")}`);
	}
	return parts.length > 0 ? parts.join(" · ") : null;
}

function shortName(displayName: string): string {
	const first = displayName.split(" ")[0] ?? displayName;
	return first;
}

/**
 * One line for the welcome banner and any other single-line surface.
 *
 * Paid accounts first, then the free local row, so the contrast between a
 * consumed subscription window and free local inference is visible in one
 * glance.
 */
export function quotaSummaryLine(snapshots: ReadonlyArray<UsageSnapshot>): string | null {
	const paid = footerQuotaSegment(snapshots);
	const local = snapshots.find((snapshot) => snapshot.providerId === "local");
	const localPart = local?.credits ? `Local ${local.credits.display}` : null;
	const parts = [paid, localPart].filter((part): part is string => part !== null);
	return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The local-inference row.
 *
 * A local model consumes no subscription window and no credit, so it is
 * reported as free rather than omitted. Showing it beside the paid rows is
 * the point: work routed locally is work that did not spend a quota.
 * The saved-quota figure is deliberately absent here, because proving it
 * needs per-target token attribution this slice does not collect.
 */
export function localQuotaSnapshot(options: { runtimeLabel?: string; fetchedAt?: string | null } = {}): UsageSnapshot {
	return {
		providerId: "local",
		displayName: options.runtimeLabel ?? "Local AI",
		status: "ok",
		windows: [],
		credits: { display: "$0.00", usedPct: null },
		plan: "Local",
		message: "no subscription window consumed",
		fetchedAt: options.fetchedAt ?? null,
	};
}
