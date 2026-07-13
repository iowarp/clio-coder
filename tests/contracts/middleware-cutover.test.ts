import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import type { MiddlewareDiagnostic } from "../../src/domains/middleware/runtime.js";
import { createMiddlewareContractFromSnapshot } from "../../src/domains/middleware/snapshot.js";
import { createMiddlewareToolChoiceControl } from "../../src/domains/middleware/tool-choice-control.js";
import { MIDDLEWARE_EFFECT_KINDS, MIDDLEWARE_HOOKS } from "../../src/domains/middleware/types.js";
import { validateMiddlewareEffect, validateMiddlewareRule } from "../../src/domains/middleware/validate.js";
import {
	middlewareBudgetWarningKey,
	middlewareHookFailedNotice,
	middlewareHookFailedSessionNotice,
} from "../../src/interactive/bus-notices.js";

describe("contracts/middleware-cutover end-state enums", () => {
	it("the hook enum is exactly the five designed lifecycle events", () => {
		deepStrictEqual([...MIDDLEWARE_HOOKS], ["before_tool", "after_tool", "turn_start", "turn_end", "on_compaction"]);
	});

	it("the effect vocabulary is exactly the seven consumed kinds", () => {
		deepStrictEqual(
			[...MIDDLEWARE_EFFECT_KINDS],
			[
				"inject_reminder",
				"annotate_tool_result",
				"block_tool",
				"protect_path",
				"request_continuation",
				"require_tool",
				"lock_tools",
			],
		);
	});

	it("validates a named required-tool effect", () => {
		const effect = validateMiddlewareEffect({ kind: "require_tool", toolName: "dispatch" });
		deepStrictEqual(effect, { valid: true, effect: { kind: "require_tool", toolName: "dispatch" }, issues: [] });
	});

	it("validates a text-only tool lock", () => {
		deepStrictEqual(validateMiddlewareEffect({ kind: "lock_tools" }), {
			valid: true,
			effect: { kind: "lock_tools" },
			issues: [],
		});
	});

	it("carries required tools across rounds and lets a text-only lock win", () => {
		const control = createMiddlewareToolChoiceControl();
		control.apply([{ kind: "require_tool", toolName: "dispatch" }]);
		deepStrictEqual(control.current(), { kind: "required", toolName: "dispatch" });
		control.toolStarted("context");
		deepStrictEqual(control.current(), { kind: "required", toolName: "dispatch" });
		control.toolStarted("dispatch");
		deepStrictEqual(control.current(), { kind: "auto" });
		control.apply([{ kind: "lock_tools" }, { kind: "require_tool", toolName: "read" }]);
		deepStrictEqual(control.current(), { kind: "none" });
		control.reset();
		deepStrictEqual(control.current(), { kind: "auto" });
	});

	it("validates request_continuation effects and rules", () => {
		const effect = validateMiddlewareEffect({ kind: "request_continuation", message: "continue now" });
		strictEqual(effect.valid, true);
		const rule = validateMiddlewareRule({
			id: "nudge.test",
			source: "builtin",
			description: "test continuation request",
			enabled: true,
			hooks: ["turn_end"],
			effectKinds: ["request_continuation"],
		});
		strictEqual(rule.valid, true);
	});

	it("validators reject the removed hook and effect names", () => {
		for (const kind of ["require_validation", "record_memory_candidate"]) {
			const result = validateMiddlewareEffect({ kind, reason: "x", lesson: "x", evidenceRefs: ["x"] });
			strictEqual(result.valid, false, `${kind} must no longer validate`);
		}
		const rule = validateMiddlewareRule({
			id: "stale",
			source: "builtin",
			description: "declares a removed hook",
			enabled: true,
			hooks: ["before_model"],
			effectKinds: ["inject_reminder"],
		});
		strictEqual(rule.valid, false);
	});
});

describe("contracts/middleware-cutover diagnostic sink (Q1)", () => {
	it("the bundle routes hook_failed diagnostics through a sink supplied after construction", () => {
		const bundle = createMiddlewareBundle();
		const diagnostics: MiddlewareDiagnostic[] = [];
		bundle.contract.setDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
		bundle.contract.registerHook({
			id: "test.throws",
			description: "always throws",
			hooks: ["turn_start"],
			evaluate() {
				throw new Error("boom");
			},
		});

		const result = bundle.contract.runHook({ hook: "turn_start" });

		deepStrictEqual(result.effects, []);
		strictEqual(diagnostics.length, 1);
		const diagnostic = diagnostics[0];
		ok(diagnostic?.kind === "hook_failed");
		strictEqual(diagnostic.registrationId, "test.throws");
		strictEqual(diagnostic.hook, "turn_start");
		strictEqual(diagnostic.message, "boom");
	});

	it("the snapshot contract honors setDiagnosticSink the same way", () => {
		const contract = createMiddlewareContractFromSnapshot({ version: 1, rules: [] });
		const diagnostics: MiddlewareDiagnostic[] = [];
		contract.setDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
		contract.registerHook({
			id: "test.throws-in-worker",
			description: "always throws",
			hooks: ["before_tool"],
			evaluate() {
				throw new Error("worker boom");
			},
		});

		contract.runHook({ hook: "before_tool", toolName: "read" });

		strictEqual(diagnostics.length, 1);
		strictEqual(diagnostics[0]?.kind, "hook_failed");
	});
});

