import { prepareListedModelCapabilities } from "../providers/background-model-metadata.js";
import { PROVIDER_PROBE_TIMEOUT_MS, type ProvidersContract } from "../providers/contract.js";

/**
 * Every worker route passes here before its route is chosen. A runtime whose
 * listing carries per-model capabilities (Copilot) lists once from a cold
 * cache whichever surface dispatched it: a tool call, `run --agent` or a
 * playbook step. The listing names the account's model ids, so a requested id
 * canonicalizes against it from the start instead of changing under the route.
 * A failed or slow listing keeps resolution's fallback instead of refusing.
 */
export async function prepareWorkerModelListing(
	providers: ProvidersContract,
	selectTargetId: () => string | null,
	deadlineAt: number,
	signal?: AbortSignal,
	now: () => number = Date.now,
): Promise<void> {
	signal?.throwIfAborted();
	const cold = providers
		.list()
		.some(
			(status) =>
				providers.getRuntime(status.target.runtime)?.listsModelCapabilities === true &&
				Object.keys(status.probeModelCapabilities ?? {}).length === 0,
		);
	if (!cold) return;
	const targetId = selectTargetId();
	const remainingMs = deadlineAt - now();
	if (targetId === null || remainingMs <= 0) return;
	await prepareListedModelCapabilities(providers, targetId, Math.min(remainingMs, PROVIDER_PROBE_TIMEOUT_MS), signal);
	signal?.throwIfAborted();
}

/** Preparation owns its wait; a late HTTP body cannot start an expired worker. */
export async function prepareWorkerModelMetadata(
	providers: ProvidersContract,
	targetId: string,
	deadlineAt: number,
	signal?: AbortSignal,
	now: () => number = Date.now,
): Promise<void> {
	signal?.throwIfAborted();
	const status = providers.list().find((entry) => entry.target.id === targetId);
	if (status?.target.runtime !== "litellm" || status.health.lastCheckAt !== null) return;
	const remainingMs = deadlineAt - now();
	const deadlineError = new Error("dispatch: admission deadline expired during worker model metadata preparation");
	if (remainingMs <= 0) throw deadlineError;
	const controller = new AbortController();
	const abort = (): void => controller.abort(signal?.reason);
	signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => controller.abort(deadlineError), Math.min(remainingMs, 2_147_483_647));
	let rejectAborted!: (reason: unknown) => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAborted = reject;
	});
	const onAbort = (): void => rejectAborted(controller.signal.reason);
	controller.signal.addEventListener("abort", onAbort, { once: true });
	try {
		// The provider also fences publication after each await. Promise.race
		// observes the probe's eventual rejection if an HTTP body settles late.
		await Promise.race([providers.probeTarget(targetId, { reasoning: false, signal: controller.signal }), aborted]);
		controller.signal.throwIfAborted();
		if (now() >= deadlineAt) throw deadlineError;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		controller.signal.removeEventListener("abort", onAbort);
	}
}
