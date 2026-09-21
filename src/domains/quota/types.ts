/**
 * Read-only data model for provider subscription quota.
 *
 * The shapes mirror QuotaBubble's `providers/base.py` (`ProviderStatus`,
 * `UsageWindow`, `UsageSnapshot`) so that adapters written against either
 * project describe the same usage facts. Timestamps are ISO 8601 strings
 * rather than `Date` objects so a snapshot stays structurally cloneable
 * across the worker and transport boundaries.
 */

/** Outcome of one usage read, including the reasons a read produced no data. */
export type QuotaStatus = "ok" | "no_credentials" | "expired" | "error" | "loading";

/** One rate-limit window reported by a provider. */
export interface UsageWindow {
	/** Stable identity for ordering and lookup, for example "session" or "weekly". */
	key: string;
	/** Human label such as "5h" or "Weekly". */
	label: string;
	/** Canonical percentage consumed, 0 to 100. Adapters convert remaining fractions here. */
	usedPct: number;
	/** ISO 8601 instant the window resets, or null when the provider omitted it. */
	resetsAt: string | null;
	/** Compact label for a narrow surface such as a footer indicator. */
	short?: string;
	/** Model or product scope when the window covers less than the whole plan. */
	scope?: string;
	/** Provider-supplied severity word; Clio does not invent one. */
	severity?: string;
	/** True when the provider marks this window as the currently binding limit. */
	active?: boolean;
}

/** Prepaid credit balance for providers that bill credits instead of windows. */
export interface UsageCredits {
	display: string;
	usedPct: number | null;
}

/** Everything one provider reported about quota at a single point in time. */
export interface UsageSnapshot {
	providerId: string;
	displayName: string;
	status: QuotaStatus;
	windows: UsageWindow[];
	credits?: UsageCredits | null;
	plan?: string | null;
	message?: string | null;
	/** Seconds to wait, captured from a 429 `Retry-After` header. */
	retryAfterSeconds?: number | null;
	/** True when the snapshot is a cached last-good value rather than a fresh read. */
	stale?: boolean;
	/** ISO 8601 instant of the read that produced this snapshot. */
	fetchedAt: string | null;
}

/**
 * One runtime's quota adapter. Implementations stay pure data plumbing:
 * no UI, no dispatch admission, no credential writes.
 */
export interface QuotaProvider {
	id: string;
	displayName: string;
	/** True when usable credentials are present, without spending a network call. */
	detect(): Promise<boolean>;
	/** Read current usage, reporting failure as a snapshot status rather than throwing. */
	fetch(): Promise<UsageSnapshot>;
}

/** Parse a numeric `Retry-After` value into non-negative seconds. */
export function parseRetryAfterSeconds(value: string | null | undefined): number | null {
	if (!value) return null;
	const seconds = Number.parseFloat(value.trim());
	if (!Number.isFinite(seconds)) return null;
	return Math.max(0, seconds);
}

/** Turn a raw plan identifier such as "max_5x" into a display plan such as "Max 5X". */
export function formatPlan(value: string | null | undefined): string | null {
	if (!value) return null;
	const words = value.replace(/_/g, " ").trim();
	if (!words) return null;
	return words.replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}
