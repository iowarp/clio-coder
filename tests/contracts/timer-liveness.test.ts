import { strictEqual } from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { describe, it } from "node:test";

function runHandleFreeModule(source: string): SpawnSyncReturns<string> {
	return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
		cwd: process.cwd(),
		encoding: "utf8",
		timeout: 5_000,
	});
}

function assertSuccessfulResolution(result: SpawnSyncReturns<string>, expectedStdout: string): void {
	strictEqual(result.error, undefined);
	strictEqual(result.status, 0, result.stderr);
	strictEqual(result.signal, null);
	strictEqual(result.stdout.trim(), expectedStdout);
}

describe("contracts/timer-liveness", () => {
	it("keeps the shutdown budget alive until a hung operation times out", () => {
		const result = runHandleFreeModule(`
			import { runWithBudget } from "./src/core/termination.ts";
			const completed = await runWithBudget(() => new Promise(() => {}), 25);
			console.log(completed);
		`);

		assertSuccessfulResolution(result, "false");
	});

	it("keeps delayed OAuth manual input alive until the prompt starts", () => {
		const result = runHandleFreeModule(`
			import { createDelayedManualCodeInput } from "./src/cli/oauth-manual-input.ts";
			const input = createDelayedManualCodeInput(
				{ question: async () => "ready" },
				"code: ",
				{ delayMs: 25 },
			);
			console.log(await input.onManualCodeInput());
		`);

		assertSuccessfulResolution(result, "ready");
	});
});
