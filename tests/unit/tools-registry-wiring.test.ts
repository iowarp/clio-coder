import { ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import type { ToolName } from "../../src/core/tool-names.js";
import type { ModesContract } from "../../src/domains/modes/contract.js";
import type { ModeName } from "../../src/domains/modes/matrix.js";
import type { Classification, ClassifierCall } from "../../src/domains/safety/action-classifier.js";
import type { SafetyContract, SafetyDecision } from "../../src/domains/safety/contract.js";
import { DEFAULT_SCOPE, READONLY_SCOPE, SUPER_SCOPE } from "../../src/domains/safety/scope.js";
import { createWorkerToolRegistry, resolveAgentTools } from "../../src/engine/worker-tools.js";
import { createRegistry, type ToolRegistry, type ToolSpec } from "../../src/tools/registry.js";

function makeModes(
	initial: ModeName,
	allowAction: (action: Classification["actionClass"]) => boolean,
	visibleTools: ReadonlyArray<ToolName>,
): ModesContract {
	return {
		current: () => initial,
		setMode: () => initial,
		cycleNormal: () => initial,
		visibleTools: () => new Set(visibleTools),
		isToolVisible: (tool) => visibleTools.includes(tool),
		isActionAllowed: (action) => allowAction(action),
		requestSuper: () => {},
		confirmSuper: () => initial,
	};
}

function makeSafety(classification: Classification, decisions: ClassifierCall[]): SafetyContract {
	const decision: SafetyDecision = { kind: "allow", classification };
	return {
		classify: () => classification,
		evaluate(call) {
			decisions.push(call);
			return decision;
		},
		observeLoop: (key) => ({ looping: false, key, count: 1 }),
		scopes: { default: DEFAULT_SCOPE, readonly: READONLY_SCOPE, super: SUPER_SCOPE },
		isSubset: () => true,
		audit: { recordCount: () => 0 },
	};
}

function registerWriteTool(registry: ToolRegistry, run: ToolSpec["run"]): void {
	registry.register({
		name: "write",
		description: "test write",
		parameters: Type.Object({
			path: Type.String(),
			content: Type.String(),
		}),
		baseActionClass: "write",
		allowedModes: ["default"],
		run,
	});
}

describe("engine/worker-tools registry wiring", () => {
	it("blocks execution before spec.run when the registry denies the action", async () => {
		let allowWrite = false;
		let runCalls = 0;
		const decisions: ClassifierCall[] = [];
		const registry = createRegistry({
			safety: makeSafety({ actionClass: "write", reasons: ["test"] }, decisions),
			modes: makeModes("default", (action) => allowWrite && action === "write", ["write"]),
		});
		registerWriteTool(registry, async () => {
			runCalls += 1;
			return { kind: "ok", output: "wrote file" };
		});

		const [tool] = resolveAgentTools({
			registry,
			allowedTools: ["write"],
			mode: "default",
		});
		ok(tool);
		strictEqual(typeof tool.execute, "function");

		await rejects(tool.execute("tool-call-1", { path: "notes.txt", content: "draft" }), /action write not allowed/);
		strictEqual(runCalls, 0);
		strictEqual(decisions.length, 1);
		strictEqual(decisions[0]?.tool, "write");

		allowWrite = true;
		const result = await tool.execute("tool-call-2", { path: "notes.txt", content: "draft" });
		strictEqual(runCalls, 1);
		strictEqual(result.content[0]?.type, "text");
		if (result.content[0]?.type === "text") {
			strictEqual(result.content[0].text, "wrote file");
		}
	});

	it("worker registry rejects write-like system modifications before spec.run", async () => {
		const registry = createWorkerToolRegistry("default");
		const [tool] = resolveAgentTools({
			registry,
			allowedTools: ["write"],
			mode: "default",
		});
		ok(tool);
		strictEqual(typeof tool.execute, "function");

		await rejects(
			tool.execute("tool-call-3", { path: "/etc/clio-denied.txt", content: "forbidden" }),
			/system_modify|blocked/,
		);
	});
});
