import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { ToolNames } from "../../src/core/tool-names.js";
import { createDispatchDedupRegistration } from "../../src/domains/dispatch/dedup.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { createRegistry, type ToolRegistry, type ToolSpec } from "../../src/tools/registry.js";

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

function dispatchSpec(exitCode: number): ToolSpec {
	return {
		name: ToolNames.Dispatch,
		description: "mock dispatch",
		parameters: Type.Object({}),
		baseActionClass: "dispatch",
		run: async () => ({ kind: "ok", output: "dispatched", details: { exitCode } }),
	};
}

function dedupRegistry(exitCode = 0): ToolRegistry {
	const bundle = createMiddlewareBundle({ registrations: [createDispatchDedupRegistration()] });
	const registry = createRegistry({ safety: allowAllSafety(), middleware: bundle.contract });
	registry.register(dispatchSpec(exitCode));
	return registry;
}

const CALL = { tool: ToolNames.Dispatch, args: { agent_id: "coder", task: "run the tests" } };

describe("dispatch dedup registration", () => {
	it("blocks an identical dispatch after a successful one in the same turn", async () => {
		const registry = dedupRegistry();
		strictEqual((await registry.invoke(CALL, { turnId: "t1" })).kind, "ok");
		const blocked = await registry.invoke(CALL, { turnId: "t1" });
		strictEqual(blocked.kind, "blocked");
		ok(blocked.kind === "blocked" && blocked.reason.includes("dispatch duplicate blocked"));
		ok(blocked.kind === "blocked" && blocked.reason.includes('agent=coder task="run the tests"'));
	});

	it("normalizes agent id aliases into one fingerprint", async () => {
		const registry = dedupRegistry();
		strictEqual(
			(
				await registry.invoke(
					{ tool: ToolNames.Dispatch, args: { agent: "coder", task: "run the tests" } },
					{ turnId: "t1" },
				)
			).kind,
			"ok",
		);
		const blocked = await registry.invoke(
			{ tool: ToolNames.Dispatch, args: { agent_id: "coder", task: "run the tests" } },
			{ turnId: "t1" },
		);
		strictEqual(blocked.kind, "blocked", "alias spellings share the normalized fingerprint");
	});

	it("allows the same dispatch in a different turn and different tasks in the same turn", async () => {
		const registry = dedupRegistry();
		strictEqual((await registry.invoke(CALL, { turnId: "t1" })).kind, "ok");
		strictEqual((await registry.invoke(CALL, { turnId: "t2" })).kind, "ok");
		strictEqual(
			(await registry.invoke({ tool: ToolNames.Dispatch, args: { agent_id: "coder", task: "lint" } }, { turnId: "t1" }))
				.kind,
			"ok",
		);
	});

	it("does not remember failed dispatches", async () => {
		const registry = dedupRegistry(1);
		strictEqual((await registry.invoke(CALL, { turnId: "t1" })).kind, "ok");
		strictEqual((await registry.invoke(CALL, { turnId: "t1" })).kind, "ok", "exit 1 runs are retryable");
	});

	it("never blocks without a turn id", async () => {
		const registry = dedupRegistry();
		strictEqual((await registry.invoke(CALL)).kind, "ok");
		strictEqual((await registry.invoke(CALL)).kind, "ok");
	});
});
