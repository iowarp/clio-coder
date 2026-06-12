import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import {
	MIDDLEWARE_HOOK_BUDGET_MS,
	type MiddlewareDiagnostic,
	type MiddlewareHookRegistration,
	type MiddlewareRuleDefinition,
	registrationFromRuleDefinition,
	runMiddlewareRegistrations,
} from "../../src/domains/middleware/runtime.js";
import type { MiddlewareEffect, MiddlewareHookInput, MiddlewareRule } from "../../src/domains/middleware/types.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";

function rule(id: string, overrides: Partial<MiddlewareRule> = {}): MiddlewareRule {
	return {
		id,
		source: "builtin",
		description: `test rule ${id}`,
		enabled: true,
		hooks: ["before_tool"],
		effectKinds: ["annotate_tool_result"],
		...overrides,
	};
}

function annotateDefinition(id: string, message = id): MiddlewareRuleDefinition {
	return {
		rule: rule(id),
		effects: [{ kind: "annotate_tool_result", message, severity: "info" }],
	};
}

function registration(id: string, overrides: Partial<MiddlewareHookRegistration> = {}): MiddlewareHookRegistration {
	return {
		id,
		description: `test registration ${id}`,
		hooks: ["before_tool"],
		evaluate: () => [{ kind: "annotate_tool_result", message: id, severity: "info" }],
		...overrides,
	};
}

function hookInput(overrides: Partial<MiddlewareHookInput> = {}): MiddlewareHookInput {
	return { hook: "before_tool", toolName: ToolNames.Write, ...overrides };
}

