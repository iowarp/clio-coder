import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import type { SkillActivation } from "../../src/core/skill-activation.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import {
	createFileMutationObserver,
	createSkillActivationObserver,
	type FileMutationEvent,
} from "../../src/tools/observers.js";
import { createRegistry, type ToolResult, type ToolSpec } from "../../src/tools/registry.js";

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

function mockSpec(name: ToolName, result: ToolResult): ToolSpec {
	return {
		name,
		description: "test tool",
		parameters: Type.Object({}),
		baseActionClass: "read",
		run: async () => result,
	};
}

describe("after_tool observer registrations", () => {
	it("reports successful read_skill activations with turn metadata", async () => {
		const activations: SkillActivation[] = [];
		const bundle = createMiddlewareBundle({
			registrations: [createSkillActivationObserver((activation) => activations.push(activation))],
		});
		const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
		registry.register(
			mockSpec(ToolNames.ReadSkill, {
				kind: "ok",
				output: "skill body",
				details: { name: "readable", filePath: "/skills/readable/SKILL.md", hash: "a".repeat(64), source: "project" },
			}),
		);
		const verdict = await registry.invoke({ tool: ToolNames.ReadSkill, args: { name: "readable" } }, { turnId: "t1" });
		strictEqual(verdict.kind, "ok");
		strictEqual(activations.length, 1);
		strictEqual(activations[0]?.name, "readable");
		strictEqual(activations[0]?.turnId, "t1");
	});

	it("stays silent for failed read_skill results and for other tools", async () => {
		const activations: SkillActivation[] = [];
		const bundle = createMiddlewareBundle({
			registrations: [createSkillActivationObserver((activation) => activations.push(activation))],
		});
		const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
		registry.register(mockSpec(ToolNames.ReadSkill, { kind: "error", message: "skill not found" }));
		registry.register(mockSpec(ToolNames.Read, { kind: "ok", output: "file contents" }));
		await registry.invoke({ tool: ToolNames.ReadSkill, args: { name: "missing" } }, { turnId: "t1" });
		await registry.invoke({ tool: ToolNames.Read, args: { path: "a.md" } }, { turnId: "t1" });
		strictEqual(activations.length, 0);
	});

	it("reports successful file mutations and skips failed or non-mutating calls", async () => {
		const events: FileMutationEvent[] = [];
		const bundle = createMiddlewareBundle({
			registrations: [createFileMutationObserver((event) => events.push(event))],
		});
		const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
		registry.register(mockSpec(ToolNames.Write, { kind: "ok", output: "wrote" }));
		registry.register(mockSpec(ToolNames.Edit, { kind: "error", message: "no match" }));
		registry.register(mockSpec(ToolNames.Read, { kind: "ok", output: "contents" }));
		await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/a.md" } });
		await registry.invoke({ tool: ToolNames.Edit, args: { path: "/repo/b.md" } });
		await registry.invoke({ tool: ToolNames.Read, args: { path: "/repo/c.md" } });
		deepStrictEqual(events, [{ paths: ["/repo/a.md"], toolName: ToolNames.Write }]);
	});

	it("never lets a throwing sink affect the tool result", async () => {
		const bundle = createMiddlewareBundle({
			registrations: [
				createFileMutationObserver(() => {
					throw new Error("sink exploded");
				}),
			],
		});
		const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
		registry.register(mockSpec(ToolNames.Write, { kind: "ok", output: "wrote" }));
		const verdict = await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/a.md" } });
		strictEqual(verdict.kind, "ok");
		if (verdict.kind === "ok" && verdict.result.kind === "ok") strictEqual(verdict.result.output, "wrote");
	});
});
