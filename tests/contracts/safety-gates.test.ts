import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { ToolNames } from "../../src/core/tool-names.js";
import { mapAutonomy } from "../../src/domains/safety/autonomy.js";
import { createSafetyPolicyEngine, type SafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { loadProjectSafetyPolicy } from "../../src/domains/safety/project-policy.js";

describe("safety gate boundary", () => {
	let originalCwd: string;
	let scratch: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "clio-safety-contract-"));
		mkdirSync(join(scratch, ".clio-coder"), { recursive: true });
		mkdirSync(join(scratch, "pkg"), { recursive: true });
		process.chdir(scratch);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(scratch, { recursive: true, force: true });
	});

	function engine(): SafetyPolicyEngine {
		return createSafetyPolicyEngine({ cwd: scratch, projectPolicy: loadProjectSafetyPolicy(scratch) });
	}

	it("hard-blocks zero-access paths before confirmation or ordinary ask rails", () => {
		const policy = engine();
		for (const call of [
			{ tool: ToolNames.Read, args: { path: ".env" } },
			{ tool: ToolNames.Write, args: { path: "credentials.yaml", content: "secret" } },
			{ tool: ToolNames.Bash, args: { command: ": > .env" } },
		]) {
			strictEqual(policy.evaluate(call).kind, "block");
			strictEqual(policy.evaluate(call, "confirmed").kind, "block");
		}
		const secretRead = policy.evaluate({ tool: ToolNames.Bash, args: { command: "cat ~/.ssh/id_rsa" } });
		strictEqual(secretRead.kind, "block");
		strictEqual(secretRead.reasonCode, "secret_path_bash");
	});

	it("recognizes only safe complete command chains inside the workspace", () => {
		const policy = engine();
		const admitted = policy.evaluate({ tool: ToolNames.Bash, args: { command: "cd pkg && npm test && git status" } });
		strictEqual(admitted.kind, "allow");
		strictEqual(admitted.execRecognition, "recognized");

		for (const command of [
			"cd pkg && npm test && curl http://example.com",
			"npm test | tee output.txt",
			"cd pkg && npm test $(cat args)",
		]) {
			strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command } }).execRecognition, "unrecognized");
		}
		strictEqual(
			policy.evaluate({ tool: ToolNames.Bash, args: { command: "cd /etc && ls" } }).actionClass,
			"system_modify",
		);
	});

	it("protects verifier authority and scans catalog argv before execution", () => {
		const catalogPath = join(scratch, ".clio-coder", "verifiers.yaml");
		const policyPath = join(scratch, ".clio-coder", "safety.yaml");
		for (const path of [catalogPath, policyPath]) {
			const decision = engine().evaluate({ tool: ToolNames.Write, args: { path, content: "version: 1\n" } });
			strictEqual(decision.kind, "block");
			strictEqual(decision.reasonCode, "path-policy:readOnlyPaths");
		}

		writeFileSync(
			catalogPath,
			"version: 1\nchecks:\n  - id: wipe\n    description: unsafe\n    command: [rm, -rf, /]\n    cwd: .\n    timeoutMs: 10000\n    tags: [test]\n",
		);
		const destructive = engine().evaluate({ tool: ToolNames.Verify, args: { check: "wipe" } });
		strictEqual(destructive.kind, "block");
		strictEqual(destructive.reasonCode.startsWith("damage-control:"), true);
	});

	it("keeps destructive transitions blocked while allowing explicit one-shot rails once", () => {
		const policy = engine();
		for (const command of ["git push --force origin main", "find . -name '*.log' -delete", "shred -u key.txt"]) {
			const call = { tool: ToolNames.Bash, args: { command } };
			strictEqual(policy.evaluate(call).kind, "block", command);
			strictEqual(policy.evaluate(call, "confirmed").kind, "block", command);
		}
		for (const command of ["git stash drop", "truncate -s 0 server.log"]) {
			const call = { tool: ToolNames.Bash, args: { command } };
			strictEqual(policy.evaluate(call).kind, "ask", command);
			strictEqual(policy.evaluate(call, "confirmed").kind, "allow", command);
		}
		strictEqual(mapAutonomy("full-auto", "git_destructive"), "deny");
	});

	it("fails execution closed under an invalid project policy without blocking normal reads", () => {
		writeFileSync(join(scratch, ".clio-coder", "safety.yaml"), "version: 1\nzeroAccessPaths:\n  - /etc\n");
		const policy = engine();
		strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command: "npm test" } }).kind, "block");
		strictEqual(policy.evaluate({ tool: ToolNames.Read, args: { path: ".env" } }).kind, "block");
		strictEqual(policy.evaluate({ tool: ToolNames.Read, args: { path: "notes.txt" } }).kind, "allow");
	});
});
