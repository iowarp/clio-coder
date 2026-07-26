import { match, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { validateSettings } from "../../src/core/config.js";
import { makeScratchHome, runCli } from "../harness/spawn.js";

// BUG-007: a partial non-interactive `configure` invocation (only --id, or only
// --runtime) used to fall into the wizard, read EOF from non-interactive stdin,
// write the default settings template, and exit 0 without configuring anything.
// With no TTY it must instead fail with exit 2 and name the missing half.

describe("contracts/configure-cli non-interactive gating", () => {
	it("rejects removed settings keys through strict current-schema validation", () => {
		const validation = validateSettings(
			parseYaml("version: 1\nsafetyLevel: auto-edit\nendpoints: []\nstate: {}\ntargets: []\n"),
		);
		const issuePaths = validation.issues.map((issue) => issue.path);
		for (const path of ["safetyLevel", "endpoints", "state"]) {
			ok(issuePaths.includes(path), `expected strict validation issue for ${path}`);
		}
	});

	const scratch = makeScratchHome("clio-configure-cli-");
	after(() => scratch.cleanup());

	const partialCases: ReadonlyArray<ReadonlyArray<string>> = [
		["configure", "--id", "local"],
		["configure", "--runtime", "llamacpp"],
	];

	for (const args of partialCases) {
		it(`clio ${args.join(" ")} rejects the incomplete non-interactive invocation`, async () => {
			const result = await runCli(args, { env: scratch.env, input: "" });
			strictEqual(result.code, 2, `stderr=${result.stderr}`);
			strictEqual(result.stdout, "", `unexpected stdout: ${result.stdout}`);
			match(result.stderr, /--runtime is required|--id is required|usage/i);
		});
	}

	// A complete non-interactive invocation still succeeds without a TTY.
	it("clio configure with --id and --runtime and a target flag succeeds", async () => {
		const result = await runCli(
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
				"--force",
			],
			{ env: scratch.env, input: "" },
		);
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
	});
});
