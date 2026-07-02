import { match, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
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

	// BUG-002: surfaces with a finite flag set must reject an unknown flag rather
	// than ignore it, exit 0, and emit a successful JSON payload.
	const ignoredFlagCases: ReadonlyArray<ReadonlyArray<string>> = [
		["agents", "--json", "--definitely-not-a-real-flag"],
		["fleet", "status", "--json", "--definitely-not-a-real-flag"],
	];

	for (const args of ignoredFlagCases) {
		it(`clio ${args.join(" ")} rejects the unknown flag instead of emitting JSON`, async () => {
			const result = await runCli(args, { env: scratch.env });
			strictEqual(result.code, 2, `stderr=${result.stderr}`);
			strictEqual(result.stdout, "", `unexpected stdout: ${result.stdout}`);
			match(result.stderr, /unknown flag|usage/i);
		});
	}
});

describe("contracts/cli-json-contract run --target", () => {
	const scratch = makeScratchHome("clio-json-run-target-");
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
				"--force",
			],
			{ env: scratch.env },
		);
		strictEqual(configured.code, 0, `configure failed: ${configured.stderr}`);
	});
	after(() => scratch.cleanup());

	// BUG-003: an explicit --target override that names a missing target is an
	// operator config error, not an assistant response. It must exit 2 with a
	// stderr diagnostic and empty stdout, never a message_end/agent_end turn.
	it("run --json --target <missing> rejects before the agent turn", async () => {
		const result = await runCli(["run", "--json", "--target", "missing", "hello"], { env: scratch.env });
		strictEqual(result.code, 2, `stderr=${result.stderr}`);
		strictEqual(result.stdout, "", `unexpected stdout: ${result.stdout}`);
		match(result.stderr, /target 'missing' not found/);
	});
});

describe("contracts/cli-json-contract null settings.yaml", () => {
	const scratch = makeScratchHome("clio-json-null-settings-");
	after(() => scratch.cleanup());

	// BUG-008: a present but null/empty settings.yaml is malformed, not a valid
	// default. The strict readSettings gate must reject it with a root-shape error
	// rather than booting on silent defaults.
	it("targets --json rejects a null settings.yaml with a root-shape error", async () => {
		const configDir = scratch.env.CLIO_CONFIG_DIR as string;
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "settings.yaml"), "null\n");
		const result = await runCli(["targets", "--json"], { env: scratch.env });
		strictEqual(result.code, 1, `stderr=${result.stderr}`);
		strictEqual(result.stdout, "", `unexpected stdout: ${result.stdout}`);
		match(result.stderr, /settings\.yaml failed validation/);
		match(result.stderr, /\(root\): expected a map, got null/);
	});
});
