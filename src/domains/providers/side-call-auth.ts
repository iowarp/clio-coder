import type { SideCallAuth } from "../../core/oauth-retry.js";
import { targetRequiresAuth } from "./auth/storage.js";
import type { ProvidersContract } from "./contract.js";
import type { RuntimeDescriptor } from "./types/runtime-descriptor.js";
import type { TargetDescriptor } from "./types/target-descriptor.js";

/**
 * pi-ai's openai-completions provider refuses to stream without an apiKey even
 * when the target is a local server that ignores the Authorization header
 * entirely. The chat loop, the dispatch workers, and the background memory
 * model all send this placeholder so a local llama.cpp or LM Studio endpoint
 * works without the user inventing a credential.
 */
export const LOCAL_API_KEY_FALLBACK = "clio-coder-local-target";

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
	// Streaming on with no key would let the engine's env fallback send the refused credential.
	if (resolved.refused) throw new Error(resolved.detail ?? `credential refused for target '${target.id}'`);
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
