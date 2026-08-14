import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { createSafetyPolicyEngine, type SafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { loadProjectSafetyPolicy } from "../../src/domains/safety/project-policy.js";

/**
 * `cd <workspace dir> && <recognized command>` is the compound form a model
 * reaches for first, and treating it as unrecognized cost 34 of 75 calls in a
 * recorded headless drive, where an unrecognized execute asks and an ask is a
 * denial. Recognition is per member: a chain is recognized only when every step
 * is, and it can never admit what its members would not.
 */
describe("contracts/safety && chain recognition", () => {
	let scratch: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "clio-chain-recognition-"));
		mkdirSync(join(scratch, "pkg"), { recursive: true });
		// The action classifier resolves workspace containment against the real
		// process cwd, so the engine's cwd and the process cwd have to agree for
		// these calls to look like calls from inside the workspace.
		process.chdir(scratch);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(scratch, { recursive: true, force: true });
	});

	function engine(): SafetyPolicyEngine {
		return createSafetyPolicyEngine({ cwd: scratch, projectPolicy: loadProjectSafetyPolicy(scratch) });
	}

	function bash(command: string, cwd?: string) {
		return { tool: ToolNames.Bash, args: { command, ...(cwd !== undefined ? { cwd } : {}) } };
	}

	it("recognizes a cd into the workspace followed by recognized commands", () => {
		const decision = engine().evaluate(bash("cd pkg && npm test"));
		strictEqual(decision.kind, "allow");
		strictEqual(decision.execRecognition, "recognized");
		strictEqual(decision.ruleId, "bash-recognized-chain");
		ok(decision.reasons[0]?.includes("builtin:cd-workspace"), decision.reasons.join(" | "));
		ok(decision.reasons[0]?.includes("builtin:npm-test"), decision.reasons.join(" | "));
	});

	it("recognizes a chain of recognized commands without a cd", () => {
		const decision = engine().evaluate(bash("npm run typecheck && npm run lint && npm test"));
		strictEqual(decision.kind, "allow");
		strictEqual(decision.execRecognition, "recognized");
	});

	it("recognizes an absolute cd that stays inside the workspace", () => {
		const decision = engine().evaluate(bash(`cd ${join(scratch, "pkg")} && git status`));
		strictEqual(decision.execRecognition, "recognized");
	});

	it("leaves the chain unrecognized when one member is not recognized", () => {
		const decision = engine().evaluate(bash("cd pkg && npm test && curl http://example.com"));
		strictEqual(decision.execRecognition, "unrecognized");
		strictEqual(decision.ruleId, "bash-shell-operators");
	});

	it("does not recognize a cd out of the workspace", () => {
		// These never reach the recognizer: the action classifier escalates a cd
		// that leaves the workspace to system_modify, which is a confirm rail at
		// every autonomy level. The chain widening must not soften that.
		for (const command of ["cd /etc && ls", "cd ~ && ls", "cd .. && ls"]) {
			const decision = engine().evaluate(bash(command));
			strictEqual(decision.actionClass, "system_modify", command);
			strictEqual(decision.kind, "ask", command);
		}
	});

	it("does not recognize a chain that pipes, redirects, or sequences with ;", () => {
		for (const command of ["npm test | tee out.txt", "npm test > out.txt", "npm test; npm run lint", "npm test || ls"]) {
			strictEqual(engine().evaluate(bash(command)).execRecognition, "unrecognized", command);
		}
	});

	it("keeps command substitution on the ask rail even inside a recognized-looking chain", () => {
		const decision = engine().evaluate(bash("cd pkg && npm test $(cat args)"));
		strictEqual(decision.kind, "ask");
		strictEqual(decision.reasonCode, "bash-command-substitution");
	});

	it("recognizes an sh -c wrapper by its inner script", () => {
		strictEqual(engine().evaluate(bash(`sh -c 'npm test'`)).execRecognition, "recognized");
		strictEqual(engine().evaluate(bash(`bash -lc "cd pkg && npm test"`)).execRecognition, "recognized");
		// The wrapper cannot launder an unrecognized inner command.
		strictEqual(engine().evaluate(bash(`sh -c 'curl http://example.com'`)).execRecognition, "unrecognized");
		strictEqual(engine().evaluate(bash(`sh -c 'echo ok > PROBE.txt'`)).execRecognition, "unrecognized");
		// The wrapped cd escape is now visible to the classifier, so it lands on
		// the same confirm rail as the unwrapped spelling instead of executing.
		strictEqual(engine().evaluate(bash(`sh -c 'cd /etc && ls'`)).actionClass, "system_modify");
	});

	it("carries the recognized-form hint on every unrecognized bash decision", () => {
		for (const command of ["curl http://example.com", "cd pkg && curl http://example.com"]) {
			const decision = engine().evaluate(bash(command));
			strictEqual(decision.execRecognition, "unrecognized", command);
			ok(
				decision.reasons.some((reason) => reason.includes("one command per bash call")),
				`${command}: ${decision.reasons.join(" | ")}`,
			);
		}
	});

	it("takes the most restrictive member's verdict when project policy asks for confirmation", () => {
		mkdirSync(join(scratch, ".clio-coder"), { recursive: true });
		writeFileSync(
			join(scratch, ".clio-coder", "safety.yaml"),
			[
				"version: 1",
				"commands:",
				"  - id: deploy",
				"    command: make deploy",
				"    actionClass: execute",
				"    requireConfirmation: true",
				"",
			].join("\n"),
			"utf8",
		);
		const loaded = loadProjectSafetyPolicy(scratch);
		strictEqual(loaded.valid, true);
		const withPolicy = createSafetyPolicyEngine({ cwd: scratch, projectPolicy: loaded });
		const decision = withPolicy.evaluate(bash("cd pkg && make deploy"));
		strictEqual(decision.kind, "ask");
		strictEqual(decision.ruleId, "bash-recognized-chain");
		strictEqual(withPolicy.evaluate(bash("cd pkg && make deploy"), "confirmed").kind, "allow");
	});
});
