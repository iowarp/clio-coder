import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import type { MiddlewareRuleDefinition } from "../../src/domains/middleware/runtime.js";
import type { ProtectedArtifactState } from "../../src/domains/safety/protected-artifacts.js";
import {
	createProtectedArtifactsRegistration,
	type ProtectedArtifactProtectEvent,
} from "../../src/domains/safety/protected-artifacts-registration.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";

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

function mockSpec(name: ToolName, output = "tool output"): ToolSpec {
	return {
		name,
		description: "test tool",
		parameters: Type.Object({}),
		baseActionClass: "read",
		run: async () => ({ kind: "ok", output }),
	};
}

function protectedState(...paths: string[]): ProtectedArtifactState {
	return {
		artifacts: paths.map((path) => ({
			path,
			protectedAt: "2026-06-12T00:00:00.000Z",
			reason: "test protection",
			source: "user" as const,
		})),
	};
}

/** Declarative after_tool rule protecting a fixed path, for absorption tests. */
function protectRule(
	id: string,
	path: string,
	hooks: MiddlewareRuleDefinition["rule"]["hooks"],
): MiddlewareRuleDefinition {
	return {
		rule: {
			id,
			source: "builtin",
			description: `protects ${path}`,
			enabled: true,
			hooks,
			effectKinds: ["protect_path"],
		},
		toolNames: [ToolNames.Write],
		effects: [{ kind: "protect_path", path, reason: `protected by ${id}` }],
	};
}

describe("protected-artifacts registration", () => {
	it("blocks a write to an already-protected path through the registry", async () => {
		const guard = createProtectedArtifactsRegistration({ initialState: protectedState("/repo/PLAN.md") });
		const bundle = createMiddlewareBundle({ registrations: [guard] });
		const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
		registry.register(mockSpec(ToolNames.Write));
		const blocked = await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/PLAN.md" } });
		strictEqual(blocked.kind, "blocked");
		ok(
			blocked.kind === "blocked" &&
				blocked.reason === "protected artifact blocked: write would modify protected path /repo/PLAN.md",
		);
		const allowed = await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/other.md" } });
		strictEqual(allowed.kind, "ok");
	});

	it("blocks a destructive bash command against a protected path", async () => {
		const guard = createProtectedArtifactsRegistration({ initialState: protectedState("/repo/PLAN.md") });
		const bundle = createMiddlewareBundle({ registrations: [guard] });
		const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
		registry.register(mockSpec(ToolNames.Bash));
		const blocked = await registry.invoke({ tool: ToolNames.Bash, args: { command: "rm /repo/PLAN.md" } });
		strictEqual(blocked.kind, "blocked");
		ok(
			blocked.kind === "blocked" && blocked.reason.includes("protected artifact blocked: rm would affect /repo/PLAN.md"),
		);
		const benign = await registry.invoke({ tool: ToolNames.Bash, args: { command: "cat /repo/PLAN.md" } });
		strictEqual(benign.kind, "ok");
	});

	it("absorbs protect_path from an after_tool rule and notifies the persistence sink", async () => {
		const events: ProtectedArtifactProtectEvent[] = [];
		const guard = createProtectedArtifactsRegistration({ onProtect: (event) => events.push(event) });
		const bundle = createMiddlewareBundle({
			ruleDefinitions: [protectRule("policy.protect-plan", "/repo/PLAN.md", ["after_tool"])],
			registrations: [guard],
		});
		const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
		registry.register(mockSpec(ToolNames.Write, "wrote"));
		const first = await registry.invoke(
			{ tool: ToolNames.Write, args: { path: "/repo/PLAN.md" } },
			{ turnId: "t1", sessionId: "s1", toolCallId: "c1" },
		);
		strictEqual(first.kind, "ok", "the protecting write itself executes");
		strictEqual(events.length, 1);
		strictEqual(events[0]?.artifact.path, "/repo/PLAN.md");
		strictEqual(events[0]?.artifact.source, "middleware");
		strictEqual(events[0]?.toolName, ToolNames.Write);
		strictEqual(events[0]?.turnId, "t1");
		strictEqual(events[0]?.sessionId, "s1");
		strictEqual(events[0]?.toolCallId, "c1");
		const second = await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/PLAN.md" } }, { turnId: "t1" });
		strictEqual(second.kind, "blocked", "the absorbed protection blocks the next mutation");
	});

	it("blocks the protecting call itself when a before_tool rule protects the very path it writes", async () => {
		const guard = createProtectedArtifactsRegistration();
		const bundle = createMiddlewareBundle({
			ruleDefinitions: [protectRule("policy.protect-plan", "/repo/PLAN.md", ["before_tool"])],
			registrations: [guard],
		});
		const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
		registry.register(mockSpec(ToolNames.Write));
		const blocked = await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/PLAN.md" } });
		strictEqual(blocked.kind, "blocked", "post-hooks recheck semantics preserved: protect-then-block in one pass");
	});

	it("replaceState swaps protections wholesale, matching session switches", async () => {
		const guard = createProtectedArtifactsRegistration({ initialState: protectedState("/repo/a.md") });
		const bundle = createMiddlewareBundle({ registrations: [guard] });
		const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
		registry.register(mockSpec(ToolNames.Write));
		strictEqual((await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/a.md" } })).kind, "blocked");
		guard.replaceState(protectedState("/repo/b.md"));
		strictEqual((await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/a.md" } })).kind, "ok");
		strictEqual((await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/b.md" } })).kind, "blocked");
		deepStrictEqual(
			guard.state().artifacts.map((artifact) => artifact.path),
			["/repo/b.md"],
		);
	});

	it("records validation metadata when absorbing during a validated run", () => {
		const events: ProtectedArtifactProtectEvent[] = [];
		const guard = createProtectedArtifactsRegistration({ onProtect: (event) => events.push(event) });
		guard.evaluate(
			{
				hook: "after_tool",
				toolName: ToolNames.Bash,
				metadata: { validationCommand: "npm test", validationExitCode: 0, resultKind: "ok" },
			},
			{ priorEffects: [{ kind: "protect_path", path: "/repo/src/fix.ts", reason: "validated edit" }] },
		);
		strictEqual(events.length, 1);
		strictEqual(events[0]?.artifact.validationCommand, "npm test");
		strictEqual(events[0]?.artifact.validationExitCode, 0);
	});

	it("survives a throwing persistence sink", async () => {
		const guard = createProtectedArtifactsRegistration({
			onProtect: () => {
				throw new Error("sink exploded");
			},
		});
		const bundle = createMiddlewareBundle({
			ruleDefinitions: [protectRule("policy.protect-plan", "/repo/PLAN.md", ["after_tool"])],
			registrations: [guard],
		});
		const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
		registry.register(mockSpec(ToolNames.Write));
		const verdict = await registry.invoke({ tool: ToolNames.Write, args: { path: "/repo/PLAN.md" } });
		strictEqual(verdict.kind, "ok", "tool execution is unaffected by sink failures");
		strictEqual(guard.state().artifacts.length, 1, "protection state still grew");
	});
});
