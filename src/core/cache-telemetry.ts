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
	| "none"
	| "tool_choice_changed"
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
	/** #423: none is within the reuse band; unknown is an unattributed break. */
	cause: CacheBreakCause;
	causeBasis: "provider" | "host" | "inferred";
	idleMs: number | null;
	ttl: { ms: number | null; source: "declared" | "unknown" };
	providerDiagnostic?: { provider: string; type: string; missedInputTokens?: number };
	comparisonId?: string;
	changedSection?: string;
	requestFingerprint?: CacheRequestFingerprint;
	transport?: CacheCallTransport;
}

/** How the call physically reached the provider, as persisted on the observation (#423). */
export interface CacheCallTransport {
	mode: "websocket" | "sse" | "http" | "unknown";
	request: "full" | "delta" | "unknown";
	reason?: string;
}

/** What the route and the transport knew about the call before its usage arrived (#423). */
export interface CacheCallRoute {
	/** The cache lifetime the route declares, null when none is known. */
	ttlMs: number | null;
	transport?: CacheCallTransport & {
		/** The call reset its transport session before sending, so its full frame is a recovery, not an append. */
		recovery?: boolean;
	};
}

export interface CacheRequestFingerprint {
	targetId: string;
	modelId: string;
	thinkingLevel: string;
	toolChoice: string;
	replayTruncationHash?: string;
}

export interface CacheCallBaseline {
	inclusiveInputTokens: number;
	endedAt: number;
	requestFingerprint?: CacheRequestFingerprint;
	/** How the previous call reached the provider; a full frame after a delta is a continuation reset. */
	transportRequest?: CacheCallTransport["request"];
}

/** #423: keep provider usage unchanged and compare only within one context generation. */
export function buildCacheCallObservation(
	usage: { input: number; cacheRead: number; cacheWrite: number },
	previous: CacheCallBaseline | null,
	hostColdReasons: readonly string[],
	now: number,
	requestFingerprint?: CacheRequestFingerprint,
	route?: CacheCallRoute,
): CacheCallObservation {
	const hostCauses: Readonly<Record<string, CacheBreakCause>> = {
		model_changed: "model_changed",
		tool_choice_change: "tool_choice_changed",
		input_changed: "input_changed",
		thinking_change: "reasoning_changed",
		tool_surface_change: "tools_changed",
		prompt_recompiled: "prompt_recompiled",
		compaction: "compaction",
		working_set_evict: "working_set_evict",
	};
	const expected = previous?.inclusiveInputTokens ?? null;
	const shortfall = expected === null ? null : Math.max(0, expected - usage.cacheRead);
	// #423: healthy appends lost 91–849 tokens at the provider's 128-token boundaries.
	// Require both >1,024 lost tokens and >10% loss before declaring a break.
	const broke = expected !== null && shortfall !== null && shortfall > 1_024 && usage.cacheRead < 0.9 * expected;
	const prior = previous?.requestFingerprint;
	const fingerprintCause =
		prior && requestFingerprint
			? prior.targetId !== requestFingerprint.targetId || prior.modelId !== requestFingerprint.modelId
				? "model_changed"
				: prior.thinkingLevel !== requestFingerprint.thinkingLevel
					? "reasoning_changed"
					: prior.replayTruncationHash !== requestFingerprint.replayTruncationHash
						? "input_changed"
						: prior.toolChoice !== requestFingerprint.toolChoice
							? "tool_choice_changed"
							: undefined
			: undefined;
	const reason = hostColdReasons.find((candidate) => hostCauses[candidate] !== undefined);
	const hostCause = fingerprintCause ?? (reason === undefined ? undefined : hostCauses[reason]);
	const idleMs = previous === null ? null : Math.max(0, now - previous.endedAt);
	const ttlMs = route?.ttlMs !== undefined && route.ttlMs !== null && route.ttlMs > 0 ? route.ttlMs : null;
	// A host-known change is certain; the entry outliving its lifetime is likely; a full frame after a delta or a
	// transport recovery means the continuation was rebuilt, which is all the host can say about the bytes it sent.
	const idleExpired = idleMs !== null && ttlMs !== null && idleMs >= ttlMs;
	const transportReset =
		route?.transport?.request === "full" && (previous?.transportRequest === "delta" || route.transport.recovery === true);
	const cause: CacheBreakCause | undefined =
		hostCause ?? (idleExpired ? "idle_expiry" : transportReset ? "transport_reset" : undefined);
	const transport = route?.transport
		? {
				mode: route.transport.mode,
				request: route.transport.request,
				...(route.transport.reason ? { reason: route.transport.reason } : {}),
			}
		: undefined;
	return {
		expectedCachedTokens: expected,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		inclusiveInputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
		shortfallTokens: shortfall,
		cause: broke ? (cause ?? "unknown") : "none",
		causeBasis: broke && cause !== undefined && cause !== "idle_expiry" ? "host" : "inferred",
		...(requestFingerprint ? { requestFingerprint } : {}),
		idleMs,
		ttl: ttlMs === null ? { ms: null, source: "unknown" } : { ms: ttlMs, source: "declared" },
		...(transport ? { transport } : {}),
	};
}