describe("contracts/middleware-cutover hookFailed notice formatting", () => {
	it("formats hook_failed and budget_exceeded payloads as warn notices", () => {
		const failed = middlewareHookFailedNotice({
			kind: "hook_failed",
			registrationId: "guard.loop",
			hook: "before_tool",
			at: Date.now(),
			message: "boom",
		});
		strictEqual(failed?.level, "warn");
		ok(failed.text.includes("guard.loop") && failed.text.includes("boom"));

		const budget = middlewareHookFailedNotice({
			kind: "budget_exceeded",
			registrationId: "assessor.finish-contract",
			hook: "turn_end",
			at: Date.now(),
			elapsedMs: 14.2,
			budgetMs: 10,
		});
		strictEqual(budget?.level, "warn");
		ok(budget.text.includes("14.2ms") && budget.text.includes("10ms"));
	});

	it("suppresses repeated budget warnings per registration and hook", () => {
		const seen = new Set<string>();
		const first = middlewareHookFailedSessionNotice(
			{
				kind: "budget_exceeded",
				registrationId: "observer.file-mutation",
				hook: "after_tool",
				at: Date.now(),
				elapsedMs: 117.7,
				budgetMs: 10,
			},
			seen,
		);
		strictEqual(first?.level, "warn");
		ok(first.text.includes("further budget warnings for this hook suppressed"));

		const repeated = middlewareHookFailedSessionNotice(
			{
				kind: "budget_exceeded",
				registrationId: "observer.file-mutation",
				hook: "after_tool",
				at: Date.now(),
				elapsedMs: 118.1,
				budgetMs: 10,
			},
			seen,
		);
		strictEqual(repeated, null);

		const otherHook = middlewareHookFailedSessionNotice(
			{
				kind: "budget_exceeded",
				registrationId: "observer.file-mutation",
				hook: "turn_end",
				at: Date.now(),
				elapsedMs: 13,
				budgetMs: 10,
			},
			seen,
		);
		strictEqual(otherHook?.level, "warn");
	});

	it("surfaces steady-state budget warnings but suppresses lone post-warmup spikes", () => {
		const seen = new Set<string>();
		// A single post-warmup spike rides the bus for telemetry (steadyStateWarn
		// false) but must never become an operator notice.
		const spike = middlewareHookFailedSessionNotice(
			{
				kind: "budget_exceeded",
				registrationId: "assessor.finish-contract",
				hook: "turn_end",
				at: Date.now(),
				elapsedMs: 90,
				budgetMs: 75,
				steadyStateWarn: false,
			},
			seen,
		);
		strictEqual(spike, null);

		// Consistent slowness (steadyStateWarn true) surfaces once, with the trend.
		const steady = middlewareHookFailedSessionNotice(
			{
				kind: "budget_exceeded",
				registrationId: "assessor.finish-contract",
				hook: "turn_end",
				at: Date.now(),
				elapsedMs: 90,
				budgetMs: 75,
				steadyStateWarn: true,
				overCount: 3,
				windowSamples: 5,
				p95Ms: 95,
			},
			seen,
		);
		strictEqual(steady?.level, "warn");
		ok(steady.text.includes("3 of the last 5 turn_end calls"));
		ok(steady.text.includes("further budget warnings for this hook suppressed"));

		// The once-per-(registration, hook) floor still holds after it surfaced.
		const repeat = middlewareHookFailedSessionNotice(
			{
				kind: "budget_exceeded",
				registrationId: "assessor.finish-contract",
				hook: "turn_end",
				at: Date.now(),
				elapsedMs: 91,
				budgetMs: 75,
				steadyStateWarn: true,
			},
			seen,
		);
		strictEqual(repeat, null);
	});

	it("keys budget-warning dedupe only for valid budget payloads", () => {
		strictEqual(
			middlewareBudgetWarningKey({
				kind: "budget_exceeded",
				registrationId: "observer.file-mutation",
				hook: "after_tool",
				at: Date.now(),
				elapsedMs: 117.7,
				budgetMs: 10,
			}),
			"observer.file-mutation\u0000after_tool",
		);
		strictEqual(
			middlewareBudgetWarningKey({
				kind: "hook_failed",
				registrationId: "observer.file-mutation",
				hook: "after_tool",
				at: Date.now(),
				message: "boom",
			}),
			null,
		);
		strictEqual(middlewareBudgetWarningKey({ kind: "budget_exceeded", registrationId: "", hook: "after_tool" }), null);
	});

	it("drops malformed payloads", () => {
		strictEqual(middlewareHookFailedNotice(null), null);
		strictEqual(middlewareHookFailedNotice({ kind: "other" }), null);
		strictEqual(middlewareHookFailedNotice({ kind: "hook_failed", registrationId: "", hook: "turn_end" }), null);
	});
});