function annotationMessages(effects: ReadonlyArray<MiddlewareEffect>): string[] {
	return effects.map((effect) => (effect.kind === "annotate_tool_result" ? effect.message : effect.kind));
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

describe("middleware registration evaluation", () => {
	it("evaluates registrations in array order and accumulates effects and ids", () => {
		const result = runMiddlewareRegistrations(hookInput(), [registration("reg.first"), registration("reg.second")], {
			onDiagnostic: () => {},
		});
		deepStrictEqual(annotationMessages(result.effects), ["reg.first", "reg.second"]);
		deepStrictEqual(result.ruleIds, ["reg.first", "reg.second"]);
	});

	it("matches on hook and exact tool name, and never matches scoped registrations without a tool name", () => {
		const scoped = registration("reg.scoped", { toolNames: [ToolNames.Write] });
		deepStrictEqual(runMiddlewareRegistrations(hookInput(), [scoped]).ruleIds, ["reg.scoped"]);
		deepStrictEqual(runMiddlewareRegistrations(hookInput({ hook: "after_tool" }), [scoped]).ruleIds, []);
		deepStrictEqual(runMiddlewareRegistrations(hookInput({ toolName: ToolNames.Read }), [scoped]).ruleIds, []);
		deepStrictEqual(runMiddlewareRegistrations({ hook: "before_tool" }, [scoped]).ruleIds, []);
	});

	it("isolates a throwing registration: later registrations still run and the failure is reported", () => {
		const diagnostics: MiddlewareDiagnostic[] = [];
		const result = runMiddlewareRegistrations(
			hookInput(),
			[
				registration("reg.throws", {
					evaluate: () => {
						throw new Error("registration exploded");
					},
				}),
				registration("reg.survivor"),
			],
			{ onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
		);
		deepStrictEqual(result.ruleIds, ["reg.survivor"]);
		strictEqual(diagnostics.length, 1);
		deepStrictEqual(diagnostics[0], {
			kind: "hook_failed",
			registrationId: "reg.throws",
			hook: "before_tool",
			message: "registration exploded",
		});
	});

	it("reports a budget overrun without dropping the registration's effects", () => {
		const diagnostics: MiddlewareDiagnostic[] = [];
		let tick = 0;
		const result = runMiddlewareRegistrations(hookInput(), [registration("reg.slow")], {
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
			now: () => {
				tick += MIDDLEWARE_HOOK_BUDGET_MS + 15;
				return tick;
			},
		});
		deepStrictEqual(result.ruleIds, ["reg.slow"]);
		strictEqual(diagnostics.length, 1);
		const diagnostic = diagnostics[0];
		ok(diagnostic !== undefined && diagnostic.kind === "budget_exceeded");
		strictEqual(diagnostic.registrationId, "reg.slow");
		strictEqual(diagnostic.budgetMs, MIDDLEWARE_HOOK_BUDGET_MS);
		ok(diagnostic.elapsedMs > MIDDLEWARE_HOOK_BUDGET_MS);
	});

	it("survives a throwing diagnostic sink", () => {
		const result = runMiddlewareRegistrations(
			hookInput(),
			[
				registration("reg.throws", {
					evaluate: () => {
						throw new Error("boom");
					},
				}),
				registration("reg.survivor"),
			],
			{
				onDiagnostic: () => {
					throw new Error("sink exploded");
				},
			},
		);
		deepStrictEqual(result.ruleIds, ["reg.survivor"]);
	});

	it("clones emitted effects so a registration's shared effect object cannot be mutated downstream", () => {
		const shared: MiddlewareEffect = { kind: "annotate_tool_result", message: "original", severity: "info" };
		const registrations = [registration("reg.shared", { evaluate: () => [shared] })];
		const first = runMiddlewareRegistrations(hookInput(), registrations);
		const effect = first.effects[0];
		ok(effect !== undefined && effect.kind === "annotate_tool_result");
		effect.message = "mutated";
		const second = runMiddlewareRegistrations(hookInput(), registrations);
		deepStrictEqual(annotationMessages(second.effects), ["original"]);
	});

	it("hands each registration its own input clone", () => {
		const result = runMiddlewareRegistrations(hookInput({ metadata: { posture: "operating" } }), [
			registration("reg.mutator", {
				evaluate: (input) => {
					(input as { toolName?: string }).toolName = "tampered";
					return [];
				},
			}),
			registration("reg.observer", {
				evaluate: (input) => [{ kind: "annotate_tool_result", message: `saw ${input.toolName}`, severity: "info" }],
			}),
		]);
		deepStrictEqual(annotationMessages(result.effects), [`saw ${ToolNames.Write}`]);
		strictEqual(result.input.toolName, ToolNames.Write);
	});

	it("wraps a declarative rule definition as a registration with identical filtering", () => {
		const wrapped = registrationFromRuleDefinition({
			rule: rule("policy.declared", { effectKinds: ["annotate_tool_result"] }),
			effects: [
				{ kind: "annotate_tool_result", message: "kept", severity: "info" },
				{ kind: "block_tool", reason: "dropped: kind not declared", severity: "hard-block" },
			],
		});
		const result = runMiddlewareRegistrations(hookInput(), [wrapped]);
		deepStrictEqual(annotationMessages(result.effects), ["kept"]);
		deepStrictEqual(result.ruleIds, ["policy.declared"]);
	});
});

describe("middleware bundle with coded registrations", () => {
	it("evaluates declarative rules before coded registrations", () => {
		const bundle = createMiddlewareBundle({
			ruleDefinitions: [annotateDefinition("policy.rule")],
			registrations: [registration("reg.coded")],
		});
		const result = bundle.contract.runHook(hookInput());
		deepStrictEqual(result.ruleIds, ["policy.rule", "reg.coded"]);
		deepStrictEqual(annotationMessages(result.effects), ["policy.rule", "reg.coded"]);
	});

	it("drops a coded registration whose id collides with a declarative rule", () => {
		const bundle = createMiddlewareBundle({
			ruleDefinitions: [annotateDefinition("policy.dup", "from rule")],
			registrations: [
				registration("policy.dup", {
					evaluate: () => [{ kind: "annotate_tool_result", message: "from registration", severity: "info" }],
				}),
			],
		});
		const result = bundle.contract.runHook(hookInput());
		deepStrictEqual(result.ruleIds, ["policy.dup"]);
		deepStrictEqual(annotationMessages(result.effects), ["from rule"]);
	});

	it("keeps coded registrations out of listRules and the worker snapshot", () => {
		const bundle = createMiddlewareBundle({
			ruleDefinitions: [annotateDefinition("policy.rule")],
			registrations: [registration("reg.coded")],
		});
		deepStrictEqual(
			bundle.contract.listRules().map((listed) => listed.id),
			["nudge.stalled-turn", "policy.rule"],
		);
		deepStrictEqual(
			bundle.contract.snapshot().rules.map((listed) => listed.id),
			["nudge.stalled-turn", "policy.rule"],
		);
	});

	it("routes diagnostics from contract evaluation to the bundle's sink", () => {
		const diagnostics: MiddlewareDiagnostic[] = [];
		const bundle = createMiddlewareBundle({
			registrations: [
				registration("reg.throws", {
					evaluate: () => {
						throw new Error("boom");
					},
				}),
			],
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		});
		deepStrictEqual(bundle.contract.runHook(hookInput()).ruleIds, []);
		strictEqual(diagnostics.length, 1);
		strictEqual(diagnostics[0]?.kind, "hook_failed");
	});
});

describe("coded registrations through the tool registry", () => {
	it("blocks an admitted tool call when a coded registration emits block_tool", async () => {
		const bundle = createMiddlewareBundle({
			registrations: [
				registration("reg.block-write", {
					toolNames: [ToolNames.Write],
					evaluate: () => [{ kind: "block_tool", reason: "blocked by reg.block-write", severity: "hard-block" }],
				}),
			],
		});
		const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
		registry.register(mockSpec(ToolNames.Write));
		registry.register(mockSpec(ToolNames.Read, "read output"));
		const blocked = await registry.invoke({ tool: ToolNames.Write, args: {} });
		strictEqual(blocked.kind, "blocked");
		ok(blocked.kind === "blocked" && blocked.reason === "blocked by reg.block-write");
		const allowed = await registry.invoke({ tool: ToolNames.Read, args: {} });
		strictEqual(allowed.kind, "ok");
		ok(allowed.kind === "ok" && allowed.result.kind === "ok" && allowed.result.output === "read output");
	});

	it("lets a stateful coded registration block only after its own threshold", async () => {
		let calls = 0;
		const bundle = createMiddlewareBundle({
			registrations: [
				registration("reg.stateful", {
					hooks: ["before_tool", "after_tool"],
					toolNames: [ToolNames.Read],
					evaluate: () => {
						calls += 1;
						if (calls < 3) return [];
						return [{ kind: "block_tool", reason: "threshold reached", severity: "hard-block" }];
					},
				}),
			],
		});
		const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
		registry.register(mockSpec(ToolNames.Read, "read output"));
		const first = await registry.invoke({ tool: ToolNames.Read, args: {} });
		strictEqual(first.kind, "ok");
		// before_tool and after_tool each fire once per successful call, so the
		// third evaluation lands on the second call's before_tool gate.
		const second = await registry.invoke({ tool: ToolNames.Read, args: {} });
		strictEqual(second.kind, "blocked");
		ok(second.kind === "blocked" && second.reason === "threshold reached");
	});
});
