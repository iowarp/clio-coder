import type { ProvidersContract } from "../providers/contract.js";

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
