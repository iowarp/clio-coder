import { match, strictEqual } from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

// BUG-005: `--target <id>` is an explicit selector. Naming a target absent from
// settings.targets is an operator config error, the same mistake `targets use
// missing` already rejects. Before the fix `targets`/`models --target missing`
// filtered to an empty list and returned exit 0 with a generic empty listing
// (or `[]`/`{}` in JSON mode), so automation could not tell the target was wrong.

describe("contracts/cli-targets-contract", () => {
	const scratch = makeScratchHome("clio-targets-contract-");
	before(async () => {
		const configured = await runCli(
			[
				"configure",
				"--id",
				"local",
				"--runtime",
				"llamacpp",
				"--url",
				"http://127.0.0.1:1",
				"--model",
				"local-model",
				"--set-orchestrator",
				"--set-fleet-default",
				"--force",
			],
			{ env: scratch.env },
		);
		strictEqual(configured.code, 0, `configure failed: ${configured.stderr}`);
	});
	after(() => scratch.cleanup());

	const missingTargetCases: ReadonlyArray<ReadonlyArray<string>> = [
		["targets", "--target", "missing"],
		["targets", "--json", "--target", "missing"],
		["models", "--target", "missing", "--offline"],
		["models", "--json", "--target", "missing", "--offline"],
	];

	for (const args of missingTargetCases) {
		it(`clio ${args.join(" ")} rejects the missing target instead of an empty listing`, async () => {
			const result = await runCli(args, { env: scratch.env });
			strictEqual(result.code, 2, `stderr=${result.stderr}`);
			strictEqual(result.stdout, "", `unexpected stdout: ${result.stdout}`);
			match(result.stderr, /no target with id missing|target 'missing' not found/i);
		});
	}

	// A configured target still lists in both modes.
	it("clio targets --json --target local lists the configured target", async () => {
		const result = await runCli(["targets", "--json", "--target", "local"], { env: scratch.env });
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		match(result.stdout, /"targets"/);
	});
});
