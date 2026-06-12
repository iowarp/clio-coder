import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import { type MiddlewareRuleDefinition, runMiddlewareHook } from "../../src/domains/middleware/runtime.js";
import { createMiddlewareContractFromSnapshot } from "../../src/domains/middleware/snapshot.js";
import type { MiddlewareHookInput, MiddlewareRule } from "../../src/domains/middleware/types.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";

function rule(id: string, overrides: Partial<MiddlewareRule> = {}): MiddlewareRule {
	return {
		id,
		source: "builtin",
		description: `test rule ${id}`,
		enabled: true,
		hooks: ["before_tool"],
		effectKinds: ["block_tool"],
		...overrides,
	};
}

function blockDefinition(id: string, overrides: Partial<MiddlewareRuleDefinition> = {}): MiddlewareRuleDefinition {
	return {
		rule: rule(id),
		effects: [{ kind: "block_tool", reason: `blocked by ${id}`, severity: "hard-block" }],
		...overrides,
	};
}

function hookInput(overrides: Partial<MiddlewareHookInput> = {}): MiddlewareHookInput {
	return { hook: "before_tool", toolName: ToolNames.Write, ...overrides };
}

function mockSpec(name: ToolName, output = "tool output"): ToolSpec {
	return {
		name,
		description: "test tool",
		parameters: Type.Object({}),
		baseActionClass: "read",
		metadata: {
			objective: "test objective",
			uiLabel: name,
			retrySafety: "idempotent",
			costLatency: "local_fast",
			resultSizePolicy: { kind: "exact" },
		},
		run: async () => ({ kind: "ok", output }),
	};
}

function allowAllSafety() {
	return {
		classify: () => ({ actionClass: "read" as const, reasons: [] }),
		evaluate: () => ({ kind: "allow" as const, classification: { actionClass: "read" as const, reasons: [] } }),
		observeLoop: () => ({ looping: false, key: "test", count: 0 }),
		scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
		isSubset: () => true,
		audit: { recordCount: () => 0 },
	};
}

describe("middleware runtime evaluation", () => {
	it("emits effects and the rule id when hook and tool match", () => {
		const definition = blockDefinition("policy.block-write", { toolNames: [ToolNames.Write] });
		const result = runMiddlewareHook(hookInput(), [definition]);
		strictEqual(result.effects.length, 1);
		deepStrictEqual(result.effects[0], {
			kind: "block_tool",
			reason: "blocked by policy.block-write",
			severity: "hard-block",
		});
		deepStrictEqual(result.ruleIds, ["policy.block-write"]);
	});

	it("emits nothing for a non-matching hook", () => {
		const definition = blockDefinition("policy.block-write");
		const result = runMiddlewareHook(hookInput({ hook: "after_tool" }), [definition]);
		deepStrictEqual(result.effects, []);
		deepStrictEqual(result.ruleIds, []);
	});

	it("emits nothing for a non-matching tool and requires a tool name when scoped", () => {
		const definition = blockDefinition("policy.block-write", { toolNames: [ToolNames.Write] });
		const otherTool = runMiddlewareHook(hookInput({ toolName: ToolNames.Read }), [definition]);
		deepStrictEqual(otherTool.effects, []);
		deepStrictEqual(otherTool.ruleIds, []);
		const noTool = runMiddlewareHook({ hook: "before_tool" }, [definition]);
		deepStrictEqual(noTool.effects, []);
		deepStrictEqual(noTool.ruleIds, []);
	});

	it("skips disabled rules", () => {
		const definition = blockDefinition("policy.block-write", { rule: rule("policy.block-write", { enabled: false }) });
		const result = runMiddlewareHook(hookInput(), [definition]);
		deepStrictEqual(result.effects, []);
		deepStrictEqual(result.ruleIds, []);
	});

	it("drops effects whose kind the rule does not declare and omits the rule from ruleIds", () => {
		const definition: MiddlewareRuleDefinition = {
			rule: rule("policy.annotate-only", { effectKinds: ["annotate_tool_result"] }),
			effects: [{ kind: "block_tool", reason: "should be dropped", severity: "hard-block" }],
		};
		const result = runMiddlewareHook(hookInput(), [definition]);
		deepStrictEqual(result.effects, []);
		deepStrictEqual(result.ruleIds, []);
	});

	it("keeps rule order stable and reports exactly the rules that fired", () => {
		const definitions: MiddlewareRuleDefinition[] = [
			{
				rule: rule("policy.first", { effectKinds: ["annotate_tool_result"] }),
				effects: [{ kind: "annotate_tool_result", message: "first", severity: "info" }],
			},
			blockDefinition("policy.disabled", { rule: rule("policy.disabled", { enabled: false }) }),
			{
				rule: rule("policy.second", { effectKinds: ["annotate_tool_result"] }),
				effects: [{ kind: "annotate_tool_result", message: "second", severity: "warn" }],
			},
		];
		const result = runMiddlewareHook(hookInput(), definitions);
		deepStrictEqual(result.ruleIds, ["policy.first", "policy.second"]);
		deepStrictEqual(
			result.effects.map((effect) => (effect.kind === "annotate_tool_result" ? effect.message : effect.kind)),
			["first", "second"],
		);
	});
});

