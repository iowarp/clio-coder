/**
 * Per-route circuit breaker for dispatch targets.
 *
 * A route is one (target, runtime, wire model) key. It starts closed. Each
 * breaker-affecting failure adds to a consecutive-failure count, and the count
 * reaching the threshold opens the route for the base cooldown. When the
 * cooldown expires the route is half-open: the next dispatch that asks to run
 * on it is admitted as the probe, and every other dispatch still sees the route
 * as cooling until the probe reports. A probe success closes the route and
 * resets both the count and the backoff. A probe failure reopens it with the
 * cooldown doubled, capped at the larger of MAX_TARGET_BREAKER_COOLDOWN_MS and
 * the base cooldown.
 *
 * The state is process-local and in memory, so it is timed on the injected
 * monotonic clock rather than the wall clock.
 */

/** Ceiling for the doubled probe-failure cooldown: five minutes. */
export const MAX_TARGET_BREAKER_COOLDOWN_MS = 300_000;

export type TargetBreakerBlock =
	| { kind: "open"; remainingMs: number; reason: string }
	| { kind: "probing"; reason: string };

export type TargetBreakerOutcome = "success" | "failure" | "neutral";

export interface TargetBreakerOptions {
	monotonicNow: () => number;
	/** Base cooldown in ms; zero or less disables tripping. */
	cooldownMs: () => number;
	/** Consecutive breaker-affecting failures that open a closed route. */
	threshold: () => number;
	maxCooldownMs?: number;
}

export interface TargetBreaker {
	/** Read-only view: why a dispatch could not use the route now, or null. */
	blocked(key: string): TargetBreakerBlock | null;
	/** Admission: like blocked(), but a half-open route is claimed as owner's probe. */
	admit(key: string, owner: string): TargetBreakerBlock | null;
	/** Give back a probe claim whose dispatch never started. */
	release(key: string, owner: string): void;
	/** Fold one run's outcome into the route. owner is the finished run's id. */
	record(key: string, owner: string, outcome: TargetBreakerOutcome, reason: string): void;
}

interface RouteState {
	failures: number;
	/** Present once the route has tripped; absent while closed. */
	open: { until: number; cooldownMs: number; reason: string; probeOwner: string | null } | null;
}

export function createTargetBreaker(options: TargetBreakerOptions): TargetBreaker {
	const routes = new Map<string, RouteState>();
	const maxCooldownMs = options.maxCooldownMs ?? MAX_TARGET_BREAKER_COOLDOWN_MS;

	function blockOf(state: RouteState | undefined, owner: string | null): TargetBreakerBlock | null {
		const open = state?.open;
		if (!open) return null;
		const remainingMs = open.until - options.monotonicNow();
		if (remainingMs > 0) return { kind: "open", remainingMs, reason: open.reason };
		if (open.probeOwner === null) {
			if (owner !== null) open.probeOwner = owner;
			return null;
		}
		if (open.probeOwner === owner) return null;
		return { kind: "probing", reason: open.reason };
	}

	return {
		blocked: (key) => blockOf(routes.get(key), null),
		admit: (key, owner) => blockOf(routes.get(key), owner),
		release(key, owner) {
			const open = routes.get(key)?.open;
			if (open && open.probeOwner === owner) open.probeOwner = null;
		},
		record(key, owner, outcome, reason) {
			const state = routes.get(key);
			if (outcome === "success") {
				routes.delete(key);
				return;
			}
			const probe = state?.open?.probeOwner === owner ? state.open : null;
			if (outcome === "neutral") {
				// A failure that says nothing about the target proves neither health
				// nor sickness. A probe that ended this way frees the slot so the next
				// dispatch can probe instead of the route waiting forever.
				if (probe) probe.probeOwner = null;
				return;
			}
			const baseMs = options.cooldownMs();
			if (baseMs <= 0) return;
			const now = options.monotonicNow();
			if (probe) {
				probe.cooldownMs = Math.min(probe.cooldownMs * 2, Math.max(maxCooldownMs, baseMs));
				probe.until = now + probe.cooldownMs;
				probe.reason = reason;
				probe.probeOwner = null;
				return;
			}
			if (state?.open) {
				// A run admitted before the route tripped failed late. It re-arms the
				// window at the current backoff without doubling it and leaves any
				// probe in flight to decide the route.
				state.open.until = Math.max(state.open.until, now + state.open.cooldownMs);
				state.open.reason = reason;
				return;
			}
			const next: RouteState = state ?? { failures: 0, open: null };
			next.failures += 1;
			if (next.failures >= Math.max(1, options.threshold())) {
				next.open = { until: now + baseMs, cooldownMs: baseMs, reason, probeOwner: null };
			}
			routes.set(key, next);
		},
	};
}
