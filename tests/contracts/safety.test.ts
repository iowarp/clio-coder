import { strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { classify } from "../../src/domains/safety/action-classifier.js";
import { createSafetyBundle } from "../../src/domains/safety/extension.js";
import { assessFinishContract } from "../../src/domains/safety/finish-contract.js";
import { createLoopState, observe } from "../../src/domains/safety/loop-detector.js";
import { compilePathPolicy, evaluatePathPolicy } from "../../src/domains/safety/path-policy.js";
import { CONFIRMED_SCOPE, isSubset, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";

describe("contracts/safety", () => {
	const ORIGINAL_ENV = { ...process.env };
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-safety-"));
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_STATE_DIR = join(scratch, "state");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		resetXdgCache();
	});

	afterEach(() => {
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	it("classifies tool actions correctly", () => {
		// Read tools
		strictEqual(classify({ tool: "read", args: { path: "/x" } }).actionClass, "read");
		strictEqual(classify({ tool: "grep", args: {} }).actionClass, "read");

		// Write tools
		const cwdPath = `${process.cwd()}/scratch.txt`;
		strictEqual(classify({ tool: "write", args: { path: cwdPath } }).actionClass, "write");

		// System modify (escalations)
		strictEqual(classify({ tool: "write", args: { path: "/etc/nope" } }).actionClass, "system_modify");
		strictEqual(classify({ tool: "bash", args: { command: "sudo rm /foo" } }).actionClass, "system_modify");

		// Git destructive commands
		strictEqual(classify({ tool: "bash", args: { command: "git reset --hard HEAD" } }).actionClass, "git_destructive");

		// Execute tools
		strictEqual(classify({ tool: "bash", args: { command: "ls -la" } }).actionClass, "execute");
	});

	it("suppresses finish-contract advisories for explicit read-only recall/status drills", () => {
		const assessment = assessFinishContract({
			assistantText: "Reads complete; ready for next instruction.",
			currentUserText: "Use read only. Recall the sentinel and report status check only.",
		});
		strictEqual(assessment.kind, "ok");
		if (assessment.kind === "ok") strictEqual(assessment.reason, "read_only_status_turn");
	});

	it("recognizes run_task verification-family scripts as finish-contract evidence", () => {
		const assessment = assessFinishContract({
			assistantText: "Implemented the change and tests passed.",
			sessionEntries: [
				{
					kind: "message",
					role: "tool_call",
					payload: { name: "run_task", toolCallId: "call-1", args: { task: "test:contracts" } },
				},
				{
					kind: "message",
					role: "tool_result",
					payload: { toolName: "run_task", toolCallId: "call-1", result: { details: { exitCode: 0 } } },
				},
			],
		});

		strictEqual(assessment.kind, "ok");
		if (assessment.kind === "ok") {
			strictEqual(assessment.reason, "validation_evidence");
			strictEqual(assessment.evidence[0]?.summary, "validation command passed: npm run test:contracts");
		}
	});

	it("evaluates safety scope subsets", () => {
		strictEqual(isSubset(READONLY_SCOPE, WORKSPACE_SCOPE), true);
		strictEqual(isSubset(READONLY_SCOPE, CONFIRMED_SCOPE), true);
		strictEqual(isSubset(CONFIRMED_SCOPE, WORKSPACE_SCOPE), false);
		strictEqual(isSubset(WORKSPACE_SCOPE, CONFIRMED_SCOPE), true);
	});

	it("compiles and enforces path policies", () => {
		const policy = compilePathPolicy(
			{
				zeroAccessPaths: ["secrets"],
				readOnlyPaths: ["vendor"],
				noDeletePaths: ["src"],
			},
			"/repo",
		);

		// zeroAccessPaths blocks read and write
		strictEqual(evaluatePathPolicy(policy, "read", "/repo/secrets/key").kind, "block");
		strictEqual(evaluatePathPolicy(policy, "write", "/repo/secrets/key").kind, "block");

		// readOnlyPaths allows read, blocks write/delete
		strictEqual(evaluatePathPolicy(policy, "read", "/repo/vendor/lib.ts").kind, "allow");
		strictEqual(evaluatePathPolicy(policy, "write", "/repo/vendor/lib.ts").kind, "block");
		strictEqual(evaluatePathPolicy(policy, "delete", "/repo/vendor/lib.ts").kind, "block");

		// noDeletePaths allows write, blocks delete
		strictEqual(evaluatePathPolicy(policy, "write", "/repo/src/app.ts").kind, "allow");
		strictEqual(evaluatePathPolicy(policy, "delete", "/repo/src/app.ts").kind, "block");
	});

	it("detects command/action loops", () => {
		let state = createLoopState({ maxRepeats: 3, windowMs: 1000 });

		state = observe(state, "my-key", 0)[0];
		state = observe(state, "my-key", 10)[0];
		const [, verdict] = observe(state, "my-key", 20);

		strictEqual(verdict.looping, true);
		strictEqual(verdict.count, 3);
	});

	it("asks once for confirmable actions and resumes them with confirmed posture", () => {
		const bus = createSafeEventBus();
		const mockContext: DomainContext = { bus, getContract: () => undefined };
		const bundle = createSafetyBundle(mockContext);
		const contract = bundle.contract;

		const call = { tool: ToolNames.Bash, args: { command: "gcloud iam policies lint-condition" } };
		const first = contract.evaluate(call);
		strictEqual(first.kind, "ask");

		const confirmed = contract.evaluate(call, "confirmed");
		strictEqual(confirmed.kind, "allow");
	});

	it("honors authored ask rules for confirmable git operations (sd-01 M3)", () => {
		const bus = createSafeEventBus();
		const mockContext: DomainContext = { bus, getContract: () => undefined };
		const bundle = createSafetyBundle(mockContext);
		const contract = bundle.contract;

		// `git stash drop` carries ask: true in damage-control-rules.yaml; it
		// parks for one-shot confirmation instead of hard-blocking, and a
		// confirmed posture admits it.
		const call = { tool: ToolNames.Bash, args: { command: "git stash drop" } };
		const first = contract.evaluate(call);
		strictEqual(first.kind, "ask");
		strictEqual(first.classification.actionClass, "git_destructive");
		const confirmed = contract.evaluate(call, "confirmed");
		strictEqual(confirmed.kind, "allow");
	});

	it("keeps classifier git escalation and block rules as hard blocks at every posture", () => {
		const bus = createSafeEventBus();
		const mockContext: DomainContext = { bus, getContract: () => undefined };
		const bundle = createSafetyBundle(mockContext);
		const contract = bundle.contract;

		// block: true rule (git push --force): blocked even when confirmed.
		const forcePush = { tool: ToolNames.Bash, args: { command: "git push --force origin main" } };
		strictEqual(contract.evaluate(forcePush).kind, "block");
		strictEqual(contract.evaluate(forcePush, "confirmed").kind, "block");

		// Classifier-only escalation (git reset --hard has a block rule too,
		// but git restore --source has no ask rule): stays blocked.
		const restoreSource = { tool: ToolNames.Bash, args: { command: "git restore --source=HEAD~3 src/" } };
		strictEqual(contract.evaluate(restoreSource).kind, "block");
		strictEqual(contract.evaluate(restoreSource).classification.actionClass, "git_destructive");
	});

	it("hardens the pack for previously missing deletion verbs (sd-01 M4)", () => {
		const bus = createSafeEventBus();
		const mockContext: DomainContext = { bus, getContract: () => undefined };
		const contract = createSafetyBundle(mockContext).contract;
		const bash = (command: string) => ({ tool: ToolNames.Bash, args: { command } });

		// Mass and secure deleters block at every posture.
		const blocked: Array<[string, string]> = [
			["find . -name '*.log' -delete", "find-delete"],
			["rsync -a --delete src/ dst/", "rsync-delete"],
			["rsync -a --delete-after src/ dst/", "rsync-delete"],
			["shred -u secrets.txt", "shred-file"],
		];
		for (const [command, ruleId] of blocked) {
			const decision = contract.evaluate(bash(command));
			strictEqual(decision.kind, "block", `${command} must block`);
			strictEqual(decision.kind === "block" && decision.match?.ruleId, ruleId, `${command} must hit ${ruleId}`);
			strictEqual(contract.evaluate(bash(command), "confirmed").kind, "block", `${command} must block confirmed`);
		}

		// Single-file truncation is an authored confirm rail: ask, then allow once confirmed.
		const askRails: Array<[string, string]> = [
			["truncate -s 0 server.log", "truncate-size-zero"],
			["truncate --size=0 server.log", "truncate-size-zero"],
			[": > server.log", "colon-truncate"],
			[":> server.log", "colon-truncate"],
		];
		for (const [command, ruleId] of askRails) {
			const decision = contract.evaluate(bash(command));
			strictEqual(decision.kind, "ask", `${command} must ask`);
			strictEqual(decision.kind === "ask" && decision.match?.ruleId, ruleId, `${command} must hit ${ruleId}`);
			strictEqual(contract.evaluate(bash(command), "confirmed").kind, "allow", `${command} must allow confirmed`);
		}
	});

	it("catches the M4 deletion verbs through shell operators (sd-01 I3 precondition)", () => {
		const bus = createSafeEventBus();
		const mockContext: DomainContext = { bus, getContract: () => undefined };
		const contract = createSafetyBundle(mockContext).contract;
		const bash = (command: string) => ({ tool: ToolNames.Bash, args: { command } });

		// The pack scans the full serialized command string before any operator
		// handling, so the deletion verb is caught even when it rides in behind
		// a recognized prefix. Assert the rule id so this cannot pass vacuously
		// via an operator denial.
		const blockedThroughOperators: Array<[string, string]> = [
			["git status && find /tmp/clio-i3 -delete", "find-delete"],
			["echo syncing; rsync -a --delete src/ dst/", "rsync-delete"],
			["ls | shred -zu notes.txt", "shred-file"],
		];
		for (const [command, ruleId] of blockedThroughOperators) {
			const decision = contract.evaluate(bash(command));
			strictEqual(decision.kind, "block", `${command} must block`);
			strictEqual(decision.kind === "block" && decision.match?.ruleId, ruleId, `${command} must hit ${ruleId}`);
		}

		const truncateBehindPrefix = contract.evaluate(bash("echo rotating && truncate -s 0 server.log"));
		strictEqual(truncateBehindPrefix.kind, "ask");
		strictEqual(truncateBehindPrefix.kind === "ask" && truncateBehindPrefix.match?.ruleId, "truncate-size-zero");

		const colonBehindPrefix = contract.evaluate(bash("echo rotating; : > server.log"));
		strictEqual(colonBehindPrefix.kind, "ask");
		strictEqual(colonBehindPrefix.kind === "ask" && colonBehindPrefix.match?.ruleId, "colon-truncate");
	});
});
