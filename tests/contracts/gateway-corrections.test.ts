import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Type } from "typebox";
import { mcpToolName, ToolNames } from "../../src/core/tool-names.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { invokeRegisteredTool, type ToolFinishEvent } from "../../src/tools/agent-tools.js";
import { runGatewayChain } from "../../src/tools/gateway/chain.js";
import { createDataTool } from "../../src/tools/gateway/data-tool.js";
import { createGatewayTool } from "../../src/tools/gateway/index.js";
import { limitationTool } from "../../src/tools/limitation.js";
import { createRegistry } from "../../src/tools/registry.js";
import { RUN_SCRIPT_TOOL_NAME, runScriptToolSurface } from "../../src/tools/run-script.js";
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
			// A parameters envelope is refused on every op, never read as an empty find (bt-23).
			{ op: "find", parameters: { pattern: "**/*" } },
			{ op: "describe", parameters: { capability } },
			{ parameters: nested },
		]) {
			const verdict = await registry.invoke({ tool: ToolNames.Gateway, args });
			ok(verdict.kind === "ok", JSON.stringify(verdict));
			ok(verdict.result.kind === "error", JSON.stringify(verdict));
			match(verdict.result.message, /op and capability belong at the top level/);
			match(verdict.result.message, /No capability was invoked/);
		}
		// A misplaced envelope or steps key is refused with the exact shape it meant (bt-23 N3, N4).
		for (const [args, hint] of [
			[
				{ op: "call", capability, parameters: { id: "r7" } },
				`{"op":"call","capability":"${capability}","args":{"id":"r7"}}`,
			],
			[{ op: "chain", parameters: { steps: [] } }, 'steps belongs at the top level beside op: {"op":"chain"'],
		] as const) {
			const verdict = await registry.invoke({ tool: ToolNames.Gateway, args });
			ok(verdict.kind === "ok" && verdict.result.kind === "error", JSON.stringify(verdict));
			ok(verdict.result.message.includes(hint), verdict.result.message);
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
		// A capability's own op argument is valid once the capability is top-level, and an empty
		// parameters object beside a top-level call carries nothing to refuse (bt-23 N3).
		for (const args of [
			{ capability, args: { op: "stage", id: "r7" } },
			{ op: "call", capability, parameters: {}, args: { op: "stage", id: "r7" } },
		]) {
			const valid = await registry.invoke({ tool: ToolNames.Gateway, args });
			ok(valid.kind === "ok" && valid.result.kind === "ok", JSON.stringify(valid));
		}
		strictEqual(calls, 2);
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

	it("names unknown fields that sit beside an object argument as possibly belonging inside it", async () => {
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: clioStateDir() }), autonomy: () => "yolo" });
		const capability = mcpToolName("desk", "record");
		ok(capability);
		registry.register({
			name: capability,
			placement: "gateway",
			description: "Write a record",
			parameters: Type.Object(
				{
					uri: Type.String(),
					record: Type.Optional(Type.Object({}, { additionalProperties: true })),
					meta: Type.Optional(Type.Object({ owner: Type.String() }, { additionalProperties: false })),
				},
				{ additionalProperties: false },
			),
			baseActionClass: "write",
			run: async () => ({ kind: "ok", output: "written" }),
		});
		registry.register(createGatewayTool({ registry }));
		const verdict = await registry.invoke({
			tool: ToolNames.Gateway,
			args: {
				op: "call",
				capability,
				args: { uri: "project://v", record: { id: "v" }, meta: {}, issues: [], owner: "me" },
			},
		});
		ok(verdict.kind === "ok" && verdict.result.kind === "error", JSON.stringify(verdict));
		const message = verdict.result.message;
		match(message, /`owner` belongs inside `meta`/);
		match(
			message,
			/`issues` is not a top-level argument but sits beside `record`, `meta` \(objects\); if it belongs inside one of them, move it there/,
		);
		ok(message.indexOf("Misplaced fields") < message.indexOf("Received arguments"), message);
	});

	it("runs a capability's argument normalizer before validating a gateway call", async () => {
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: clioStateDir() }), autonomy: () => "yolo" });
		const scriptRuns: Record<string, unknown>[] = [];
		registry.register({ ...limitationTool, placement: "gateway" });
		registry.register({
			...runScriptToolSurface,
			placement: "gateway",
			run: async (args) => {
				scriptRuns.push(args);
				return { kind: "ok", output: "ran" };
			},
		});
		registry.register(createGatewayTool({ registry }));
		const call = (capability: string, args: Record<string, unknown>) =>
			registry.invoke({ tool: ToolNames.Gateway, args: { op: "call", capability, args } });

		const limitation = await call(ToolNames.Limitation, { scope: "H100 run", reason: "no NVIDIA GPU on this host" });
		ok(limitation.kind === "ok" && limitation.result.kind === "ok", JSON.stringify(limitation));
		deepStrictEqual(limitation.result.details?.limitation, {
			scope: "H100 run (no NVIDIA GPU on this host)",
			reason: "other",
			paths: [],
		});

		const script = await call(RUN_SCRIPT_TOOL_NAME, {
			interpreter: "python3",
			script: "analyze.py",
			args: '["--n", "5"]',
			inputs: "data.csv",
		});
		ok(script.kind === "ok" && script.result.kind === "ok", JSON.stringify(script));
		strictEqual(scriptRuns.length, 1);
		deepStrictEqual(scriptRuns[0]?.args, ["--n", "5"]);
		deepStrictEqual(scriptRuns[0]?.inputs, ["data.csv"]);

		// What a normalizer leaves alone still fails the schema, and no body runs.
		for (const [capability, args] of [
			[ToolNames.Limitation, { scope: "H100 run", reason: 7 }],
			[RUN_SCRIPT_TOOL_NAME, { interpreter: "python3", script: "analyze.py", args: { n: 5 } }],
		] as const) {
			const rejected = await call(capability, args);
			ok(rejected.kind === "ok" && rejected.result.kind === "error", JSON.stringify(rejected));
			match(rejected.result.message, new RegExp(`gateway: ${capability} arguments rejected`));
		}
		strictEqual(scriptRuns.length, 1);
	});

	it("reads a stringified chain step args object, numbers unlinked steps, and names the failing step field", async () => {
		const calls: Array<[string, Record<string, unknown>]> = [];
		const chain = (steps: unknown) =>
			runGatewayChain(steps, {
				getSpec: () => undefined,
				call: async (capability, args) => {
					calls.push([capability, args]);
					return { kind: "ok", output: "done" };
				},
			});
		const ran = await chain([
			{ capability: "tasks", args: '{"action":"start","id":"t1"}' },
			{ id: "s1", capability: "ls", args: {} },
		]);
		ok(ran.kind === "ok", JSON.stringify(ran));
		deepStrictEqual(calls, [
			["tasks", { action: "start", id: "t1" }],
			["ls", {}],
		]);
		deepStrictEqual(
			(ran.details?.steps as Array<{ id: string }>).map((step) => step.id),
			["s1_2", "s1"],
		);

		for (const [steps, error] of [
			[
				[{ id: "a", capability: "ls", args: "[1]" }],
				"steps[0].args must be an object (got a string that is not a JSON object)",
			],
			[[{ id: "a", capability: "ls", args: 7 }], "steps[0].args must be an object (got number)"],
			[[{ id: "a", capability: "ls" }], "steps[0].args is missing"],
			[
				[
					{ id: "a", capability: "ls", args: {} },
					{ capability: "ls", args: {} },
					{ capability: "read", args: {}, after: ["a"] },
				],
				"steps[1].id is missing; every step needs an id when any step uses after or $from",
			],
			[[{ id: "a", capability: "ls", args: {}, note: "x" }], 'steps[0] has unknown key "note"'],
			[[{ capability: "gateway", args: {} }], "nested gateways are not chain steps"],
		] as const) {
			const rejected = await chain(steps);
			ok(
				rejected.kind === "error" && rejected.message.startsWith(`gateway: invalid chain: ${error}`),
				JSON.stringify(rejected),
			);
		}
		strictEqual(calls.length, 2);
	});

	it("repairs the chain envelopes models send, so the steps run instead of a refused round (C-8)", async () => {
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: clioStateDir() }), autonomy: () => "yolo" });
		const capability = mcpToolName("lab", "stage");
		ok(capability);
		const ran: unknown[] = [];
		registry.register({
			name: capability,
			placement: "gateway",
			description: "Stage a fixture",
			parameters: Type.Object({ id: Type.String() }),
			baseActionClass: "read",
			run: async (args) => {
				ran.push(args.id);
				return { kind: "ok", output: `staged ${String(args.id)}` };
			},
		});
		registry.register(createGatewayTool({ registry }));
		const steps = [{ id: "a", capability, args: { id: "r1" } }];
		const cut = JSON.stringify({ steps }).slice(0, -1);
		const digits = [
			{ id: "1", capability, args: { id: "r1" } },
			{ id: "2", capability, args: { id: { $from: "1", path: ["output"] } }, after: ["1"] },
		];
		for (const args of [
			{ op: "chain", args: cut },
			{ args: cut },
			{ op: "chain", args: { steps } },
			{ op: "chain", capability, args: { steps } },
			{ args: { steps } },
			{ steps },
			{ op: "chain", steps: digits },
		]) {
			const verdict = await registry.invoke({ tool: ToolNames.Gateway, args });
			ok(verdict.kind === "ok" && verdict.result.kind === "ok", JSON.stringify({ args, verdict }));
			strictEqual(verdict.result.details?.op, "chain");
		}
		deepStrictEqual(ran, ["r1", "r1", "r1", "r1", "r1", "r1", "r1", "staged r1"]);
		// A string that is not one brace short of a chain stays refused, and no step runs.
		const broken = await registry.invoke({ tool: ToolNames.Gateway, args: { op: "chain", args: cut.slice(0, -2) } });
		ok(broken.kind === "ok" && broken.result.kind === "error", JSON.stringify(broken));
		strictEqual(ran.length, 8);
	});

	it("forwards op=call capability=dispatch to the direct tool and still refuses other direct tools (XR-60)", async () => {
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: clioStateDir() }), autonomy: () => "yolo" });
		const ran: string[] = [];
		for (const name of [ToolNames.Dispatch, ToolNames.Limitation] as const)
			registry.register({
				name,
				placement: "direct",
				description: `stub ${name}`,
				parameters: Type.Object({ task: Type.String() }),
				baseActionClass: name === ToolNames.Dispatch ? "dispatch" : "read",
				run: async () => {
					ran.push(name);
					return { kind: "ok", output: `${name} ran` };
				},
			});
		registry.register(createGatewayTool({ registry }));
		const forwarded = await registry.invoke({
			tool: ToolNames.Gateway,
			args: { op: "call", capability: ToolNames.Dispatch, args: { task: "map src" } },
		});
		ok(forwarded.kind === "ok" && forwarded.result.kind === "ok", JSON.stringify(forwarded));
		match(
			String(forwarded.result.modelContext),
			/^\[dispatch normalize\] gateway op=call capability=dispatch was forwarded/u,
		);
		const refused = await registry.invoke({
			tool: ToolNames.Gateway,
			args: { op: "call", capability: ToolNames.Limitation, args: { task: "x" } },
		});
		ok(refused.kind === "ok" && refused.result.kind === "error", JSON.stringify(refused));
		match(refused.result.message, /is a direct tool with an attached schema/u);
		deepStrictEqual(ran, [ToolNames.Dispatch]);
	});
});
