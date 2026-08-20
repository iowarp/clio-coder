import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { settleChatBeforeSessionSwitch } from "../../src/interactive/session-switch-settlement.js";

describe("contracts/tui-session-switch-streaming", () => {
	it("cancels and settles a streaming turn before changing sessions", async () => {
		const events: string[] = [];
		let releaseSettlement: (() => void) | undefined;
		const settlement = new Promise<void>((resolve) => {
			releaseSettlement = resolve;
		});
		const switching = settleChatBeforeSessionSwitch({
			isStreaming: () => true,
			cancel: () => events.push("cancel"),
			whenSettled: async () => {
				events.push("settling");
				await settlement;
				events.push("settled");
			},
		});

		await Promise.resolve();
		deepStrictEqual(events, ["cancel", "settling"]);
		releaseSettlement?.();
		await switching;
		deepStrictEqual(events, ["cancel", "settling", "settled"]);
	});

	it("leaves an idle chat synchronous without cancelling", () => {
		let cancelled = false;
		const switching = settleChatBeforeSessionSwitch({
			isStreaming: () => false,
			cancel: () => {
				cancelled = true;
			},
			whenSettled: async () => {},
		});

		strictEqual(switching, null);
		strictEqual(cancelled, false);
	});
});
