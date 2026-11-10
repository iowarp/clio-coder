/**
 * What both engine kinds need from the providers domain: a credential and a
 * readable failure.
 */

import type { ProvidersContract } from "../../providers/contract.js";
import type { LlmRequestAdmission } from "../../providers/one-shot.js";
import type { RuntimeDescriptor } from "../../providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../providers/types/target-descriptor.js";

export type EngineAuth = Partial<Pick<ProvidersContract, "auth">>["auth"];

export interface EngineHost {
	readonly auth: EngineAuth;
	readonly credentialsPresent: () => ReadonlySet<string>;
	readonly admitLlmRequest?: LlmRequestAdmission;
}

/**
 * Resolved per call rather than at construction, so a rotated key reaches the
 * next question without restarting the session. A failure means no token: the
 * request goes out unauthenticated and the server's answer says why. A refusal
 * is not a failure: it throws, because "no token" lets the runtime fill the
 * operator's environment key in for a project-chosen URL.
 */
export async function resolveToken(
	host: EngineHost,
	target: TargetDescriptor,
	runtime: RuntimeDescriptor,
	signal: AbortSignal,
): Promise<string | undefined> {
	if (host.auth === undefined) return undefined;
	let resolution: Awaited<ReturnType<NonNullable<EngineAuth>["resolveForTarget"]>>;
	try {
		resolution = await host.auth.resolveForTarget(target, runtime, { signal });
	} catch {
		// A credential store that cannot answer is the same as no credential; the
		// request still fails visibly at the server if one was required.
		return undefined;
	}
	if (resolution.refused) throw new Error(resolution.detail ?? `credential refused for target '${target.id}'`);
	return resolution.apiKey ?? undefined;
}

export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
