import { rejects, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { runClioCommand } from "../../src/cli/clio.js";

it("awaits the boot runner and returns its exit code with headless options intact", async () => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	let finished = false;
	const result = runClioCommand(
		{ headless: { prompt: "fixture" } },
		{
			bootOrchestrator: async (options) => {
				strictEqual(options?.headless?.prompt, "fixture");
				strictEqual(options?.terminalLease, undefined);
				await pending;
				finished = true;
				return { exitCode: 7, bootTimeMs: 0 };
			},
		},
	);
	strictEqual(finished, false);
	release();
	strictEqual(await result, 7);
});

it("preserves the boot runner failure", async () => {
	const failure = new Error("fixture hydration failure");
	await rejects(
		runClioCommand(
			{ headless: { prompt: "fixture" } },
			{
				bootOrchestrator: async () => {
					throw failure;
				},
			},
		),
		(error) => error === failure,
	);
});
