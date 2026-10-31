import { cacheBreakLoss } from "./telemetry/cache-break.js";

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

/** A request's cacheable structure, kept as digests so the journal can compare calls without holding text (#434). */
export interface CacheRequestStructure {
	/** The leading system prompt text. */
	system: string;
	/** The compiled prompt's ordered sections, present only when the leading prompt is exactly that compile. */
	sections?: ReadonlyArray<{ id: string; contentHash?: string }>;
	/** The leading tool declarations. */
	tools: string;
	/** Every later transcript entry, in the order the provider sends them. */
	entries: string[];
	/** An earlier call's reply rides in this request, so some call on this history came before it. */
	answered: boolean;
}

/**
 * #423: the first ordered prompt section whose id or bytes changed. Undefined when nothing changed or when the
 * earlier compile predates section hashes, which cannot attribute bytes.
 */
export function firstChangedSection(
	before: ReadonlyArray<{ id: string; contentHash?: string | undefined }>,
	after: ReadonlyArray<{ id: string; contentHash?: string | undefined }>,
): string | undefined {
	if (!before.every((section) => section.contentHash !== undefined)) return undefined;
	const count = Math.max(before.length, after.length);
	for (let index = 0; index < count; index += 1) {
		const prior = before[index];
		const next = after[index];
		if (prior?.id !== next?.id || prior?.contentHash !== next?.contentHash) return next?.id ?? prior?.id;
	}
	return undefined;
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
	/** Null when the provider omitted its cache-read count; an omitted read is never a zero read. */
	cacheReadTokens: number | null;
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

/**
 * #423: keep provider usage unchanged and compare only within one context generation. A cache read the provider
 * omitted leaves the shortfall unknown and infers no break (#434).
 */
export function buildCacheCallObservation(
	usage: { input: number; cacheRead: number | null; cacheWrite: number },
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
	const read = usage.cacheRead;
	const shortfall = expected === null || read === null ? null : Math.max(0, expected - read);
	const broke = expected !== null && shortfall !== null && cacheBreakLoss(shortfall, expected);
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
		inclusiveInputTokens: usage.input + (read ?? 0) + usage.cacheWrite,
		shortfallTokens: shortfall,
		cause: broke ? (cause ?? "unknown") : "none",
		causeBasis: broke && cause !== undefined && cause !== "idle_expiry" ? "host" : "inferred",
		...(requestFingerprint ? { requestFingerprint } : {}),
		idleMs,
		ttl: ttlMs === null ? { ms: null, source: "unknown" } : { ms: ttlMs, source: "declared" },
		...(transport ? { transport } : {}),
	};
}
