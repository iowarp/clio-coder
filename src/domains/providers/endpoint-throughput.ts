/**
 * The newest prefill and generation rate each endpoint measured.
 *
 * llama.cpp and LM Studio attach their own prefill and prediction timings to a
 * completion. A chat turn and a background memory step on the same endpoint
 * both report them here, so the memory budget can size a step's deadline from
 * how fast the server actually is. Process-local on purpose: a rate another
 * process measured, or one from before the server restarted, is not evidence.
 */

import type { BackendCompletionTimings } from "../../core/cache-telemetry.js";
import { uncachedPrefillTokens } from "../../core/cache-telemetry.js";

export interface EndpointThroughput {
	/** Newly evaluated prompt tokens per second, or null before a prefill was measured. */
	prefillTokensPerSecond: number | null;
	/** Generated tokens per second, or null before a generation was measured. */
	generationTokensPerSecond: number | null;
}

const measured = new Map<string, EndpointThroughput>();

function rate(tokens: number, ms: number): number | null {
	return Number.isFinite(tokens) && Number.isFinite(ms) && tokens > 0 && ms > 0 ? (tokens * 1000) / ms : null;
}

/** Keep the newest rate of each phase; a call that measured one phase leaves the other as it was. */
export function recordEndpointThroughput(
	endpointKey: string | null,
	backend: BackendCompletionTimings | null | undefined,
): void {
	if (endpointKey === null || backend === null || backend === undefined) return;
	const previous = measured.get(endpointKey);
	// A fully cached prompt evaluated nothing, so it says nothing about prefill speed.
	const prefill = rate(uncachedPrefillTokens(backend) ?? backend.promptTokens, backend.promptMs);
	const generation = rate(backend.predictedTokens, backend.predictedMs);
	if (prefill === null && generation === null) return;
	measured.set(endpointKey, {
		prefillTokensPerSecond: prefill ?? previous?.prefillTokensPerSecond ?? null,
		generationTokensPerSecond: generation ?? previous?.generationTokensPerSecond ?? null,
	});
}

export function endpointThroughput(endpointKey: string | null): EndpointThroughput | null {
	return endpointKey === null ? null : (measured.get(endpointKey) ?? null);
}