describe("middleware bundle registration seam", () => {
	it("evaluates registered definitions through the contract", () => {
		const bundle = createMiddlewareBundle({ ruleDefinitions: [blockDefinition("policy.block-write")] });
		const result = bundle.contract.runHook(hookInput());
		strictEqual(result.effects.length, 1);
		deepStrictEqual(result.ruleIds, ["policy.block-write"]);
		deepStrictEqual(
			bundle.contract.listRules().map((listed) => listed.id),
			["policy.block-write"],
		);
		deepStrictEqual(
			bundle.contract.snapshot().rules.map((listed) => listed.id),
			["policy.block-write"],
		);
	});

	it("drops a registered definition whose id collides with an earlier one", () => {
		const bundle = createMiddlewareBundle({
			ruleDefinitions: [blockDefinition("policy.dup"), blockDefinition("policy.dup")],
		});
		const result = bundle.contract.runHook(hookInput());
		strictEqual(result.effects.length, 1);
		deepStrictEqual(result.ruleIds, ["policy.dup"]);
	});
});

describe("middleware effects through the tool registry", () => {
	it("blocks an admitted tool call when a rule emits block_tool", async () => {
		const bundle = createMiddlewareBundle({
			ruleDefinitions: [blockDefinition("policy.block-write", { toolNames: [ToolNames.Write] })],
		});
		const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
		registry.register(mockSpec(ToolNames.Write));
		registry.register(mockSpec(ToolNames.Read, "read output"));
		const blocked = await registry.invoke({ tool: ToolNames.Write, args: {} });
		strictEqual(blocked.kind, "blocked");
		ok(blocked.kind === "blocked" && blocked.reason === "blocked by policy.block-write");
		const allowed = await registry.invoke({ tool: ToolNames.Read, args: {} });
		strictEqual(allowed.kind, "ok");
		ok(allowed.kind === "ok" && allowed.result.kind === "ok" && allowed.result.output === "read output");
	});

	it("applies annotate_tool_result to the tool result on after_tool", async () => {
		const bundle = createMiddlewareBundle({
			ruleDefinitions: [
				{
					rule: rule("policy.annotate-write", {
						hooks: ["after_tool"],
						effectKinds: ["annotate_tool_result"],
					}),
					toolNames: [ToolNames.Write],
					effects: [{ kind: "annotate_tool_result", message: "remember to run tests", severity: "warn" }],
				},
			],
		});
		const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
		registry.register(mockSpec(ToolNames.Write, "wrote file"));
		const verdict = await registry.invoke({ tool: ToolNames.Write, args: {} });
		strictEqual(verdict.kind, "ok");
		if (verdict.kind !== "ok" || verdict.result.kind !== "ok") throw new Error("expected ok result");
		strictEqual(verdict.result.output, "wrote file\n\n[middleware:warn] remember to run tests");
	});
});

describe("middleware contract from snapshot", () => {
	it("emits no effects for snapshot rules with no builtin definition in this binary", () => {
		const contract = createMiddlewareContractFromSnapshot({
			version: 1,
			rules: [rule("policy.unknown")],
		});
		const result = contract.runHook(hookInput());
		deepStrictEqual(result.effects, []);
		deepStrictEqual(result.ruleIds, []);
		deepStrictEqual(
			contract.listRules().map((listed) => listed.id),
			["policy.unknown"],
		);
	});
});
