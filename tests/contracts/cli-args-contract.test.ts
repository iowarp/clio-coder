import { match, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

// BUG-004: top-level value flags (--api-key, --skill) must reject a missing
// value with exit 2 and a stderr diagnostic, and must never consume an intended
// subcommand as their value. Before the fix a bare flag silently disappeared and
// `--api-key paths --json` booted the app with "paths" swallowed as the key.

describe("contracts/cli-args-contract", () => {
	const scratch = makeScratchHome("clio-args-contract-");
	after(() => scratch.cleanup());

	const missingValueCases: ReadonlyArray<ReadonlyArray<string>> = [
		["--api-key"],
		["--api-key", "--version"],
		["--api-key", "paths", "--json"],
		["--api-key", "context-init"],
		["--skill"],
		["--skill", "--version"],
		["--skill", "paths", "--json"],
		["--skill", "context-index"],
	];

	for (const args of missingValueCases) {
		it(`clio ${args.join(" ")} rejects the missing value instead of consuming a subcommand`, async () => {
			const result = await runCli(args, { env: scratch.env });
			strictEqual(result.code, 2, `stderr=${result.stderr}`);
			strictEqual(result.stdout, "", `unexpected stdout: ${result.stdout}`);
			match(result.stderr, /requires a value|usage/i);
		});
	}

	// A real value followed by a subcommand is the advertised form and must keep
	// working: the value is consumed and the subcommand runs.
	it("clio --api-key <key> paths --json still runs the subcommand", async () => {
		const result = await runCli(["--api-key", "sk-not-a-subcommand", "paths", "--json"], { env: scratch.env });
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		match(result.stdout, /"config"/);
	});
});
