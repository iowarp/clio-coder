import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type MiddlewareDiagnostic,
	type MiddlewareHookRegistration,
	runMiddlewareAsyncRegistrations,
	runMiddlewareRegistrations,
} from "../../src/domains/middleware/runtime.js";

function registration(
	id: string,
	evaluate: MiddlewareHookRegistration["evaluate"],
	overrides: Partial<MiddlewareHookRegistration> = {},
): MiddlewareHookRegistration {
	return { id, description: id, hooks: ["before_tool"], evaluate, ...overrides };
}

describe("middleware hook boundary", () => {
	it("evaluates matching registrations in order and exposes prior effects", () => {
		const seen: string[][] = [];
		const first = registration("first", () => [{ kind: "inject_reminder", message: "prepare" }]);
		const second = registration("second", (_input, context) => {
			seen.push((context?.priorEffects ?? []).map(({ kind }) => kind));
			return [{ kind: "block_tool", reason: "protected", severity: "hard-block" }];
		});
		const result = runMiddlewareRegistrations({ hook: "before_tool", toolName: "write", toolArgs: { path: "PLAN.md" } }, [
			first,
			second,
		]);
		deepStrictEqual(result.ruleIds, ["first", "second"]);
		deepStrictEqual(result.effects, [
			{ kind: "inject_reminder", message: "prepare" },
			{ kind: "block_tool", reason: "protected", severity: "hard-block" },
		]);
		deepStrictEqual(seen, [["inject_reminder"]]);
	});

	it("isolates a failed registration and continues later effects", () => {
		const diagnostics: MiddlewareDiagnostic[] = [];
		const failed = registration("failed", () => {
			throw new Error("hook exploded");
		});
		const survivor = registration("survivor", () => [
			{ kind: "annotate_tool_result", message: "checked", severity: "info" },
		]);
		const result = runMiddlewareRegistrations({ hook: "before_tool", toolName: "read" }, [failed, survivor], {
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		});
		deepStrictEqual(result.ruleIds, ["survivor"]);
		deepStrictEqual(result.effects, [{ kind: "annotate_tool_result", message: "checked", severity: "info" }]);
		deepStrictEqual(diagnostics, [
			{ kind: "hook_failed", registrationId: "failed", hook: "before_tool", message: "hook exploded" },
		]);
	});

	it("matches exact hook and tool scopes", () => {
		const scoped = registration("write-only", () => [{ kind: "lock_tools" }], { toolNames: ["write"] });
		strictEqual(runMiddlewareRegistrations({ hook: "before_tool", toolName: "write" }, [scoped]).effects.length, 1);
		strictEqual(runMiddlewareRegistrations({ hook: "before_tool", toolName: "read" }, [scoped]).effects.length, 0);
		strictEqual(runMiddlewareRegistrations({ hook: "before_tool" }, [scoped]).effects.length, 0);
		strictEqual(runMiddlewareRegistrations({ hook: "after_tool", toolName: "write" }, [scoped]).effects.length, 0);
	});

	it("serializes async phases in registration order and isolates rejection", async () => {
		const calls: string[] = [];
		const diagnostics: MiddlewareDiagnostic[] = [];
		const regs: MiddlewareHookRegistration[] = [
			registration("one", () => [], {
				evaluateAsync: async () => {
					calls.push("one");
					return [{ kind: "inject_reminder", message: "first" }];
				},
			}),
			registration("broken", () => [], {
				evaluateAsync: async () => {
					calls.push("broken");
					throw new Error("async failure");
				},
			}),
			registration("three", () => [], {
				evaluateAsync: async (_input, context) => {
					calls.push(`three:${context?.priorEffects.length ?? 0}`);
					return [{ kind: "request_continuation", message: "continue" }];
				},
			}),
		];
		const result = await runMiddlewareAsyncRegistrations({ hook: "before_tool", toolName: "write" }, regs, [], {
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		});
		deepStrictEqual(calls, ["one", "broken", "three:1"]);
		deepStrictEqual(result.effects, [
			{ kind: "inject_reminder", message: "first" },
			{ kind: "request_continuation", message: "continue" },
		]);
		strictEqual(diagnostics[0]?.kind, "hook_failed");
	});
});
