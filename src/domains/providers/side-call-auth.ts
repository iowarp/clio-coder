import type { SideCallAuth } from "../../core/oauth-retry.js";
import { targetRequiresAuth } from "./auth/storage.js";
import type { ProvidersContract } from "./contract.js";
import type { RuntimeDescriptor } from "./types/runtime-descriptor.js";
import type { TargetDescriptor } from "./types/target-descriptor.js";

/** Bind side-call refresh to the credential actually sent, never an API key (#427). */
export async function resolveSideCallAuth(
	auth: ProvidersContract["auth"],
	target: TargetDescriptor,
	runtime: RuntimeDescriptor,
	fallback: string,
	signal?: AbortSignal,
): Promise<SideCallAuth> {
	if (!targetRequiresAuth(target, runtime)) return { apiKey: fallback };
	const resolved = await auth.resolveForTarget(target, runtime, signal ? { signal } : undefined);
	return {
		...(!resolved.available || resolved.apiKey === undefined ? {} : { apiKey: resolved.apiKey }),
		...(!resolved.available || resolved.source !== "stored-oauth" || resolved.apiKey === undefined
			? {}
			: {
					refreshApiKey: async (rejectedApiKey: string) => {
						signal?.throwIfAborted();
						try {
							const refreshed = await auth.resolveForTarget(target, runtime, {
								rejectedApiKey,
								...(signal ? { signal } : {}),
							});
							if (!refreshed.available || refreshed.apiKey === undefined) throw new Error("OAuth refresh failed");
							return refreshed.apiKey;
						} catch {
							signal?.throwIfAborted();
							// Keep provider refresh diagnostics out of the login remedy (#427).
							throw new Error(
								`OAuth credential for target '${target.id}' could not be refreshed. Run clio-coder auth login ${resolved.providerId} again.`,
							);
						}
					},
				}),
	};
}
