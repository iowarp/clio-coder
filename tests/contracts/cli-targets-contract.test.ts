import { match, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
		it(`clio-coder ${args.join(" ")} rejects the missing target instead of an empty listing`, async () => {
			const result = await runCli(args, { env: scratch.env });
			strictEqual(result.code, 2, `stderr=${result.stderr}`);
			strictEqual(result.stdout, "", `unexpected stdout: ${result.stdout}`);
			match(result.stderr, /no target with id missing|target 'missing' not found/i);
		});
	}

	// A configured target still lists in both modes.
	it("clio-coder targets --json --target local lists the configured target", async () => {
		const result = await runCli(["targets", "--json", "--target", "local"], { env: scratch.env });
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		match(result.stdout, /"targets"/);
	});

	// One node orchestrating while another runs the workers is the documented
	// fleet topology, and `targets use` used to force both onto one target with
	// no flag able to separate them.
	it("clio-coder targets use local --fleet-target worker splits orchestrator from workers", async () => {
		const added = await runCli(
			[
				"configure",
				"--id",
				"worker",
				"--runtime",
				"llamacpp",
				"--url",
				"http://127.0.0.1:2",
				"--model",
				"worker-model",
				"--force",
			],
			{ env: scratch.env, timeoutMs: 30_000 },
		);
		strictEqual(added.code, 0, `configure worker failed: ${added.stderr}`);

		const used = await runCli(["targets", "use", "local", "--fleet-target", "worker"], { env: scratch.env });
		strictEqual(used.code, 0, `stderr=${used.stderr}`);

		const settings = readFileSync(join(scratch.dir, "config", "settings.yaml"), "utf8");
		const orchestrator = settings.match(/orchestrator:\n\s+target:\s*(\S+)/)?.[1];
		const workerTarget = settings.match(/workers:\n\s+default:\n\s+target:\s*(\S+)/)?.[1];
		const workerModel = settings.match(/workers:\n\s+default:\n\s+target:\s*\S+\n\s+model:\s*(\S+)/)?.[1];
		strictEqual(orchestrator, "local");
		strictEqual(workerTarget, "worker");
		// The orchestrator's model id means nothing on the worker node.
		strictEqual(workerModel, "worker-model");
	});

	it("clio-coder targets use local --fleet-target missing rejects the unknown worker target", async () => {
		const result = await runCli(["targets", "use", "local", "--fleet-target", "missing"], { env: scratch.env });
		strictEqual(result.code, 2, `stderr=${result.stderr}`);
		match(result.stderr, /no target with id missing/i);
	});

	// The worker/fleet rename left these two names accepted with nothing naming
	// them, so a script written against the old spelling worked by luck.
	it("accepts --worker-target and --worker-model as the pre-rename spelling", async () => {
		const added = await runCli(
			[
				"configure",
				"--id",
				"legacy-worker",
				"--runtime",
				"llamacpp",
				"--url",
				"http://127.0.0.1:3",
				"--model",
				"legacy-default",
				"--force",
			],
			{ env: scratch.env, timeoutMs: 30_000 },
		);
		strictEqual(added.code, 0, `configure legacy-worker failed: ${added.stderr}`);

		const used = await runCli(
			["targets", "use", "local", "--worker-target", "legacy-worker", "--worker-model", "legacy-chosen"],
			{ env: scratch.env },
		);
		strictEqual(used.code, 0, `stderr=${used.stderr}`);

		const settings = readFileSync(join(scratch.dir, "config", "settings.yaml"), "utf8");
		const workerTarget = settings.match(/workers:\n\s+default:\n\s+target:\s*(\S+)/)?.[1];
		const workerModel = settings.match(/workers:\n\s+default:\n\s+target:\s*\S+\n\s+model:\s*(\S+)/)?.[1];
		strictEqual(workerTarget, "legacy-worker");
		strictEqual(workerModel, "legacy-chosen");

		const help = await runCli(["targets", "--help"], { env: scratch.env });
		strictEqual(help.code, 0, `stderr=${help.stderr}`);
		match(help.stdout, /--worker-target and --worker-model are accepted/);
	});
});
