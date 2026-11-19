import { rejects, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { extractGlobalFlags } from "../../src/cli/argv.js";
import { runClioCommand } from "../../src/cli/clio.js";
import { runOverrides } from "../../src/core/run-overrides.js";

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

it("--max-context-tokens caps the interactive session's window through the run overrides, as run does (c16-E)", async () => {
	const parsed = extractGlobalFlags(["--max-context-tokens", "8192"]);
	strictEqual(parsed.maxContextTokens, 8192);
	strictEqual(
		extractGlobalFlags(["--max-context-tokens", "0"]).error,
		"--max-context-tokens must be a positive integer",
	);
	strictEqual(extractGlobalFlags(["--max-context-tokens=8192"]).maxContextTokens, 8192);
	strictEqual(extractGlobalFlags(["--max-context-tokens=-5"]).error, "--max-context-tokens must be a positive integer");
	let seen: number | undefined;
	const code = await runClioCommand(
		{
			headless: { prompt: "fixture" },
			...(parsed.maxContextTokens ? { maxContextTokens: parsed.maxContextTokens } : {}),
		},
		{
			bootOrchestrator: async () => {
				seen = runOverrides().maxContextTokens;
				return { exitCode: 0, bootTimeMs: 0 };
			},
		},
	);
	strictEqual(code, 0);
	strictEqual(seen, 8192);
	strictEqual(runOverrides().maxContextTokens, undefined);
});
