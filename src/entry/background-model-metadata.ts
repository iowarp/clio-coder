import type { ProvidersContract } from "../domains/providers/contract.js";

/** Cold gateway roles need their own declared model controls before synthesis.
 * Read metadata only; an unknown/mixed successful probe remains authoritative.
 * Memory supplies its existing deadline/generation signal, including auth.
 */
export async function prepareBackgroundModelMetadata(
	providers: ProvidersContract,
	targetId: string,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	const status = providers.list().find((entry) => entry.target.id === targetId);
	if (status?.target.runtime === "litellm" && status.health.lastCheckAt === null) {
		await providers.probeTarget(targetId, { reasoning: false, ...(signal ? { signal } : {}) });
	}
	signal?.throwIfAborted();
}
