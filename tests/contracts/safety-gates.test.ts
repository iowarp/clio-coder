import { strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { clioConfigDir } from "../../src/core/xdg.js";
import { mapAutonomy } from "../../src/domains/safety/autonomy.js";
import { createSafetyPolicyEngine, type SafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { loadProjectSafetyPolicy } from "../../src/domains/safety/project-policy.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createRegistry } from "../../src/tools/registry.js";
import { writeTool } from "../../src/tools/write.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("safety gate boundary", () => {
	let originalCwd: string;
	let scratch: string;
	let isolated: IsolatedClioEnv;

	beforeEach(async () => {
		isolated = await isolateClioEnv("clio-skill-authority-");
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "clio-safety-contract-"));
		mkdirSync(join(scratch, ".clio-coder"), { recursive: true });
		mkdirSync(join(scratch, "pkg"), { recursive: true });
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

	it("protects active project and resolved user skills in main and worker admissions even without path defaults", () => {
		writeFileSync(join(scratch, ".clio-coder", "safety.yaml"), "version: 1\ndisableDefaultPathPolicy: true\n");
		const main = engine();
		const worker = createWorkerSafety({ cwd: scratch });
		for (const root of [join(scratch, ".clio-coder", "skills"), join(clioConfigDir(), "skills")]) {
			const skill = join(root, "example", "SKILL.md");
			for (const policy of [main, worker]) {
				for (const call of [
					{ tool: ToolNames.Write, args: { path: skill, content: "changed" } },
					{ tool: ToolNames.Edit, args: { path: skill, oldText: "old", newText: "new" } },
					{ tool: ToolNames.Artifact, args: { path: skill, content: "changed", kind: "markdown" } },
					{ tool: ToolNames.Bash, args: { command: `rm -r '${root}'` } },
					{ tool: ToolNames.Bash, args: { command: `mv '${root}' draft` } },
					{ tool: ToolNames.Bash, args: { command: `cp draft '${skill}'` } },
				]) {
					strictEqual(policy.evaluate(call).kind, "block", JSON.stringify(call));
					strictEqual(policy.evaluate(call, "confirmed").kind, "block", JSON.stringify(call));
				}
				strictEqual(policy.evaluate({ tool: ToolNames.Read, args: { path: skill } }).kind, "allow");
				strictEqual(
					policy.evaluate({ tool: ToolNames.Write, args: { path: "draft-skills/example/SKILL.md" } }).kind,
					"allow",
				);
			}
		}
	});

	it("refuses an actual full-auto registry write without touching active bytes while allowing a draft", async () => {
		const target = join(scratch, ".clio-coder", "skills", "example", "SKILL.md");
		mkdirSync(join(scratch, ".clio-coder", "skills", "example"), { recursive: true });
		writeFileSync(target, "Operator instructions.\n");
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: scratch }), autonomy: () => "full-auto" });
		registry.register(writeTool);
		const denied = await registry.invoke({
			tool: ToolNames.Write,
			args: { path: target, content: "Model replacement." },
		});
		strictEqual(denied.kind, "blocked");
		strictEqual(readFileSync(target, "utf8"), "Operator instructions.\n");
		const draft = join(scratch, "draft-skills", "example", "SKILL.md");
		strictEqual(existsSync(draft), false);
		const written = await registry.invoke({
			tool: ToolNames.Write,
			args: { path: draft, content: "Proposed instructions.\n" },
		});
		strictEqual(written.kind, "ok");
		strictEqual(readFileSync(draft, "utf8"), "Proposed instructions.\n");
	});

	it("protects aliases, missing descendants, late symlinks, parent deletion and shell cwd changes", () => {
		const skills = join(scratch, ".clio-coder", "skills");
		const outside = join(scratch, "outside");
		mkdirSync(outside);
		const policy = engine();
		// The active root becomes a symlink after the policy was constructed.
		symlinkSync(outside, skills);
		symlinkSync(skills, join(scratch, "alias"));
		for (const target of [
			"alias/new/SKILL.md",
			"outside/new/SKILL.md",
			".clio-coder/skills/new/SKILL.md",
			".clio-coder/skills/..draft/SKILL.md",
		]) {
			strictEqual(policy.evaluate({ tool: ToolNames.Write, args: { path: target } }).kind, "block", target);
		}
		for (const command of [
			"rm -r .clio-coder",
			"mv .clio-coder saved",
			"cd .clio-coder && rm -r skills",
			"sh -c 'cd .clio-coder && printf changed > skills/new/SKILL.md'",
		])
			strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command } }).kind, "block", command);
	});

	it("blocks model shell skill installation and updates while preserving inventory and draft validation", () => {
		const policy = engine();
		for (const command of [
			"clio-coder skills install ./draft-skills/example",
			"clio-coder --no-skills skills install example",
			"env CLIO_CODER_CONFIG_DIR=/tmp/elsewhere clio-coder skills update --all --force",
			"command clio-coder library install skill:example --yes",
			"sh -lc 'clio-coder skills install example --user'",
			"node /opt/clio/dist/cli/index.js skills install example",
			"npx @iowarp/clio-coder skills install example",
			"npm exec -- clio-coder skills update example",
		]) {
			const decision = policy.evaluate({ tool: ToolNames.Bash, args: { command } });
			strictEqual(decision.kind, "block", command);
			strictEqual(decision.reasonCode, "skill-authority", command);
		}
		for (const command of [
			"clio-coder skills list",
			"clio-coder skills install --help",
			"clio-coder skills get example",
			"clio-coder skills validate draft-skills/example/SKILL.md",
			"clio-coder library list",
			"printf 'clio-coder skills install example'",
			"node script.js skills install example",
		])
			strictEqual(policy.evaluate({ tool: ToolNames.Bash, args: { command } }).kind, "allow", command);
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
