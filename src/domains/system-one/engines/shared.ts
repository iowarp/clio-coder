import type { CallObservation } from "../../../core/call-failure.js";
/**
 * What both engine kinds need from the providers domain: a credential and a
 * readable failure.
 */

import type { ProvidersContract } from "../../providers/contract.js";
import type { RuntimeDescriptor } from "../../providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../providers/types/target-descriptor.js";

export type EngineAuth = Partial<Pick<ProvidersContract, "auth">>["auth"];

export interface LlmRequestUsage {
	/** True only when fields were read directly from provider usage, including explicit zero (#434). */
	readonly providerReported?: boolean;
	readonly input: number;
	readonly output: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly cacheWrite1h?: number;
	readonly reasoning?: number;
	readonly totalTokens?: number;
	readonly costUsd?: number;
}

/**
 * The per-request accounting sink. `withContext` runs the request inside its journal call, so the engine seam marks
 * the send and a request that never left reads as never sent by its own stages (#429, #434).
 */
export type LlmRequestAccounting = ((usage: LlmRequestUsage | null, observation?: CallObservation) => void) & {
	readonly withContext?: <T>(work: () => T) => T;
};

/** Admission captures the originating session and returns its per-request accounting sink. */
export type LlmRequestAdmission = (request: {
	readonly targetId: string;
	readonly model: string;
	readonly signal: AbortSignal;
}) => Promise<LlmRequestAccounting>;

/** A refused request invalidates the whole decision, including answers from earlier requests. */
export class LlmAdmissionRefused extends Error {}

export interface EngineHost {
	readonly auth: EngineAuth;
	readonly credentialsPresent: () => ReadonlySet<string>;
	readonly admitLlmRequest?: LlmRequestAdmission;
}

/**
 * Resolved per call rather than at construction, so a rotated key reaches the
 * next question without restarting the session. A failure means no token: the
 * request goes out unauthenticated and the server's answer says why.
 */
export async function resolveToken(
	host: EngineHost,
	target: TargetDescriptor,
	runtime: RuntimeDescriptor,
	signal: AbortSignal,
): Promise<string | undefined> {
	if (host.auth === undefined) return undefined;
	try {
		const resolution = await host.auth.resolveForTarget(target, runtime, { signal });
		return resolution.apiKey ?? undefined;
	} catch {
		// A credential store that cannot answer is the same as no credential; the
		// request still fails visibly at the server if one was required.
		return undefined;
	}
}

export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
