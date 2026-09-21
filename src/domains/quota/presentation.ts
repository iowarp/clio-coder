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

import type { UsageSnapshot, UsageWindow } from "./types.js";

/** How close a window is to its limit, in the absence of a provider word. */
export type QuotaSeverity = "normal" | "caution" | "warning" | "critical";

const SEVERITY_WORDS = new Set<QuotaSeverity>(["normal", "caution", "warning", "critical"]);

/**
 * Thresholds for a window the provider did not classify.
 *
 * Anthropic sends its own `severity` and that is preferred; these bounds
 * exist for Codex and Antigravity, which send none.
 */
export function severityForPct(usedPct: number): QuotaSeverity {
	if (usedPct >= 95) return "critical";
	if (usedPct >= 80) return "warning";
	if (usedPct >= 60) return "caution";
	return "normal";
}

/** A provider's own severity word when it sent a recognized one, else the threshold. */
export function windowSeverity(window: UsageWindow): QuotaSeverity {
	const reported = window.severity?.toLowerCase();
	if (reported !== undefined && SEVERITY_WORDS.has(reported as QuotaSeverity)) {
		return reported as QuotaSeverity;
	}
	return severityForPct(window.usedPct);
}

/** The snapshot's worst severity, which is what a single indicator should show. */
export function snapshotSeverity(snapshot: UsageSnapshot): QuotaSeverity {
	const rank: QuotaSeverity[] = ["normal", "caution", "warning", "critical"];
	let worst: QuotaSeverity = "normal";
	for (const window of snapshot.windows) {
		const severity = windowSeverity(window);
		if (rank.indexOf(severity) > rank.indexOf(worst)) worst = severity;
	}
	return worst;
}

/** Whole percent, so a footer never jitters on a fractional change. */
export function formatPct(usedPct: number): string {
	return `${Math.round(usedPct)}%`;
}

/** The window a compact indicator should show: the one closest to biting. */
export function primaryWindow(snapshot: UsageSnapshot): UsageWindow | null {
	let best: UsageWindow | null = null;
	for (const window of snapshot.windows) {
		const rank = { normal: 0, caution: 1, warning: 2, critical: 3 };
		if (
			best === null ||
			rank[windowSeverity(window)] > rank[windowSeverity(best)] ||
			(rank[windowSeverity(window)] === rank[windowSeverity(best)] && window.usedPct > best.usedPct)
		)
			best = window;
	}
	return best;
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
 * Lines for the welcome header: one per connected subscription, naming the
 * plan and whatever windows that provider actually reports.
 */
export function welcomeQuotaLines(snapshots: ReadonlyArray<UsageSnapshot>): string[] {
	const lines: string[] = [];
	for (const snapshot of foldDuplicateAccounts(snapshots)) {
		if (snapshot.status === "no_credentials") continue;
		const head = snapshot.plan ? `${snapshot.displayName} · ${snapshot.plan}` : snapshot.displayName;
		if (snapshot.status !== "ok") {
			lines.push(`${head} · ${snapshot.message ?? snapshot.status}`);
			continue;
		}
		const parts = snapshot.windows.map((window) => `${window.label} ${formatPct(window.usedPct)} used`);
		if (snapshot.credits) parts.push(snapshot.credits.display);
		lines.push(parts.length > 0 ? `${head} · ${parts.join(" · ")}` : `${head} · connected`);
	}
	return lines;
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

/** Rows for the expanded dashboard's Status page, one provider per row. */
export function statusPageQuotaRows(snapshots: ReadonlyArray<UsageSnapshot>): Array<{
	label: string;
	detail: string;
	severity: QuotaSeverity;
}> {
	return foldDuplicateAccounts(snapshots).map((snapshot) => {
		const label = snapshot.plan ? `${snapshot.displayName} (${snapshot.plan})` : snapshot.displayName;
		if (snapshot.status !== "ok") {
			return { label, detail: snapshot.message ?? snapshot.status, severity: "normal" as QuotaSeverity };
		}
		const windows = snapshot.windows.map(
			(window) => `${window.label} ${formatPct(window.usedPct)} used${resetSuffix(window)}`,
		);
		if (snapshot.credits) windows.push(`credits ${snapshot.credits.display}`);
		return {
			label,
			detail: windows.length > 0 ? windows.join(" · ") : "connected",
			severity: snapshotSeverity(snapshot),
		};
	});
}

function resetSuffix(window: UsageWindow): string {
	return window.resetsAt === null ? "" : ` (resets ${window.resetsAt.slice(0, 16).replace("T", " ")}Z)`;
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
