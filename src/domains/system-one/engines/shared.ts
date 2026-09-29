/**
 * What both engine kinds need from the providers domain: a credential and a
 * readable failure.
 */

import type { ProvidersContract } from "../../providers/contract.js";
import type { RuntimeDescriptor } from "../../providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../providers/types/target-descriptor.js";

export type EngineAuth = Partial<Pick<ProvidersContract, "auth">>["auth"];

export interface EngineHost {
	readonly auth: EngineAuth;
	readonly credentialsPresent: () => ReadonlySet<string>;
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
