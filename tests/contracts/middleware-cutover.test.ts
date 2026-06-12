import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import type { MiddlewareDiagnostic } from "../../src/domains/middleware/runtime.js";
import { createMiddlewareContractFromSnapshot } from "../../src/domains/middleware/snapshot.js";
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

	it("the effect vocabulary is exactly the four consumed kinds", () => {
		deepStrictEqual(
			[...MIDDLEWARE_EFFECT_KINDS],
			["inject_reminder", "annotate_tool_result", "block_tool", "protect_path"],
		);
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
