/**
 * What both engine kinds need from the providers domain: a credential and a
 * readable failure.
 */

import type { ProvidersContract } from "../../providers/contract.js";
import type { RuntimeDescriptor } from "../../providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../providers/types/target-descriptor.js";

export type EngineAuth = Partial<Pick<ProvidersContract, "auth">>["auth"];

export interface LlmRequestUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly cacheWrite1h?: number;
	readonly reasoning?: number;
	readonly totalTokens?: number;
	readonly costUsd?: number;
}

/** Admission captures the originating session and returns its per-request accounting sink. */
export type LlmRequestAdmission = (request: {
	readonly targetId: string;
	readonly model: string;
	readonly signal: AbortSignal;
}) => Promise<(usage: LlmRequestUsage | null) => void>;

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
