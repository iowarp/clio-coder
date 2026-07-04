import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import type { ActionClass, ClassifierCall } from "../../src/domains/safety/action-classifier.js";
import { AUTONOMY_LEVELS, type AutonomyLevel } from "../../src/domains/safety/autonomy.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createRegistry, type ToolRegistry, type ToolSpec } from "../../src/tools/registry.js";

type MatrixOutcome = "executed" | "parked" | "denied" | "blocked";

interface MatrixCase {
	name: string;
	call: ClassifierCall;
	expected: Record<AutonomyLevel, MatrixOutcome>;
}

function mockSpec(name: string, baseActionClass: ActionClass): ToolSpec {
	return {
		name: name as ToolName,
		description: "autonomy matrix test tool",
		parameters: Type.Object({}),
		baseActionClass,
		run: async () => ({ kind: "ok", output: `${name} ran` }),
	};
}

function registryAt(level: AutonomyLevel): ToolRegistry {
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd: process.cwd() }),
		autonomy: () => level,
	});
	registry.register(mockSpec(ToolNames.Read, "read"));
	registry.register(mockSpec(ToolNames.Write, "write"));
	registry.register(mockSpec(ToolNames.Bash, "execute"));
	registry.register(mockSpec(ToolNames.Dispatch, "dispatch"));
	return registry;
}

async function settle(): Promise<void> {
	await Promise.resolve();
}

async function outcomeFor(level: AutonomyLevel, call: ClassifierCall): Promise<MatrixOutcome> {
	const registry = registryAt(level);
	let permissionRequests = 0;
	let autonomyDenials = 0;
	registry.onPermissionRequired(() => {
		permissionRequests += 1;
	});
	registry.onAutonomyDenied(() => {
		autonomyDenials += 1;
	});

	const pending = registry.invoke(call);
	await settle();

	if (registry.hasParkedCalls()) {
		strictEqual(permissionRequests, 1, `${call.tool} at ${level} parked without notifying permission listeners`);
		registry.cancelParkedCalls("matrix test cancelled parked call");
		const verdict = await pending;
		strictEqual(verdict.kind, "blocked", `${call.tool} at ${level} did not resolve blocked after cancellation`);
		return "parked";
	}

	const verdict = await pending;
	strictEqual(permissionRequests, 0, `${call.tool} at ${level} notified permission listeners without parking`);
	if (verdict.kind === "ok") return "executed";
	if (verdict.kind === "not_visible") return "denied";
	ok(verdict.kind === "blocked");
	return autonomyDenials > 0 ? "denied" : "blocked";
}

const expectedCases: ReadonlyArray<MatrixCase> = [
	{
		name: "read tool",
		call: { tool: ToolNames.Read, args: { file_path: "README.md" } },
		expected: { "read-only": "executed", suggest: "executed", "auto-edit": "executed", "full-auto": "executed" },
	},
	{
		name: "workspace write",
		call: { tool: ToolNames.Write, args: { file_path: "notes/autonomy-matrix.txt", content: "x" } },
		expected: { "read-only": "denied", suggest: "parked", "auto-edit": "executed", "full-auto": "executed" },
	},
	{
		name: "recognized command",
		call: { tool: ToolNames.Bash, args: { command: "npm test" } },
		expected: { "read-only": "denied", suggest: "parked", "auto-edit": "executed", "full-auto": "executed" },
	},
	{
		name: "unrecognized command",
		call: { tool: ToolNames.Bash, args: { command: "ls -la | wc -l" } },
		expected: { "read-only": "denied", suggest: "parked", "auto-edit": "parked", "full-auto": "executed" },
	},
	{
		name: "command substitution command",
		call: { tool: ToolNames.Bash, args: { command: "echo $(date +%s)" } },
		expected: { "read-only": "denied", suggest: "parked", "auto-edit": "parked", "full-auto": "parked" },
	},
	{
		name: "system_modify bash",
		call: { tool: ToolNames.Bash, args: { command: "sudo whoami" } },
		expected: { "read-only": "denied", suggest: "parked", "auto-edit": "parked", "full-auto": "parked" },
	},
	{
		name: "system_modify write",
		call: { tool: ToolNames.Write, args: { file_path: join(tmpdir(), "clio-autonomy-matrix.txt"), content: "x" } },
		expected: { "read-only": "denied", suggest: "parked", "auto-edit": "parked", "full-auto": "parked" },
	},
	{
		name: "git_destructive command",
		call: { tool: ToolNames.Bash, args: { command: "git push --force origin main" } },
		expected: { "read-only": "blocked", suggest: "blocked", "auto-edit": "blocked", "full-auto": "blocked" },
	},
	{
		name: "dispatch call",
		call: { tool: ToolNames.Dispatch, args: { agent: "test", task: "check status" } },
		expected: { "read-only": "denied", suggest: "parked", "auto-edit": "executed", "full-auto": "executed" },
	},
	{
		name: "unregistered tool name",
		call: { tool: "not_a_registered_tool", args: {} },
		expected: { "read-only": "denied", suggest: "denied", "auto-edit": "denied", "full-auto": "denied" },
	},
];

describe("contracts/autonomy registry outcome matrix", () => {
	it("records the current final outcome for every level and call class", async () => {
		for (const entry of expectedCases) {
			const observed: Record<AutonomyLevel, MatrixOutcome> = {
				"read-only": "blocked",
				suggest: "blocked",
				"auto-edit": "blocked",
				"full-auto": "blocked",
			};
			for (const level of AUTONOMY_LEVELS) {
				observed[level] = await outcomeFor(level, entry.call);
			}
			deepStrictEqual(observed, entry.expected, entry.name);
		}
	});
});
