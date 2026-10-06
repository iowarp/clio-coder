import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { ToolNames } from "../../src/core/tool-names.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import type { MiddlewareEffect, MiddlewareHookRegistration } from "../../src/domains/middleware/index.js";
import { createProtectedArtifactsRegistration } from "../../src/domains/safety/protected-artifacts-registration.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createRegistry } from "../../src/tools/registry.js";

// An awaited extension hook may rewrite a call's input, but the guards judged
// the arguments the model sent. The call that would run goes through them again.
function rewriter(target: string): MiddlewareHookRegistration {
	return {
		id: "extension:rewriter:before_tool:0",
		description: "rewrites a write onto another path",
		hooks: ["before_tool"],
		awaited: true,
		evaluate: () => [],
		async evaluateAsync(): Promise<ReadonlyArray<MiddlewareEffect>> {
			return [
				{
					kind: "rewrite_tool_input",
					args: { path: target, content: "x" },
					reason: "normalise the path",
					source: "rewriter",
				},
			];
		},
	};
}

function fixture(target: string) {
	const ran: string[] = [];
	const guard = createProtectedArtifactsRegistration({
		initialState: {
			artifacts: [
				{ path: "sealed.md", protectedAt: "2026-10-06T00:00:00.000Z", reason: "validated output", source: "middleware" },
			],
		},
	});
	const middleware = createMiddlewareBundle({ registrations: [guard, rewriter(target)] }).contract;
	const registry = createRegistry({ safety: createWorkerSafety(), middleware });
	registry.register({
		name: ToolNames.Write,
		description: "Write fixture",
		parameters: Type.Object({ path: Type.String(), content: Type.String() }),
		baseActionClass: "write",
		run: async (args) => {
			ran.push(String((args as { path: string }).path));
			return { kind: "ok", output: "written" };
		},
	});
	return { registry, ran };
}

describe("extension rewrite_tool_input and the guard chain", () => {
	it("refuses a rewrite onto a protected path and never runs the body", async () => {
		const { registry, ran } = fixture("sealed.md");
		const verdict = await registry.invoke({ tool: ToolNames.Write, args: { path: "a.md", content: "x" } });
		strictEqual(verdict.kind, "blocked");
		ok(verdict.kind === "blocked" && /rewrote write input into a call that is blocked/.test(verdict.reason));
		deepStrictEqual(ran, []);
	});

	it("runs a rewrite onto a path the guards admit", async () => {
		const { registry, ran } = fixture("b.md");
		const verdict = await registry.invoke({ tool: ToolNames.Write, args: { path: "a.md", content: "x" } });
		strictEqual(verdict.kind, "ok");
		deepStrictEqual(ran, ["b.md"]);
	});
});
