/**
 * Read-only data model for provider subscription quota.
 *
 * The shapes mirror QuotaBubble's `providers/base.py` (`ProviderStatus`,
 * `UsageWindow`, `UsageSnapshot`) so that adapters written against either
 * project describe the same usage facts. Timestamps are ISO 8601 strings
 * rather than `Date` objects so a snapshot stays structurally cloneable
 * across the worker and transport boundaries.
 */

import { createHash } from "node:crypto";
import type { EconomyUnit } from "../../core/telemetry/economy.js";
import type { QuotaAccess, QuotaOverage, QuotaQualification } from "../../core/telemetry/schemas.js";

export type { QuotaAccess, QuotaOverage, QuotaQualification };

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
	/** The native unit the window counts, as the provider reported it; `percent` for a bare percentage. */
	unit?: EconomyUnit;
	/** The window's length as the provider reported it; never inferred from a label. */
	durationSeconds?: number;
	/** The provider's own allow or deny status for this window, when it states one per window. */
	access?: QuotaAccess;
	/** How far the provider qualified the window's quantities, when it says. */
	qualification?: QuotaQualification;
}

/**
 * A window the provider reported without an authoritative pair to take a percentage from: an unlimited bucket, an
 * advisory balance, an admission verdict. It keeps its unit, reset and status and never carries a made-up percent.
 */
export interface UsageAllowance extends Omit<UsageWindow, "usedPct" | "severity" | "active"> {
	/** The provider reported no limit. */
	unlimited?: true;
}

/** Prepaid credit balance for providers that bill credits instead of windows. */
export interface UsageCredits {
	display: string;
	usedPct: number | null;
	/** The unit `display` counts, when the provider names one; a balance without one is never currency. */
	unit?: EconomyUnit;
}

/** Everything one provider reported about quota at a single point in time. */
export interface UsageSnapshot {
	providerId: string;
	displayName: string;
	status: QuotaStatus;
	windows: UsageWindow[];
	/** Windows without a percentage (see UsageAllowance); journaled beside `windows`, never shown as a percent. */
	allowances?: UsageAllowance[];
	credits?: UsageCredits | null;
	plan?: string | null;
	message?: string | null;
	/** #423: subscription facts from sanitized Anthropic inference response headers. */
	rateLimit?: Readonly<Record<string, string>>;
	representativeClaim?: string | null;
	/** Seconds to wait, captured from a 429 `Retry-After` header. */
	retryAfterSeconds?: number | null;
	/** True when the snapshot is a cached last-good value rather than a fresh read. */
	stale?: boolean;
	/** ISO 8601 instant of the read that produced this snapshot. */
	fetchedAt: string | null;
	/**
	 * The funding pool this reading belongs to: a keyed pseudonym of the provider's stable billing identity
	 * (`pool-reading.ts`), absent when the adapter has no verified identity to key it on.
	 */
	accountPseudonym?: string;
	/** The provider's deny status for the whole pool; absent reads as unknown. A full window alone is not a denial. */
	access?: QuotaAccess;
	/** Whether the provider will bill past the included allowance, where it states so. */
	overage?: QuotaOverage;
	/** The pool-wide reset the provider reported, apart from any window's own reset. */
	resetsAt?: string | null;
}

/**
 * One runtime's quota adapter. Implementations stay pure data plumbing:
 * no UI, no dispatch admission, no credential writes.
 */
export interface QuotaProvider {
	id: string;
	displayName: string;
	/**
	 * The usage endpoint this adapter reads, when another adapter reads the same one. The cache polls adapters that
	 * share an endpoint one at a time, each turn bounded so a hung adapter cannot block its sibling.
	 */
	endpoint?: string;
	/**
	 * A non-secret fingerprint of the credential a read would spend (see credentialFingerprint), or null without one.
	 * Readings and held failures are scoped by it, so a login switch never serves another account's reading or hold.
	 * An adapter without it is never shared across processes.
	 */
	credentialScope?(): Promise<string | null>;
	/** True when usable credentials are present, without spending a network call. */
	detect(): Promise<boolean>;
	/** Read current usage, reporting failure as a snapshot status rather than throwing. */
	fetch(): Promise<UsageSnapshot>;
}

/**
 * A short one-way digest naming which credential an adapter holds, never the credential itself: 16 hex characters of
 * a domain-separated SHA-256, enough to tell two logins apart and useless for authenticating.
 */
export function credentialFingerprint(providerId: string, secret: string): string {
	return createHash("sha256").update(`quota-credential\0${providerId}\0${secret}`).digest("hex").slice(0, 16);
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
