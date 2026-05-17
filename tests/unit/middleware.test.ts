import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BUILTIN_MIDDLEWARE_RULE_IDS,
	createMiddlewareBundle,
	createMiddlewareContractFromSnapshot,
	createMiddlewareSnapshot,
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

	it("returns deterministic no-op hook results without advertising inactive rules", () => {
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
		deepStrictEqual(first.ruleIds, []);
		notStrictEqual(first.input, input);
	});

	it("ships no built-in no-op rules", () => {
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
			ruleIds: [],
		});
	});

	it("does not subscribe inactive built-ins to hooks", () => {
		const rules = listMiddlewareRules();
		strictEqual(rules.length, 0);
		for (const hook of MIDDLEWARE_HOOKS) {
			deepStrictEqual(middlewareRuleIdsForHook(hook), []);
		}
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
