import { strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { mapAutonomy } from "../../src/domains/safety/autonomy.js";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { loadProjectVerifierCatalog } from "../../src/tools/verify/catalog.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

it("recognizes declared Python argv without trusting arbitrary catalog commands or losing token boundaries", async () => {
	const scratch = await isolateClioEnv("verify-python-autonomy-");
	try {
		mkdirSync(join(scratch.dir, ".clio-coder"), { recursive: true });
		const cases = [
			{ id: "python", command: ["python3", "-m", "pytest", "-q", "test_index_policy.py"], expected: "allow" },
			{
				id: "absolute",
				command: ["/home/akougkas/iowarp/battletest-v044/python-env/bin/python", "-m", "pytest", "-q"],
				expected: "ask",
			},
			{ id: "arbitrary", command: ["custom-check", "test.py"], expected: "ask" },
			{ id: "inline", command: ["python3", "-c", "print(1)"], expected: "ask" },
			{ id: "joined-args", command: ["python3", "-m pytest"], expected: "ask" },
			{ id: "fake-chain", command: ["python3", "-m", "pytest", "&&", "python3", "-m", "pytest"], expected: "ask" },
			{ id: "destructive", command: ["rm", "-rf", "/"], expected: "block" },
		];
		writeFileSync(
			join(scratch.dir, ".clio-coder/verifiers.yaml"),
			JSON.stringify({
				version: 1,
				checks: cases.map(({ id, command }) => ({ id, command, description: id, cwd: ".", timeoutMs: 30000, tags: [] })),
			}),
		);
		strictEqual(
			loadProjectVerifierCatalog(scratch.dir).ok,
			true,
			JSON.stringify(loadProjectVerifierCatalog(scratch.dir)),
		);
		const engine = createSafetyPolicyEngine({ cwd: scratch.dir });
		for (const row of cases) {
			const decision = engine.evaluate({ tool: "verify", args: { check: row.id } });
			const actual =
				decision.kind === "allow"
					? mapAutonomy("auto-edit", decision.actionClass, {
							executeRecognized: decision.execRecognition !== "unrecognized",
						})
					: decision.kind;
			strictEqual(actual, row.expected, row.id);
		}
		writeFileSync(
			join(scratch.dir, ".clio-coder/safety.yaml"),
			JSON.stringify({
				version: 1,
				commands: [
					{
						id: "confirm-python",
						command: "python3 -m pytest -q test_index_policy.py",
						actionClass: "execute",
						requireConfirmation: true,
					},
				],
			}),
		);
		const confirmedPolicy = createSafetyPolicyEngine({ cwd: scratch.dir });
		strictEqual(confirmedPolicy.metadata().projectPolicyValid, true);
		strictEqual(confirmedPolicy.evaluate({ tool: "verify", args: { check: "python" } }).kind, "ask");
	} finally {
		scratch.restore();
	}
});
