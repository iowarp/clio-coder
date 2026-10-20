/** Cache classification for one backend completion call. */
export type BackendCacheVerdict = "hot" | "partial" | "cold" | "small" | "unknown";

/** Backend timing source that directly reports local prefill work. */
export type BackendTimingsSource = "llamacpp-timings" | "lmstudio-timings";

/** Normalized prefill and prediction timings reported by the serving backend. */
export interface BackendCompletionTimings {
	promptTokens: number;
	cachedTokens: number | null;
	predictedTokens: number;
	promptMs: number;
	predictedMs: number;
	source: BackendTimingsSource;
}

/** Per-session call counts grouped by backend cache verdict. */
export interface CacheVerdictCounts {
	hot: number;
	partial: number;
	cold: number;
	small: number;
	unknown: number;
}

export function emptyCacheVerdictCounts(): CacheVerdictCounts {
	return { hot: 0, partial: 0, cold: 0, small: 0, unknown: 0 };
}

/** Return newly evaluated prefill tokens when the backend reports cache reads. */
export function uncachedPrefillTokens(backend: BackendCompletionTimings | null | undefined): number | null {
	if (backend === null || backend === undefined || backend.cachedTokens === null) return null;
	if (
		!Number.isFinite(backend.promptTokens) ||
		backend.promptTokens < 0 ||
		!Number.isFinite(backend.cachedTokens) ||
		backend.cachedTokens < 0 ||
		backend.cachedTokens > backend.promptTokens
	) {
		return null;
	}
	return backend.promptTokens - backend.cachedTokens;
}

export type CacheBreakCause =
	| "prompt_recompiled"
	| "reasoning_changed"
	| "tools_changed"
	| "input_changed"
	| "compaction"
	| "working_set_evict"
	| "model_changed"
	| "transport_reset"
	| "idle_expiry"
	| "unknown";

export interface CacheCallObservation {
	expectedCachedTokens: number | null;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	inclusiveInputTokens: number;
	shortfallTokens: number | null;
	/** #423: unknown also represents calls with no attributed break; inspect shortfall first. */
	cause: CacheBreakCause;
	causeBasis: "provider" | "host" | "inferred";
	idleMs: number | null;
	ttl: { ms: number | null; source: "declared" | "unknown" };
	providerDiagnostic?: { provider: string; type: string; missedInputTokens?: number };
	comparisonId?: string;
	transport?: { mode: "websocket" | "sse" | "http"; request: "full" | "delta" | "unknown"; reason?: string };
}

export interface CacheCallBaseline {
	inclusiveInputTokens: number;
	endedAt: number;
}

/** #423: keep provider usage unchanged and compare only within one context generation. */
export function buildCacheCallObservation(
	usage: { input: number; cacheRead: number; cacheWrite: number },
	previous: CacheCallBaseline | null,
	hostColdReasons: readonly string[],
	now: number,
): CacheCallObservation {
	const hostCauses: Readonly<Record<string, CacheBreakCause>> = {
		thinking_change: "reasoning_changed",
		tool_surface_change: "tools_changed",
		prompt_recompiled: "prompt_recompiled",
		compaction: "compaction",
		working_set_evict: "working_set_evict",
	};
	const reason = hostColdReasons[0];
	return {
		expectedCachedTokens: previous?.inclusiveInputTokens ?? null,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		inclusiveInputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
		shortfallTokens: previous === null ? null : Math.max(0, previous.inclusiveInputTokens - usage.cacheRead),
		cause: reason === undefined ? "unknown" : (hostCauses[reason] ?? "unknown"),
		causeBasis: reason === undefined ? "inferred" : "host",
		idleMs: previous === null ? null : Math.max(0, now - previous.endedAt),
		ttl: { ms: null, source: "unknown" },
	};
}
