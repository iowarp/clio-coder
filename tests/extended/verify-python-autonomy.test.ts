import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { mapAutonomy } from "../../src/domains/safety/autonomy.js";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/domains/safety/workspace-trust.js";
import { loadProjectVerifierCatalog } from "../../src/tools/verify/catalog.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

type Engine = ReturnType<typeof createSafetyPolicyEngine>;

/** The net decision for a verify call, then the autonomy mapping a run applies to it. */
function admitted(engine: Engine, check: string, level: "auto-edit" | "full-auto" = "auto-edit"): string {
	const decision = engine.evaluate({ tool: "verify", args: { check } });
	if (decision.kind !== "allow") return decision.kind;
	return mapAutonomy(level, decision.actionClass, { executeRecognized: decision.execRecognition !== "unrecognized" });
}

it("requires approved safety authority for Python argv without trusting arbitrary catalog commands or losing token boundaries", async () => {
	const scratch = await isolateClioEnv("verify-python-autonomy-");
	try {
		mkdirSync(join(scratch.dir, ".clio-coder"), { recursive: true });
		const cases = [
			{
				id: "absolute",
				command: ["/home/akougkas/iowarp/battletest-v044/python-env/bin/python", "-m", "pytest", "-q"],
				expected: "ask",
			},
			// A PATH-resolved test runner runs unattended at auto-edit (#377).
			{ id: "python", command: ["python3", "-m", "pytest", "-q", "test_index_policy.py"], expected: "allow" },
			{ id: "arbitrary", command: ["custom-check", "test.py"], expected: "ask" },
			{ id: "node-project", command: ["node", "test/add.test.mjs"], expected: "ask" },
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
		for (const row of cases) strictEqual(admitted(engine, row.id), row.expected, row.id);
		// At full-auto a catalog verifier is admitted like the same command through
		// bash: unrecognized argv runs, while net blocks and argv the net cannot
		// read as bare words still stop it.
		for (const row of cases) {
			const fullAuto =
				row.expected === "block" || ["inline", "joined-args", "fake-chain"].includes(row.id) ? row.expected : "allow";
			strictEqual(admitted(engine, row.id, "full-auto"), fullAuto, `${row.id} at full-auto`);
		}
		writeFileSync(
			join(scratch.dir, ".clio-coder/safety.yaml"),
			JSON.stringify({
				version: 1,
				commands: [
					{
						id: "confirm-absolute",
						command: "/home/akougkas/iowarp/battletest-v044/python-env/bin/python -m pytest -q",
						actionClass: "execute",
						requireConfirmation: true,
					},
				],
			}),
		);
		const approveSafety = () => {
			const snapshot = captureProjectSurface(scratch.dir, "safety");
			ok(snapshot.contentHash);
			recordProjectSurfaceTrust(scratch.dir, "safety", snapshot.contentHash);
		};
		approveSafety();
		const confirmedPolicy = createSafetyPolicyEngine({ cwd: scratch.dir });
		strictEqual(confirmedPolicy.metadata().projectPolicyValid, true);
		strictEqual(admitted(confirmedPolicy, "absolute"), "ask");
		strictEqual(admitted(confirmedPolicy, "absolute", "full-auto"), "ask", "requireConfirmation asks at every level");
		writeFileSync(
			join(scratch.dir, ".clio-coder/safety.yaml"),
			JSON.stringify({
				version: 1,
				commands: [
					{
						id: "approved-absolute",
						command: "/home/akougkas/iowarp/battletest-v044/python-env/bin/python -m pytest -q",
						actionClass: "execute",
					},
				],
			}),
		);
		strictEqual(
			admitted(createSafetyPolicyEngine({ cwd: scratch.dir }), "absolute"),
			"ask",
			"changed declarations need renewed approval",
		);
		approveSafety();
		const approved = createSafetyPolicyEngine({ cwd: scratch.dir });
		strictEqual(admitted(approved, "absolute"), "allow");
		for (const row of cases.slice(1)) strictEqual(admitted(approved, row.id), row.expected, row.id);
	} finally {
		scratch.restore();
	}
});
