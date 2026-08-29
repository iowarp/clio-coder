import {
	type BackendCacheVerdict,
	type BackendCompletionTimings,
	type CacheVerdictCounts,
	emptyCacheVerdictCounts,
	uncachedPrefillTokens,
} from "../../core/cache-telemetry.js";
import type { SessionEntry } from "./entries.js";

/** Durable prompt-cache facts folded across assistant calls in one ledger slice. */
export interface PromptCacheTelemetry {
	/** Sum of authoritative backend prefill work, or null when no call reported cache reads. */
	uncachedPrefillTokens: number | null;
	/** Calls contributing to `uncachedPrefillTokens`; distinguishes no evidence from a measured zero. */
	uncachedPrefillCalls: number;
	/** Counts of the verdict persisted on each assistant call. */
	verdictCounts: CacheVerdictCounts;
	/** Number of assistant calls carrying a recognized persisted verdict. */
	verdictCalls: number;
	/** How often each expected cache disturbance was stamped. */
	expectedColdReasonCounts: Readonly<Record<string, number>>;
}

export interface ExpectedColdReasonCount {
	reason: string;
	count: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function backendTimings(value: unknown): BackendCompletionTimings | null {
	if (!isRecord(value)) return null;
	if (
		!finiteNonNegative(value.promptTokens) ||
		!finiteNonNegative(value.predictedTokens) ||
		!finiteNonNegative(value.promptMs) ||
		!finiteNonNegative(value.predictedMs) ||
		(value.source !== "llamacpp-timings" && value.source !== "lmstudio-timings")
	) {
		return null;
	}
	const cachedTokens = value.cachedTokens;
	if (cachedTokens !== null && !finiteNonNegative(cachedTokens)) return null;
	if (typeof cachedTokens === "number" && cachedTokens > value.promptTokens) return null;
	return {
		promptTokens: value.promptTokens,
		cachedTokens,
		predictedTokens: value.predictedTokens,
		promptMs: value.promptMs,
		predictedMs: value.predictedMs,
		source: value.source,
	};
}

function cacheVerdict(value: unknown): BackendCacheVerdict | null {
	switch (value) {
		case "hot":
		case "partial":
		case "cold":
		case "small":
			return value;
		default:
			return null;
	}
}

/** True when the fold contains at least one durable cache fact. */
export function hasPromptCacheTelemetry(telemetry: PromptCacheTelemetry): boolean {
	return (
		telemetry.verdictCalls > 0 ||
		telemetry.uncachedPrefillCalls > 0 ||
		Object.keys(telemetry.expectedColdReasonCounts).length > 0
	);
}

/** Most frequent expected disturbance, with deterministic lexical tie-breaking. */
export function topExpectedColdReason(telemetry: PromptCacheTelemetry): ExpectedColdReasonCount | null {
	const ranked = Object.entries(telemetry.expectedColdReasonCounts).sort(
		([leftReason, leftCount], [rightReason, rightCount]) =>
			rightCount - leftCount || leftReason.localeCompare(rightReason),
	);
	const first = ranked[0];
	return first === undefined ? null : { reason: first[0], count: first[1] };
}

/**
 * Fold persisted assistant `promptCache` payloads without reclassifying them.
 * Callers provide the ledger slice they mean, such as one active branch or one
 * report window, so every surface shares parsing while retaining its own scope.
 */
export function foldPromptCacheTelemetry(entries: ReadonlyArray<SessionEntry>): PromptCacheTelemetry {
	const verdictCounts = emptyCacheVerdictCounts();
	const expectedColdReasonCounts: Record<string, number> = {};
	let verdictCalls = 0;
	let uncachedTotal = 0;
	let uncachedPrefillCalls = 0;

	for (const entry of entries) {
		if (entry.kind !== "message" || entry.role !== "assistant" || !isRecord(entry.payload)) continue;
		const promptCache = entry.payload.promptCache;
		if (!isRecord(promptCache)) continue;

		const verdict = cacheVerdict(promptCache.backendVerdict);
		if (verdict !== null) {
			verdictCounts[verdict] += 1;
			verdictCalls += 1;
		}

		const backend = backendTimings(promptCache.backend);
		const uncached = uncachedPrefillTokens(backend);
		if (uncached !== null) {
			uncachedTotal += uncached;
			uncachedPrefillCalls += 1;
		}

		if (!Array.isArray(promptCache.expectedColdReasons)) continue;
		const reasons = new Set(
			promptCache.expectedColdReasons.filter(
				(reason): reason is string => typeof reason === "string" && reason.trim().length > 0,
			),
		);
		for (const reason of reasons) {
			expectedColdReasonCounts[reason] = (expectedColdReasonCounts[reason] ?? 0) + 1;
		}
	}

	return {
		uncachedPrefillTokens: uncachedPrefillCalls > 0 ? uncachedTotal : null,
		uncachedPrefillCalls,
		verdictCounts,
		verdictCalls,
		expectedColdReasonCounts,
	};
}
