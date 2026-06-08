import { strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { createModesBundle } from "../../src/domains/modes/extension.js";
import { isActionAllowed, isToolVisible } from "../../src/domains/modes/matrix.js";
import { classify } from "../../src/domains/safety/action-classifier.js";
import { assessFinishContract } from "../../src/domains/safety/finish-contract.js";
import { createLoopState, observe } from "../../src/domains/safety/loop-detector.js";
import { compilePathPolicy, evaluatePathPolicy } from "../../src/domains/safety/path-policy.js";
import { DEFAULT_SCOPE, isSubset, READONLY_SCOPE, SUPER_SCOPE } from "../../src/domains/safety/scope.js";

describe("contracts/safety", () => {
	const ORIGINAL_ENV = { ...process.env };
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-safety-"));
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
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

	it("evaluates safety scope subsets", () => {
		strictEqual(isSubset(READONLY_SCOPE, DEFAULT_SCOPE), true);
		strictEqual(isSubset(READONLY_SCOPE, SUPER_SCOPE), true);
		strictEqual(isSubset(SUPER_SCOPE, DEFAULT_SCOPE), false); // SUPER requires more permissions than DEFAULT
		strictEqual(isSubset(DEFAULT_SCOPE, SUPER_SCOPE), true);
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

	it("evaluates mode tool visibility and action permissions", () => {
		// default mode visibility
		strictEqual(isToolVisible("default", ToolNames.Write), true);
		strictEqual(isToolVisible("advise", ToolNames.Write), false);

		// action allowances
		strictEqual(isActionAllowed("default", "system_modify"), false);
		strictEqual(isActionAllowed("super", "system_modify"), true);
		strictEqual(isActionAllowed("advise", "execute"), false);
	});

	it("supports super elevation and modes lifecycle", () => {
		const bus = createSafeEventBus();
		const mockContext: DomainContext = { bus, getContract: () => undefined };
		const bundle = createModesBundle(mockContext);
		const contract = bundle.contract;

		strictEqual(contract.current(), "default");

		// Request elevation
		contract.requestSuper("test-harness");
		strictEqual(contract.current(), "default"); // still default until confirmed

		// Confirm elevation
		const nextMode = contract.confirmSuper({ requestedBy: "test-harness", acceptedAt: Date.now() });
		strictEqual(nextMode, "super");
		strictEqual(contract.current(), "super");

		// elevatedModeFor checks
		strictEqual(contract.elevatedModeFor("system_modify"), null); // already super
	});
});
