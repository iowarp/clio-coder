import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BUILTIN_MIDDLEWARE_RULE_IDS,
	createMiddlewareBundle,
	createMiddlewareContractFromSnapshot,
	createMiddlewareSnapshot,
	MIDDLEWARE_EFFECT_KINDS,
	MIDDLEWARE_HOOKS,
	type MiddlewareHookInput,
	validateMiddlewareEffect,
	validateMiddlewareRule,
} from "../../src/domains/middleware/index.js";
import { listMiddlewareRules, middlewareRuleIdsForHook } from "../../src/domains/middleware/rules.js";

describe("middleware runtime", () => {
	it("covers every canonical hook name with a no-op result", () => {
		const contract = createMiddlewareBundle().contract;
		const rules = contract.listRules();
		for (const hook of MIDDLEWARE_HOOKS) {
			const input: MiddlewareHookInput = {
				hook,
				runId: "run-1",
				sessionId: "session-1",
				turnId: `turn-${hook}`,
				toolCallId: "tool-1",
				correlationId: "corr-1",
				metadata: { hook },
			};
			const result = contract.runHook(input);
			strictEqual(result.hook, hook);
			deepStrictEqual(result.input, input);
			deepStrictEqual(result.effects, []);
			deepStrictEqual(
				result.ruleIds,
				rules.filter((rule) => rule.hooks.includes(hook)).map((rule) => rule.id),
			);
		}
	});

	it("returns deterministic no-op hook results while preserving provenance", () => {
		const contract = createMiddlewareBundle().contract;
		const input: MiddlewareHookInput = {
			hook: "before_tool",
			runId: "run-42",
			sessionId: "session-7",
			turnId: "turn-3",
			toolCallId: "tool-call-9",
			correlationId: "corr-11",
			toolName: "bash",
			metadata: { attempt: 1, blocked: false },
		};

		const first = contract.runHook(input);
		const second = contract.runHook({ ...input, metadata: { attempt: 1, blocked: false } });

		deepStrictEqual(second, first);
		deepStrictEqual(first.effects, []);
		deepStrictEqual(first.ruleIds, ["publish-state-guard", "framework-reminder", "science.preserve-checkpoints"]);
		notStrictEqual(first.input, input);
	});

	it("lists built-in rules in stable metadata order", () => {
		const contract = createMiddlewareBundle().contract;
		const first = contract.listRules();
		const second = contract.listRules();

		deepStrictEqual(
			first.map((rule) => rule.id),
			[...BUILTIN_MIDDLEWARE_RULE_IDS],
		);
		deepStrictEqual(second, first);
		notStrictEqual(second, first);
		for (const rule of first) {
			strictEqual(validateMiddlewareRule(rule).valid, true);
		}
	});

	it("creates deterministic worker-safe snapshots and contracts", () => {
		const contract = createMiddlewareBundle().contract;
		const first = contract.snapshot();
		const second = createMiddlewareSnapshot(contract.listRules());

		deepStrictEqual(second, first);
		deepStrictEqual(
			first.rules.map((rule) => rule.id),
			[...BUILTIN_MIDDLEWARE_RULE_IDS],
		);

		const workerContract = createMiddlewareContractFromSnapshot(first);
		deepStrictEqual(workerContract.listRules(), first.rules);
		deepStrictEqual(workerContract.runHook({ hook: "after_tool", toolName: "read" }), {
			hook: "after_tool",
			input: { hook: "after_tool", toolName: "read" },
			effects: [],
			ruleIds: [
				"publish-state-guard",
				"proxy-validation-detector",
				"science.no-existence-only-validation",
				"science.preserve-checkpoints",
				"science.unit-vs-scheduler-validation",
			],
		});
	});

	it("ships exactly eight built-in rules with the three science rules first-class", () => {
		const rules = listMiddlewareRules();
		strictEqual(rules.length, 8);
		const ids = rules.map((rule) => rule.id);
		ok(ids.includes("science.no-existence-only-validation"));
		ok(ids.includes("science.preserve-checkpoints"));
		ok(ids.includes("science.unit-vs-scheduler-validation"));
		const scienceRules = rules.filter((rule) => rule.id.startsWith("science."));
		strictEqual(scienceRules.length, 3);
		const allowedHooks = new Set<string>(MIDDLEWARE_HOOKS);
		const allowedEffects = new Set<string>(MIDDLEWARE_EFFECT_KINDS);
		for (const rule of scienceRules) {
			ok(rule.hooks.length > 0, `${rule.id} hooks must be non-empty`);
			ok(rule.effectKinds.length > 0, `${rule.id} effectKinds must be non-empty`);
			for (const hook of rule.hooks) ok(allowedHooks.has(hook), `${rule.id} bad hook ${hook}`);
			for (const kind of rule.effectKinds) ok(allowedEffects.has(kind), `${rule.id} bad effect ${kind}`);
		}
	});

	it("subscribes the science rules to the documented hooks", () => {
		const beforeFinish = middlewareRuleIdsForHook("before_finish");
		ok(beforeFinish.includes("finish-contract-check"));
		ok(beforeFinish.includes("science.no-existence-only-validation"));
		ok(beforeFinish.includes("science.unit-vs-scheduler-validation"));

		const beforeTool = middlewareRuleIdsForHook("before_tool");
		ok(beforeTool.includes("science.preserve-checkpoints"));

		const afterTool = middlewareRuleIdsForHook("after_tool");
		ok(afterTool.includes("science.no-existence-only-validation"));
		ok(afterTool.includes("science.preserve-checkpoints"));
		ok(afterTool.includes("science.unit-vs-scheduler-validation"));
	});

	it("clones science rules on each listMiddlewareRules call without sharing arrays", () => {
		const first = listMiddlewareRules();
		const second = listMiddlewareRules();
		const firstScience = first.find((rule) => rule.id === "science.no-existence-only-validation");
		const secondScience = second.find((rule) => rule.id === "science.no-existence-only-validation");
		ok(firstScience);
		ok(secondScience);
		deepStrictEqual(secondScience, firstScience);
		notStrictEqual(secondScience, firstScience);
		notStrictEqual(secondScience.hooks, firstScience.hooks);
		notStrictEqual(secondScience.effectKinds, firstScience.effectKinds);
	});

	it("rejects malformed declarative rule and effect data", () => {
		const ruleResult = validateMiddlewareRule({
			id: "bad-rule",
			source: "builtin",
			description: "bad declarative data",
			enabled: true,
			hooks: ["before_tool", "not_a_hook"],
			effectKinds: ["inject_reminder"],
			handler: "user JavaScript must not be accepted",
		});
		strictEqual(ruleResult.valid, false);
		deepStrictEqual(
			ruleResult.issues.map((issue) => issue.path),
			["$.handler", "$.hooks[1]"],
		);

		const effectResult = validateMiddlewareEffect({
			kind: "block_tool",
			reason: " ",
			severity: "warn",
		});
		strictEqual(effectResult.valid, false);
		deepStrictEqual(
			effectResult.issues.map((issue) => issue.path),
			["$.reason", "$.severity"],
		);
	});
});
