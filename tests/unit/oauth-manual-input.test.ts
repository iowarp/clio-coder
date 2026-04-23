import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { createDelayedManualCodeInput } from "../../src/cli/oauth-manual-input.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("cli/oauth-manual-input", () => {
	it("cancels before the delayed prompt starts", async () => {
		let calls = 0;
		const rl = {
			question: async () => {
				calls += 1;
				return "unused";
			},
		};
		const manualInput = createDelayedManualCodeInput(rl as never, "code: ", { delayMs: 20 });
		const result = manualInput.onManualCodeInput().catch((error: unknown) => {
			return error instanceof Error ? error.message : String(error);
		});

		manualInput.cancel();
		await sleep(40);

		strictEqual(calls, 0);
		strictEqual(await result, "cancelled");
	});

	it("aborts an active readline question when cancelled", async () => {
		let aborted = false;
		const rl = {
			question: (_prompt: string, options?: { signal?: AbortSignal }) =>
				new Promise<string>((_resolve, reject) => {
					options?.signal?.addEventListener(
						"abort",
						() => {
							aborted = true;
							const error = new Error("aborted");
							error.name = "AbortError";
							reject(error);
						},
						{ once: true },
					);
				}),
		};
		const manualInput = createDelayedManualCodeInput(rl as never, "code: ", { delayMs: 0 });
		const result = manualInput.onManualCodeInput().catch((error: unknown) => {
			return error instanceof Error ? error.message : String(error);
		});

		await sleep(0);
		manualInput.cancel();

		strictEqual(await result, "cancelled");
		strictEqual(aborted, true);
	});
});
