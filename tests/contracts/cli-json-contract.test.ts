import { match, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

// Contract: a --json-capable surface keeps stdout machine-readable. On an
// argument or usage error the command exits 2 with the diagnostic and any help
// text on stderr, and writes nothing to stdout, so a consumer parsing stdout
// never mistakes human help for a payload.

describe("contracts/cli-json-contract", () => {
	const scratch = makeScratchHome("clio-json-contract-");
	after(() => scratch.cleanup());

	// BUG-001: argument/usage errors must not write human help to stdout.
	const usageErrorCases: ReadonlyArray<ReadonlyArray<string>> = [
		["paths", "--json", "--bad"],
		["doctor", "--json", "--bad"],
		["models", "--json", "--bad", "--offline"],
		["targets", "--json", "--bad"],
		["components", "--json", "--bad"],
		["config", "bogus", "--json"],
		["fleet", "nope", "--json"],
		["extensions", "nope", "--json"],
		["skills", "nope", "--json"],
		// Parsers that used to return null and drop the diagnostic entirely.
		["skills", "list", "--json", "--bad"],
		["extensions", "list", "--json", "--bad"],
	];

	for (const args of usageErrorCases) {
		it(`clio ${args.join(" ")} keeps stdout clean and diagnoses on stderr`, async () => {
			const result = await runCli(args, { env: scratch.env });
			strictEqual(result.code, 2, `stderr=${result.stderr}`);
			strictEqual(result.stdout, "", `unexpected stdout: ${result.stdout}`);
			match(result.stderr, /unknown|usage|requires|invalid/i);
		});
	}
});
