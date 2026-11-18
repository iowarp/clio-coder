import { PROVIDER_PROBE_TIMEOUT_MS, type ProvidersContract } from "./contract.js";

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

/**
 * A runtime whose listing carries per-model capabilities (Copilot) has none to
 * resolve against until it lists, so a worker resolved from a cold or legacy
 * listing cache would run with no reasoning and no budgets. List it once,
 * bounded by the probe timeout; on failure resolution keeps today's fallback.
 */
export async function prepareListedModelCapabilities(
	providers: ProvidersContract,
	targetId: string,
	timeoutMs: number = PROVIDER_PROBE_TIMEOUT_MS,
): Promise<void> {
	const status = providers.list().find((entry) => entry.target.id === targetId);
	if (!status || providers.getRuntime(status.target.runtime)?.listsModelCapabilities !== true) return;
	if (Object.keys(status.probeModelCapabilities ?? {}).length > 0) return;
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<void>((resolve) => {
		timer = setTimeout(() => {
			controller.abort(new Error(`model listing exceeded ${timeoutMs}ms`));
			resolve();
		}, timeoutMs);
	});
	try {
		await Promise.race([
			providers.probeTarget(targetId, { reasoning: false, signal: controller.signal }).catch(() => null),
			expired,
		]);
	} finally {
		clearTimeout(timer);
	}
}
