/** Cache classification for one backend completion call. */
export type BackendCacheVerdict = "hot" | "partial" | "cold" | "small";

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
}

export function emptyCacheVerdictCounts(): CacheVerdictCounts {
	return { hot: 0, partial: 0, cold: 0, small: 0 };
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
