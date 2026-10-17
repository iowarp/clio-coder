/**
 * The hook receipt log wrote at most once per throttle window with no trailing
 * write, so a receipt recorded inside the window stayed in memory until the
 * next hooked call or exit and a live session's snapshot lagged on disk.
 */
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { clioStateDir } from "../../src/core/xdg.js";
import { createHookReceiptLog, readPersistedHookReceipts } from "../../src/domains/middleware/hook-receipts.js";
import type { HookReceipt } from "../../src/domains/middleware/hooks.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

function receipt(hookId: string, at: number): HookReceipt {
	return {
		at,
		hookId,
		origin: "project",
		sourcePath: ".clio-coder/hooks.yaml",
		hash: "deadbeef",
		hook: "before_tool",
		kind: "command",
		outcome: "command-ok",
	};
}

describe("hook receipt log trailing write", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await newScratchClioHome();
		mock.timers.enable({ apis: ["setTimeout"] });
	});
	afterEach(() => {
		mock.timers.reset();
		clearScratchClioHome(dir);
	});

	it("writes a receipt recorded inside the throttle window once the window closes", () => {
		const persistPath = join(clioStateDir(), "hook-receipts.json");
		let clock = 10_000;
		const log = createHookReceiptLog({ persistPath, throttleMs: 2_000, now: () => clock });
		log.record(receipt("first", clock));
		clock += 500;
		log.record(receipt("second", clock));
		deepStrictEqual(
			readPersistedHookReceipts(persistPath).map((r) => r.hookId),
			["first"],
		);

		clock += 1_500;
		mock.timers.tick(1_500);
		deepStrictEqual(
			readPersistedHookReceipts(persistPath).map((r) => r.hookId),
			["first", "second"],
		);
	});
});
