import { strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runBashCommand } from "../../src/core/bash-exec.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { ClassifierCall } from "../../src/domains/safety/action-classifier.js";
import { createSafetyPolicyEngine, type SafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { loadProjectSafetyPolicy } from "../../src/domains/safety/project-policy.js";
import { workerSecretPaths } from "../../src/domains/safety/secret-paths.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("safety gate findings", () => {
	let isolated: IsolatedClioEnv;
	let scratch: string;
	let workspace: string;
	let home: string;
	let savedHome: string | undefined;
	let policy: SafetyPolicyEngine;

	before(async () => {
		await runBashCommand("true");
		isolated = await isolateClioEnv("clio-coder-gate-findings-");
		scratch = mkdtempSync(join(tmpdir(), "clio-coder-gate-findings-ws-"));
		workspace = join(scratch, "ws");
		home = join(scratch, "home");
		mkdirSync(join(workspace, ".clio-coder"), { recursive: true });
		mkdirSync(join(workspace, ".git", "hooks"), { recursive: true });
		mkdirSync(home, { recursive: true });
		savedHome = process.env.HOME;
		process.env.HOME = home;
		policy = createSafetyPolicyEngine({ cwd: workspace, projectPolicy: loadProjectSafetyPolicy(workspace) });
	});

	after(() => {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		rmSync(scratch, { recursive: true, force: true });
		isolated.restore();
	});

	const kind = (call: ClassifierCall, posture?: "yolo") => policy.evaluate(call, posture).kind;

	it("typed reads refuse every path the shell sandbox masks, and the process environment", () => {
		for (const secret of [...workerSecretPaths(home), join(home, ".config", "gh", "hosts.yml"), "/proc/self/environ"]) {
			strictEqual(kind({ tool: ToolNames.Read, args: { path: secret } }), "block", secret);
		}
	});

	it("the exit-code presence exemption covers only the bare ^NAME= pattern", () => {
		const bash = (command: string) => kind({ tool: ToolNames.Bash, args: { command } });
		strictEqual(bash("grep -sq '^API_KEY=' .env"), "allow");
		for (const oracle of [
			"grep -q '^API_KEY=sk-a' .env",
			"grep -q '^API_KEY=s[a-k]' .env",
			'grep -sq "^API_KEY=.*x" .env',
		]) {
			strictEqual(bash(oracle), "block", oracle);
		}
	});

	it("the safety.yaml rail follows a literal cd and every common writer", () => {
		const bash = (command: string) => kind({ tool: ToolNames.Bash, args: { command } });
		for (const command of [
			"cd .clio-coder && echo x > safety.yaml",
			"cd .clio-coder && rm safety.yaml",
			"dd if=/dev/null of=.clio-coder/safety.yaml",
			"install /dev/null .clio-coder/safety.yaml",
			"cp -t .clio-coder x/safety.yaml",
			"cd .clio-coder && cp -t . x/safety.yaml",
			"cd .git && rm hooks/pre-commit",
		]) {
			strictEqual(bash(command), "block", command);
		}
	});

	it("refuses a path argument longer than any real path without walking it", () => {
		const long = Array.from({ length: 50_000 }, () => "a").join("/");
		strictEqual(kind({ tool: ToolNames.Read, args: { path: long } }), "block");
		strictEqual(kind({ tool: ToolNames.Bash, args: { command: `cat ${long}` } }, "yolo"), "block");
	});
});
