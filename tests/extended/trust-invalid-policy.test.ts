import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("untrusted invalid safety files leave default execution intact; trusted invalid files fail closed", async () => {
	const env = await isolateClioEnv("trust-invalid-");
	try {
		const workspace = join(env.dir, "workspace");
		mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
		const evaluate = () =>
			createSafetyPolicyEngine({ cwd: workspace }).evaluate({ tool: "bash", args: { command: "pwd" } });
		const defaults = evaluate();
		assert.equal(defaults.kind, "allow");
		const path = join(workspace, ".clio-coder/safety.yaml");
		writeFileSync(path, "version: [invalid yaml\n");
		assert.equal(evaluate().kind, defaults.kind, "unapproved malformed bytes cannot disable default execution");
		const snapshot = captureProjectSurface(workspace, "safety");
		assert.ok(snapshot.contentHash);
		recordProjectSurfaceTrust(workspace, "safety", snapshot.contentHash);
		assert.equal(evaluate().reasonCode, "project-policy-invalid", "an approved malformed policy must still fail closed");
		writeFileSync(path, "version: [different invalid yaml\n");
		assert.equal(captureProjectSurface(workspace, "safety").verdict, "changed");
		assert.equal(evaluate().kind, defaults.kind, "changed unapproved bytes return to defaults");
		const engine = createSafetyPolicyEngine({ cwd: workspace });
		assert.equal(engine.evaluate({ tool: "read", args: { path: ".env" } }).kind, "block");
		assert.ok(engine.metadata().projectPolicyErrors.some((error) => error.includes("invalid") || error.includes("YAML")));
	} finally {
		env.restore();
	}
});

for (const relocation of ["ancestor", "symlink"] as const)
	test(`safety consent binds canonical source provenance: ${relocation}`, async () => {
		const env = await isolateClioEnv("trust-provenance-");
		try {
			const parent = join(env.dir, "repo"),
				child = join(parent, "child");
			for (const root of [parent, child]) {
				mkdirSync(join(root, ".clio-coder"), { recursive: true });
				writeFileSync(
					join(root, ".clio-coder/safety.yaml"),
					"version: 1\ndisableDefaultPathPolicy: true\nzeroAccessPaths: [protected.txt]\n",
				);
				writeFileSync(join(root, "protected.txt"), "fixture");
			}
			const reviewed = captureProjectSurface(child, "safety");
			assert.ok(reviewed.contentHash);
			recordProjectSurfaceTrust(child, "safety", reviewed.contentHash);
			const evaluate = (path: string) =>
				createSafetyPolicyEngine({ cwd: child }).evaluate({ tool: "read", args: { path } });
			assert.equal(evaluate(".env").kind, "allow");
			assert.equal(evaluate("protected.txt").kind, "block");
			rmSync(join(child, ".clio-coder/safety.yaml"));
			if (relocation === "symlink")
				symlinkSync(join(parent, ".clio-coder/safety.yaml"), join(child, ".clio-coder/safety.yaml"));
			const moved = captureProjectSurface(child, "safety");
			assert.equal(moved.verdict, "changed");
			assert.notEqual(moved.contentHash, reviewed.contentHash);
			assert.equal(evaluate(".env").kind, "block", "moved policy cannot retain a previous exemption");
			assert.ok(moved.contentHash);
			recordProjectSurfaceTrust(child, "safety", moved.contentHash);
			assert.equal(evaluate(".env").kind, "allow");
			assert.equal(
				evaluate("protected.txt").kind,
				"allow",
				"after approval, relative entries are rooted at the canonical source",
			);
		} finally {
			env.restore();
		}
	});
