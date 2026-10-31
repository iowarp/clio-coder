import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Type } from "typebox";
import { mcpToolName, ToolNames } from "../../src/core/tool-names.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { invokeRegisteredTool, type ToolFinishEvent } from "../../src/tools/agent-tools.js";
import { createDataTool } from "../../src/tools/gateway/data-tool.js";
import { createGatewayTool } from "../../src/tools/gateway/index.js";
import { createRegistry } from "../../src/tools/registry.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

describe("gateway correction contracts", () => {
	let env: Awaited<ReturnType<typeof isolateClioEnv>>;
	beforeEach(async () => {
		env = await isolateClioEnv("gateway-corrections-");
	});
	afterEach(() => env.restore());

	it("reads a request carrying args as a call, never as a discovery listing", async () => {
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: clioStateDir() }), autonomy: () => "yolo" });
		const capability = mcpToolName("lab", "stage");
		ok(capability);
		let calls = 0;
		registry.register({
			name: capability,
			placement: "gateway",
			description: "Stage a fixture",
			parameters: Type.Object({ op: Type.String(), id: Type.String() }),
			baseActionClass: "execute",
			run: async () => {
				calls++;
				return { kind: "ok", output: "staged" };
			},
		});
		registry.register(createGatewayTool({ registry }));
		const nested = { capability, op: "call", id: "r7" };
		for (const args of [
			{ args: nested },
			{ args: JSON.stringify(nested) },
			{ args: { id: "r7" } },
			{ op: "call", args: nested },
			{ op: "find", args: nested },
			{ op: "find", query: "stage", args: {} },
		]) {
			const verdict = await registry.invoke({ tool: ToolNames.Gateway, args });
			ok(verdict.kind === "ok", JSON.stringify(verdict));
			ok(verdict.result.kind === "error", JSON.stringify(verdict));
			match(verdict.result.message, /op and capability belong at the top level/);
			match(verdict.result.message, /No capability was invoked/);
		}
		const named = await registry.invoke({ tool: ToolNames.Gateway, args: { args: nested } });
		ok(named.kind === "ok" && named.result.kind === "error");
		match(named.result.message, new RegExp(`"capability":"${capability}"`));
		strictEqual(calls, 0);
		for (const args of [{}, { query: "stage" }]) {
			const verdict = await registry.invoke({ tool: ToolNames.Gateway, args });
			ok(verdict.kind === "ok" && verdict.result.kind === "ok", JSON.stringify(verdict));
			match(verdict.result.output, /mcp_lab__stage/);
		}
		// A capability's own op argument is valid once the capability is top-level.
		const valid = await registry.invoke({
			tool: ToolNames.Gateway,
			args: { capability, args: { op: "stage", id: "r7" } },
		});
		ok(valid.kind === "ok" && valid.result.kind === "ok", JSON.stringify(valid));
		strictEqual(calls, 1);
	});

	it("refuses normalized protected data paths before the reader runs", async () => {
		const cwd = clioStateDir();
		const registry = createRegistry({ safety: createWorkerSafety({ cwd }), autonomy: () => "default", readOnly: true });
		let reads = 0;
		const data = createDataTool({ getCwd: () => cwd });
		registry.register({
			...data,
			placement: "gateway",
			run: async () => {
				reads++;
				return { kind: "ok", output: "unexpected read" };
			},
		});
		registry.register(createGatewayTool({ registry }));
		for (const path of [".env", " .env ", "\t./.env\n", join(cwd, ".env")]) {
			for (const tool of ["data", "gateway"]) {
				const args = { op: "inspect", path };
				const result = await registry.invoke({
					tool,
					args: tool === "data" ? args : { op: "call", capability: "data", args },
				});
				strictEqual(result.kind, "blocked", path);
			}
		}
		strictEqual(reads, 0);
	});

	it("preserves execute and write decisions and finish telemetry at every approval level, including executed errors", async () => {
		for (const actionClass of ["write", "execute"] as const) {
			for (const { level, readOnly } of [
				{ level: "default", readOnly: true },
				{ level: "default", readOnly: false },
				{ level: "yolo", readOnly: false },
			] as const) {
				for (const fails of [false, true]) {
					const records = [];
					for (const placement of ["direct", "gateway"] as const) {
						const registry = createRegistry({
							safety: createWorkerSafety({ cwd: clioStateDir() }),
							autonomy: () => level,
							readOnly,
						});
						const name = ToolNames.Artifact;
						let runs = 0;
						registry.register({
							name,
							placement,
							description: "Authority fixture",
							parameters: Type.Object({}),
							baseActionClass: actionClass,
							safetyCall: () => ({
								tool: actionClass === "execute" ? "bash" : "write",
								args: actionClass === "execute" ? { command: "custom-science-executable" } : { path: "report.txt" },
							}),
							run: async () => {
								runs++;
								return fails ? { kind: "error", message: "executed failure" } : { kind: "ok", output: "done" };
							},
						});
						registry.register(createGatewayTool({ registry }));
						const parks: string[] = [];
						registry.onPermissionRequired((_call, decision, meta) => {
							parks.push(decision.classification.actionClass);
							void registry.resumeParkedCalls({
								actionClass: decision.classification.actionClass,
								requestId: meta.requestId,
								requestedBy: "test",
							});
						});
						const tool = placement === "direct" ? name : ToolNames.Gateway;
						const args = placement === "direct" ? {} : { op: "call", capability: name, args: {} };
						const verdict = await registry.invoke({ tool, args });
						ok(verdict.kind !== "not_visible");
						strictEqual(verdict.decision.classification.actionClass, actionClass);
						const events: ToolFinishEvent[] = [];
						await invokeRegisteredTool(registry, tool, args, {
							telemetry: { onFinish: (event) => events.push(event) },
						}).catch(() => {});
						strictEqual(events.length, 1);
						strictEqual(events[0]?.tool, tool);
						strictEqual(events[0]?.actionClass, actionClass);
						strictEqual(runs, readOnly ? 0 : 2);
						strictEqual(parks.length, !readOnly && actionClass === "execute" && level === "default" ? 2 : 0);
						const event = events[0];
						ok(event);
						const { tool: _tool, durationMs: _duration, ...finish } = event;
						records.push({ decision: verdict.decision, kind: verdict.kind, finish, parks });
					}
					deepStrictEqual(records[1], records[0]);
				}
			}
		}
	});
});
