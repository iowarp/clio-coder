/**
 * Lease clocks (DESIGN 4.5, fleet M12): the one rule every dispatch lease and lease-like record follows, for capacity
 * leases, main cache lanes, the capacity drain, reservations and the checkout's writer set.
 *
 * - Persisted instants (`acquiredAt`, `heartbeatAt`, `expiresAt` and the settlement stamps) are canonical UTC ISO
 *   strings from `leaseInstant`, taken from the writer's wall clock. No record persists a duration in their place.
 * - A record lives until its `expiresAt`. A holder that heartbeats rewrites `heartbeatAt` and `expiresAt` together
 *   through `leaseRenewal`, every `LEASE_HEARTBEAT_MS`, for `LEASE_TTL_MS`.
 * - A reader judges a record another process wrote on its own wall clock with `leaseLapsed`. A record its own host
 *   wrote shares that clock and lapses at `expiresAt`. A record another host wrote lapses only `LEASE_CLOCK_SKEW_MS`
 *   later, so a reader whose clock runs ahead never takes a live holder's record. A record that names no holder (the
 *   drain) protects no process and lapses at its expiry everywhere.
 * - A span that starts and ends in one process (a queued join, a prefix hold, a deadline the process sets for itself)
 *   is measured with `performance.now()`, never by subtracting two wall-clock reads.
 */

/** How often a holder renews its lease; capacity leases and the writer set share it. */
export const LEASE_HEARTBEAT_MS = 10_000;
/** How long one renewal keeps a lease; three missed beats lapse it. Capacity leases and the writer set share it. */
export const LEASE_TTL_MS = 30_000;
/** How far apart the clocks of two hosts sharing a state directory may run before a live record reads as lapsed. */
export const LEASE_CLOCK_SKEW_MS = 60_000;

if (LEASE_HEARTBEAT_MS * 2 >= LEASE_TTL_MS)
	throw new Error("dispatch: a lease TTL must span more than two heartbeats, so one missed beat never lapses it");

/** The persisted form of a wall-clock instant. */
export function leaseInstant(ms: number): string {
	return new Date(ms).toISOString();
}

/** True for a canonical instant `leaseInstant` wrote; anything else is an invalid record. */
export function isLeaseInstant(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const ms = Date.parse(value);
	return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

/** The stamps one renewal writes. */
export function leaseRenewal(nowMs: number, ttlMs = LEASE_TTL_MS): { heartbeatAt: string; expiresAt: string } {
	return { heartbeatAt: leaseInstant(nowMs), expiresAt: leaseInstant(nowMs + ttlMs) };
}

/**
 * Whether a record has lapsed at `nowMs`, this reader's wall clock. `foreign` is true when another host wrote it, so
 * the skew tolerance applies. An unreadable expiry has lapsed.
 */
export function leaseLapsed(expiresAt: unknown, nowMs: number, foreign: boolean): boolean {
	const expiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
	if (!Number.isFinite(expiry)) return true;
	return nowMs >= expiry + (foreign ? LEASE_CLOCK_SKEW_MS : 0);
}
