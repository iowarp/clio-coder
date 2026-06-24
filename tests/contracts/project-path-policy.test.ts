import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { loadProjectSafetyPolicy } from "../../src/domains/safety/project-policy.js";

describe("contracts/project path safety policy", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-project-policy-"));
		mkdirSync(join(scratch, ".clio"), { recursive: true });
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("loads .clio/safety.yaml path rules and enforces real tool calls", () => {
		const policyPath = join(scratch, ".clio", "safety.yaml");
		writeFileSync(
			policyPath,
			[
				"version: 1",
				"disableDefaultPathPolicy: true",
				"zeroAccessPaths:",
				"  - secrets",
				"readOnlyPaths:",
				"  - vendor",
				"noDeletePaths:",
				"  - protected",
				"",
			].join("\n"),
			"utf8",
		);

		const loaded = loadProjectSafetyPolicy(scratch);
		strictEqual(loaded.valid, true);
		strictEqual(loaded.path, policyPath);
		deepStrictEqual(loaded.pathPolicy, {
			zeroAccessPaths: ["secrets"],
			readOnlyPaths: ["vendor"],
			noDeletePaths: ["protected"],
		});

		const engine = createSafetyPolicyEngine({ cwd: scratch, projectPolicy: loaded });
		const zeroRead = engine.evaluate({ tool: ToolNames.Read, args: { path: "secrets/key.txt" } });
		strictEqual(zeroRead.kind, "block");
		strictEqual(zeroRead.reasonCode, "path-policy:zeroAccessPaths");
		strictEqual(zeroRead.policySource, "project-policy");
		strictEqual(zeroRead.projectPolicyPath, policyPath);

		const vendorWrite = engine.evaluate({ tool: ToolNames.Write, args: { path: "vendor/generated.ts" } });
		strictEqual(vendorWrite.kind, "block");
		strictEqual(vendorWrite.reasonCode, "path-policy:readOnlyPaths");

		const protectedWrite = engine.evaluate({ tool: ToolNames.Write, args: { path: "protected/keep.txt" } });
		strictEqual(protectedWrite.kind, "allow");
	});

	it("rejects absolute and escaping path entries and fails execution closed", () => {
		const policyPath = join(scratch, ".clio", "safety.yaml");
		writeFileSync(
			policyPath,
			["version: 1", "zeroAccessPaths:", "  - /etc", "readOnlyPaths:", "  - ../outside", ""].join("\n"),
			"utf8",
		);

		const loaded = loadProjectSafetyPolicy(scratch);
		strictEqual(loaded.valid, false);
		deepStrictEqual(loaded.pathPolicy, {});
		deepStrictEqual(loaded.errors, [
			"zeroAccessPaths[0] must be relative to the policy root",
			"readOnlyPaths[0] must not escape the policy root with '..'",
		]);

		const engine = createSafetyPolicyEngine({ cwd: scratch, projectPolicy: loaded });
		const decision = engine.evaluate({ tool: ToolNames.Bash, args: { command: "python -m pytest" } });
		strictEqual(decision.kind, "block");
		strictEqual(decision.reasonCode, "project-policy-invalid");
		strictEqual(decision.projectPolicyPath, policyPath);
	});
});
