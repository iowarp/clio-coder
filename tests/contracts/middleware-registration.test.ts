import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import {
	createHookBudgetTracker,
	DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS,
	type HookBudgetTracker,
	resolveHookBudgetsFromEnv,
} from "../../src/domains/middleware/budget.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import {
	MIDDLEWARE_HOOK_BUDGET_MS,
	type MiddlewareDiagnostic,
	type MiddlewareHookRegistration,
	type MiddlewareRuleDefinition,
	registrationFromRuleDefinition,
	runMiddlewareRegistrations,
} from "../../src/domains/middleware/runtime.js";
import type {
	MiddlewareEffect,
	MiddlewareHook,
	MiddlewareHookInput,
	MiddlewareRule,
} from "../../src/domains/middleware/types.js";
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
		// warmupCalls: 0 so the single call is measured immediately; threshold: 1
		// so one overrun is enough to flag steady-state for this focused check.
		const budgetTracker = createHookBudgetTracker({ budgets: { before_tool: 10 }, warmupCalls: 0, threshold: 1 });
		let tick = 0;
		const result = runMiddlewareRegistrations(hookInput(), [registration("reg.slow")], {
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
			budgetTracker,
			now: () => {
				tick += 25;
				return tick;
			},
		});
		deepStrictEqual(result.ruleIds, ["reg.slow"]);
		strictEqual(diagnostics.length, 1);
		const diagnostic = diagnostics[0];
		ok(diagnostic !== undefined && diagnostic.kind === "budget_exceeded");
		strictEqual(diagnostic.registrationId, "reg.slow");
		strictEqual(diagnostic.budgetMs, 10);
		ok(diagnostic.elapsedMs > 10);
		strictEqual(diagnostic.steadyStateWarn, true);
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

/**
 * Drive one registration through the SAME tracker `elapsedPerCall.length` times,
 * one measured evaluation per run, and collect every diagnostic. Each run makes
 * exactly two `now()` calls (startedAt, then startedAt+elapsed), so the injected
 * clock returns 0 then the per-call elapsed — fully deterministic, no real clock.
 */
function runBudgetSequence(
	elapsedPerCall: ReadonlyArray<number>,
	tracker: HookBudgetTracker,
	hook: MiddlewareHook = "turn_end",
): MiddlewareDiagnostic[] {
	const diagnostics: MiddlewareDiagnostic[] = [];
	const reg = registration("reg.assessor", { hooks: [hook], evaluate: () => [] });
	for (const elapsedMs of elapsedPerCall) {
		let call = 0;
		runMiddlewareRegistrations({ hook }, [reg], {
			budgetTracker: tracker,
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
			now: () => {
				call += 1;
				return call === 1 ? 0 : elapsedMs;
			},
		});
	}
	return diagnostics;
}

function budgetSteadyStateFlags(diagnostics: ReadonlyArray<MiddlewareDiagnostic>): boolean[] {
	return diagnostics.map((diagnostic) => (diagnostic.kind === "budget_exceeded" ? diagnostic.steadyStateWarn : false));
}

describe("phase-aware hook budgets", () => {
	it("keeps the legacy flat constant exported and hot-path phases tighter than once-per-turn phases", () => {
		strictEqual(MIDDLEWARE_HOOK_BUDGET_MS, 10);
		ok(DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS.before_tool < DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS.turn_end);
		ok(DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS.after_tool < DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS.turn_end);
		ok(DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS.turn_end < DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS.on_compaction);
	});

	it("resolves each phase's default budget and honors env overrides (per-phase > global > default)", () => {
		const tracker = createHookBudgetTracker();
		for (const hook of Object.keys(DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS) as MiddlewareHook[]) {
			strictEqual(tracker.budgetFor(hook), DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS[hook]);
		}
		deepStrictEqual(resolveHookBudgetsFromEnv({} as NodeJS.ProcessEnv), { ...DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS });
		const overridden = resolveHookBudgetsFromEnv({
			CLIO_HOOK_BUDGET_TURN_END_MS: "5",
			CLIO_HOOK_BUDGET_MS: "200",
		} as NodeJS.ProcessEnv);
		strictEqual(overridden.turn_end, 5); // per-phase wins
		strictEqual(overridden.before_tool, 200); // global applies where no per-phase key
		strictEqual(overridden.on_compaction, 200);
		// A non-positive or non-numeric value is ignored, never zeroing a budget.
		strictEqual(
			resolveHookBudgetsFromEnv({ CLIO_HOOK_BUDGET_TURN_END_MS: "-5" } as NodeJS.ProcessEnv).turn_end,
			DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS.turn_end,
		);
	});

	it("never warns on the first (warmup) call, and a lone post-warmup spike stays telemetry-only", () => {
		const tracker = createHookBudgetTracker({ warmupCalls: 1, windowSize: 5, threshold: 3 });
		// call1 warmup (over), call2 post-warmup spike (over), rest under budget.
		const diagnostics = runBudgetSequence([100, 100, 10, 10, 10], tracker);
		// Only the single post-warmup overrun emits a telemetry diagnostic; the
		// warmup overrun is silent and the under-budget calls emit nothing.
		strictEqual(diagnostics.length, 1);
		const only = diagnostics[0];
		ok(only?.kind === "budget_exceeded");
		strictEqual(only.steadyStateWarn, false);
		strictEqual(only.budgetMs, DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS.turn_end);
	});

	it("warns only once consistently slow: N of the last M post-warmup calls over budget", () => {
		const tracker = createHookBudgetTracker({ warmupCalls: 1, windowSize: 5, threshold: 3 });
		// call1 warmup, then four consecutive post-warmup overruns.
		const diagnostics = runBudgetSequence([100, 100, 100, 100, 100], tracker);
		// One diagnostic per post-warmup overrun (4), warmup silent. steadyStateWarn
		// flips true only once the 3rd of the rolling window is over budget.
		strictEqual(diagnostics.length, 4);
		deepStrictEqual(budgetSteadyStateFlags(diagnostics), [false, false, true, true]);
		for (const diagnostic of diagnostics) {
			ok(diagnostic.kind === "budget_exceeded");
			strictEqual(diagnostic.budgetMs, DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS.turn_end);
			ok(diagnostic.elapsedMs > diagnostic.budgetMs);
		}
	});

	it("stays within budget for a hook that is under its (forgiving) phase budget", () => {
		const tracker = createHookBudgetTracker({ warmupCalls: 1, threshold: 3 });
		// 60ms turn_end is under the 75ms budget: never a diagnostic, even repeated.
		const diagnostics = runBudgetSequence([60, 60, 60, 60, 60], tracker);
		strictEqual(diagnostics.length, 0);
	});

	it("attaches rolling stats (window/over-count/p95) to a steady-state warning", () => {
		const tracker = createHookBudgetTracker({ warmupCalls: 1, windowSize: 5, threshold: 3 });
		const diagnostics = runBudgetSequence([100, 100, 100, 100], tracker);
		const warned = diagnostics.find((d) => d.kind === "budget_exceeded" && d.steadyStateWarn);
		ok(warned?.kind === "budget_exceeded");
		strictEqual(warned.stats.overCount >= 3, true);
		strictEqual(warned.stats.window >= 3, true);
		ok(warned.stats.p95Ms > DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS.turn_end);
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
