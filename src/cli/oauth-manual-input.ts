import type { Interface as ReadlineInterface } from "node:readline/promises";

export interface DelayedManualCodeInput {
	onManualCodeInput: () => Promise<string>;
	cancel: () => void;
}

export function createDelayedManualCodeInput(
	rl: ReadlineInterface,
	prompt: string,
	options?: { delayMs?: number },
): DelayedManualCodeInput {
	const delayMs = Math.max(0, options?.delayMs ?? 10_000);
	let timer: NodeJS.Timeout | null = null;
	let abortController: AbortController | null = null;
	let pendingReject: ((error: Error) => void) | null = null;
	let started = false;
	let cancelled = false;

	return {
		onManualCodeInput: () =>
			new Promise<string>((resolve, reject) => {
				pendingReject = reject;
				const beginPrompt = (): void => {
					pendingReject = null;
					if (cancelled) {
						reject(new Error("cancelled"));
						return;
					}
					started = true;
					abortController = new AbortController();
					void rl
						.question(prompt, { signal: abortController.signal })
						.then((answer) => {
							resolve(answer.trim());
						})
						.catch((error: unknown) => {
							const next = error instanceof Error && error.name === "AbortError" ? new Error("cancelled") : error;
							reject(next instanceof Error ? next : new Error(String(next)));
						})
						.finally(() => {
							abortController = null;
						});
				};

				if (delayMs === 0) {
					beginPrompt();
					return;
				}

				timer = setTimeout(() => {
					timer = null;
					beginPrompt();
				}, delayMs);
				timer.unref?.();
			}),
		cancel: () => {
			if (cancelled) return;
			cancelled = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			if (!started) {
				pendingReject?.(new Error("cancelled"));
				pendingReject = null;
			}
			if (started) {
				abortController?.abort();
			}
		},
	};
}
