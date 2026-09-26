import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Type } from "typebox";
import { withModelSkillActivation } from "../../src/core/skill-activation.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { buildPathIndex } from "../../src/domains/context/working-set/path-index.js";
import { isProtected } from "../../src/domains/context/working-set/protect.js";
import type { MiddlewareContract } from "../../src/domains/middleware/contract.js";
import { createDetachedDispatchNudgeRegistration } from "../../src/domains/middleware/dispatch-nudge.js";
import { runMiddlewareRegistrations } from "../../src/domains/middleware/runtime.js";
import { createTaskNudgeRegistration } from "../../src/domains/middleware/task-nudge.js";
import { createMiddlewareToolChoiceControl } from "../../src/domains/middleware/tool-choice-control.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { compile, sessionCanUseSkills } from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { assessFinishContract } from "../../src/domains/safety/finish-contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { buildHandoffReadLedger } from "../../src/domains/session/handoff.js";
import { foldSessionArtifacts } from "../../src/domains/session/session-artifacts.js";
import { createLoopGuardRegistration } from "../../src/engine/loop-guard.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { createTurnMiddleware } from "../../src/interactive/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/interactive/turn-state.js";
import { resolveAgentTools } from "../../src/tools/agent-tools.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { createContextTool } from "../../src/tools/context/index.js";
import { createGatewayTool } from "../../src/tools/gateway/index.js";
import {
	createRegistry,
	type ToolInvokeOptions,
	type ToolRegistry,
	type ToolResult,
	type ToolSpec,
} from "../../src/tools/registry.js";
import { gatewayChainReceipts } from "../../src/tools/surface.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

function resultOf(verdict: Awaited<ReturnType<ToolRegistry["invoke"]>>): ToolResult {
	if (verdict.kind !== "ok") throw new Error(JSON.stringify(verdict));
	return verdict.result;
}

function payloadOf(result: ToolResult) {
	return JSON.parse(result.kind === "ok" ? result.output : result.message) as {
		status?: string;
		boundary?: string;
		pending?: string[];
		results?: Array<{ id: string; kind: string; output: string }>;
		capabilities?: Array<{ name: string }>;
		total?: number;
		nextOffset?: number;
		parameters?: { properties: Record<string, unknown> };
	};
}

describe("coordinator discovery and dependency composition", () => {
	let env: IsolatedClioEnv;
	let registry: ToolRegistry;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-harness-discovery-");
		registry = createRegistry({ safety: createWorkerSafety({ cwd: env.dir }), autonomy: () => "yolo" });
		registerAllTools(registry, { mcpCapabilities: false });
	});
	afterEach(() => env.restore());

	const chain = async (steps: unknown[], options?: ToolInvokeOptions) =>
		resultOf(
			await registry.invoke(
				{
					tool: ToolNames.Gateway,
					args: { op: "chain", steps },
				},
				options,
			),
		);
	const register = (id: string, run: ToolSpec["run"], parallel = true): string => {
		const name = `extension_fixture__${id}`;
		registry.register({
			name: name as ToolName,
			description: `Fixture ${id}.`,
			parameters: Type.Object({}),
			placement: "gateway",
			baseActionClass: "read",
			executionMode: parallel ? "parallel" : "sequential",
			run,
		});
		return name;
	};

	it("attaches five coordinator schemas, retains canonical dispatch validation, and keeps worker execution tools", async () => {
		const bundle = makeDispatchBundle(dispatchStubContext());
		await bundle.extension.start();
		try {
			registerAllTools(registry, { mcpCapabilities: false, dispatch: bundle.contract });
			const tools = resolveAgentTools({ registry });
			deepStrictEqual(
				tools.map((tool) => tool.name),
				["dispatch", "edit", "gateway", "read", "write"],
			);
			const wireDispatch = tools.find((tool) => tool.name === "dispatch");
			ok(wireDispatch);
			const wire = wireDispatch.parameters as { properties: Record<string, unknown> };
			ok(!("candidates" in wire.properties));
			const full = payloadOf(
				resultOf(await registry.invoke({ tool: ToolNames.Gateway, args: { op: "describe", capability: "dispatch" } })),
			);
			ok(full.parameters && "candidates" in full.parameters.properties);
			await rejects(wireDispatch.execute("malformed", { candidates: "many" }), /candidates/u);
			const worker = resolveAgentTools({ registry: createWorkerToolRegistry() });
			for (const name of ["bash", "grep", "context", "verify"]) ok(worker.some((tool) => tool.name === name));
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("keeps follow-through capabilities available to hooks without advertising their schemas", async () => {
		const bundle = makeDispatchBundle(dispatchStubContext());
		await bundle.extension.start();
		try {
			registerAllTools(registry, { mcpCapabilities: false, dispatch: bundle.contract });
			const nudge = createTaskNudgeRegistration({
				getBoard: () => ({
					boardId: "fixture",
					title: "Implement solver",
					tasks: [{ id: "t1", title: "Check solver", status: "pending" }],
					activeRunIds: [],
				}),
			});
			const detached = createDetachedDispatchNudgeRegistration({
				getOpenBatches: () => [{ id: "finished", total: 1, terminal: 1, terminalOutcomes: { succeeded: 1 } }],
			});
			const state = createTurnState("off");
			state.turnToolCalls = 1;
			const runtime = {
				wireModelId: "fixture",
				runtimeId: "fixture",
				runtimeResolution: {},
				agent: { state: { tools: resolveAgentTools({ registry }), messages: [] } },
			} as unknown as AgentRuntime;
			const observed: MiddlewareHookInput[] = [];
			const middleware = createTurnMiddleware({
				state,
				toolRegistry: registry,
				middleware: {
					runHook: (input: MiddlewareHookInput) => {
						observed.push(input);
						return runMiddlewareRegistrations(input, [nudge, detached]);
					},
				} as MiddlewareContract,
				middlewareToolChoice: createMiddlewareToolChoiceControl(),
				emitNotice: () => {},
				emitFooterNotice: () => {},
			});
			middleware.fireTurnStart(runtime, "Implement solver");
			await middleware.fireTurnEnd(runtime, [], { toolCallId: "fixture", toolName: "gateway" });
			for (const input of observed) {
				strictEqual(input.metadata?.activeToolNames, "dispatch,edit,gateway,read,write");
				for (const name of ["tasks", "monitor", "verify"]) {
					ok(String(input.metadata?.activeCapabilityNames).split(",").includes(name));
				}
			}
			const reminder = middleware.flushPendingReminders();
			match(reminder, /Check solver/u);
			match(reminder, /batch finished/u);
			strictEqual(state.pendingRequestContinuation, true);
			// Scope changes cannot be defeated by retaining a gateway schema.
			state.currentTurnConstraints = { allowedTools: ["read"] };
			state.pendingRequestContinuation = false;
			await middleware.fireTurnEnd(runtime, [], { toolCallId: "scoped", toolName: "read" });
			strictEqual(observed.at(-1)?.metadata?.activeCapabilityNames, "read");
			strictEqual(middleware.flushPendingReminders(), "");
			strictEqual(state.pendingRequestContinuation, false);
			state.currentTurnConstraints = undefined;
			runtime.agent.state.tools = [];
			await middleware.fireTurnEnd(runtime, [], { toolCallId: "no-tools", toolName: "read" });
			strictEqual(observed.at(-1)?.metadata?.activeCapabilityNames, "");
			strictEqual(middleware.flushPendingReminders(), "");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("keeps a hidden named capability reachable without admitting unrelated tools", async () => {
		const constraints = { allowedTools: ["context"] };
		deepStrictEqual(
			resolveAgentTools({ registry, turnConstraints: constraints }).map((tool) => tool.name),
			["gateway"],
		);
		const syntax = resultOf(
			await registry.invoke(
				{ tool: ToolNames.Gateway, args: { op: "describe", capability: "gateway" } },
				{ turnConstraints: constraints },
			),
		);
		strictEqual(syntax.kind, "ok");
		if (syntax.kind === "ok") match(syntax.output, /\$from/u);
		const denied = await registry.invoke(
			{
				tool: ToolNames.Gateway,
				args: { op: "call", capability: "write", args: { path: join(env.dir, "forbidden"), content: "x" } },
			},
			{ turnConstraints: constraints },
		);
		strictEqual(resultOf(denied).kind, "error");
		strictEqual(
			sessionCanUseSkills({
				providerSupportsTools: true,
				toolNames: ["gateway"],
				coordinatorCapabilities: ["context"],
				turnConstraints: constraints,
			}),
			true,
		);
		strictEqual(
			sessionCanUseSkills({
				providerSupportsTools: true,
				toolNames: ["gateway"],
				coordinatorCapabilities: ["context"],
				turnConstraints: { allowedTools: ["read"] },
			}),
			false,
		);
	});

	it("compiles compact coordinator guidance with capability gating and preserves explicit answer scope", () => {
		const table = loadFragments();
		const compiled = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.default",
			sessionInputs: {
				provider: "fixture",
				model: "fixture",
				providerSupportsTools: true,
				toolNames: ["read", "write", "edit", "dispatch", "gateway"],
				coordinatorCapabilities: registry.listAll().map((spec) => spec.name),
				turnConstraints: { mode: "answer", delegation: "forbidden", skills: "disabled" },
				fleetRoster: "A roster should not be preloaded",
			},
		});
		for (const id of ["delegation", "skills", "fleet"]) ok(!compiled.sections.some((section) => section.id === id));
		ok(!compiled.systemPrompt.includes("A roster should not be preloaded"));
		ok(compiled.systemPrompt.includes('capability="context", args={scope:"settings"}'));
	});

	it("finds multiword intent and pages the catalog deterministically", async () => {
		for (let index = 0; index < 25; index++) register(`item${index}`, async () => ({ kind: "ok", output: "" }));
		const first = payloadOf(
			resultOf(await registry.invoke({ tool: ToolNames.Gateway, args: { op: "find", query: "Fixture", limit: 12 } })),
		);
		strictEqual(first.capabilities?.length, 12);
		strictEqual(first.total, 25);
		strictEqual(first.nextOffset, 12);
		const second = payloadOf(
			resultOf(
				await registry.invoke({
					tool: ToolNames.Gateway,
					args: { op: "find", query: "Fixture", offset: first.nextOffset, limit: 12 },
				}),
			),
		);
		const combined = [...(first.capabilities ?? []), ...(second.capabilities ?? [])].map((item) => item.name);
		strictEqual(new Set(combined).size, 24);
		const found = payloadOf(
			resultOf(
				await registry.invoke({ tool: ToolNames.Gateway, args: { op: "find", query: "inspect effective settings" } }),
			),
		);
		ok(found.capabilities?.some((entry) => entry.name === "context"));
	});

	it("runs independent reads together, then binds a dependency's structured output to a real write", async () => {
		let starts = 0;
		let release = () => {};
		const rendezvous = new Promise<void>((resolve) => {
			release = resolve;
		});
		const read = async (): Promise<ToolResult> => {
			starts++;
			if (starts === 2) release();
			await rendezvous;
			return { kind: "ok", output: JSON.stringify({ value: "bound data\n" }) };
		};
		const one = register("one", read);
		const two = register("two", read);
		const result = await chain([
			{ id: "one", capability: one, args: {} },
			{ id: "two", capability: two, args: {} },
			{
				id: "save",
				capability: "write",
				after: ["two"],
				args: { path: join(env.dir, "result.txt"), content: { $from: "one", path: ["json", "value"] } },
			},
		]);
		strictEqual(result.kind, "ok");
		strictEqual(payloadOf(result).status, "complete");
		strictEqual(readFileSync(join(env.dir, "result.txt"), "utf8"), "bound data\n");
	});

	it("keeps receipt order in execution order even when dependencies are declared later", async () => {
		const path = join(env.dir, "ordered.txt");
		const result = await chain([
			{ id: "last", capability: "write", args: { path, content: "last" }, after: ["first"] },
			{ id: "first", capability: "write", args: { path, content: "first" } },
		]);
		strictEqual(readFileSync(path, "utf8"), "last");
		deepStrictEqual(
			gatewayChainReceipts("gateway", result).map((child) => child.id),
			["first", "last"],
		);
		for (const child of gatewayChainReceipts("gateway", result)) {
			strictEqual(child.admission.outcome, "ok");
			strictEqual(child.admission.decision, "allowed");
		}
	});

	it("rejects invalid dependency plans before any operation runs", async () => {
		let calls = 0;
		const name = register("noop", async () => {
			calls++;
			return { kind: "ok", output: "" };
		});
		for (const steps of [
			[{ id: "one", capability: name, args: {}, after: ["missing"] }],
			[
				{ id: "one", capability: name, args: {}, after: ["two"] },
				{ id: "two", capability: name, args: {}, after: ["one"] },
			],
			[{ id: "one", capability: name, args: { input: { $from: "one", path: ["output"] } } }],
		])
			strictEqual((await chain(steps)).kind, "error");
		strictEqual(calls, 0);
	});

	it("stops on failure and surfaces completed operations and pending ids", async () => {
		let writes = 0;
		const fail = register("fail", async () => ({ kind: "error", message: "source unavailable" }));
		const next = register(
			"next",
			async () => {
				writes++;
				return { kind: "ok", output: "" };
			},
			false,
		);
		const result = await chain([
			{ id: "failed", capability: fail, args: {} },
			{ id: "next", capability: next, args: {}, after: ["failed"] },
		]);
		strictEqual(result.kind, "error");
		const payload = payloadOf(result);
		strictEqual(payload.status, "failed");
		deepStrictEqual(payload.pending, ["next"]);
		strictEqual(writes, 0);
	});

	it("returns to reasoning after an interview without running a dependent mutation", async () => {
		registry.register({
			name: ToolNames.AskUser,
			placement: "gateway",
			description: "Interview operator.",
			parameters: Type.Object({ question: Type.String() }),
			baseActionClass: "read",
			executionMode: "sequential",
			run: async (args) => ({
				kind: "ok",
				output: JSON.stringify({ answer: "keep existing design", question: args.question }),
			}),
		});
		const read = register("evidence", async () => ({ kind: "ok", output: '{"question":"Which boundary condition?"}' }));
		const result = await chain([
			{ id: "inspect", capability: read, args: {} },
			{ id: "interview", capability: "ask_user", args: { question: { $from: "inspect", path: ["json", "question"] } } },
			{ id: "edit", capability: "write", after: ["interview"], args: { path: join(env.dir, "unexpected"), content: "x" } },
		]);
		const payload = payloadOf(result);
		strictEqual(payload.status, "paused");
		deepStrictEqual(payload.pending, ["edit"]);
		match(payload.boundary ?? "", /operator replied/u);
	});

	it("enforces each step's tool ceiling", async () => {
		let calls = 0;
		const name = register("excluded", async () => {
			calls++;
			return { kind: "ok", output: "" };
		});
		const result = await chain([{ id: "excluded", capability: name, args: {} }], { allowedTools: [ToolNames.Gateway] });
		strictEqual(result.kind, "error");
		strictEqual(calls, 0);
	});

	it("does not schedule operations after cancellation", async () => {
		let calls = 0;
		const name = register("cancelled", async () => {
			calls++;
			return { kind: "ok", output: "" };
		});
		const controller = new AbortController();
		controller.abort();
		const result = await chain([{ id: "cancelled", capability: name, args: {} }], { signal: controller.signal });
		strictEqual(calls, 0);
		match(payloadOf(result).boundary ?? "", /cancelled/u);
	});

	it("describes the chain contract without executing steps", async () => {
		const result = resultOf(
			await registry.invoke({ tool: ToolNames.Gateway, args: { op: "describe", capability: "gateway" } }),
		);
		strictEqual(result.kind, "ok");
		if (result.kind === "ok") match(result.output, /\$from/u);
		ok(payloadOf(result).parameters?.properties.steps);
	});

	it("keeps the gateway schema smaller than the execution catalog", () => {
		const schema = createGatewayTool({ registry });
		ok(Buffer.byteLength(JSON.stringify(schema.parameters)) < 2_500);
	});

	it("preserves successful receipts after a later failure through the actual agent adapter", async () => {
		const source = join(env.dir, "input.txt");
		const target = join(env.dir, "output.txt");
		writeFileSync(source, "evidence");
		const fail = register("late_failure", async () => ({ kind: "error", message: "unavailable" }), false);
		const gateway = resolveAgentTools({ registry }).find((tool) => tool.name === "gateway");
		ok(gateway);
		const result = await gateway.execute("aggregate", {
			op: "chain",
			steps: [
				{ id: "read", capability: "read", args: { path: source } },
				{ id: "write", capability: "write", after: ["read"], args: { path: target, content: "saved" } },
				{ id: "fail", capability: fail, after: ["write"], args: {} },
				{ id: "pending", capability: "write", after: ["fail"], args: { path: join(env.dir, "never.txt"), content: "x" } },
			],
		});
		strictEqual(result.details.kind, "error");
		const entry: SessionEntry = {
			kind: "message",
			role: "tool_result",
			turnId: "receipt",
			parentTurnId: "user",
			timestamp: new Date().toISOString(),
			payload: { toolName: "gateway", toolCallId: "aggregate", isError: true, result },
		};
		const entries: SessionEntry[] = [
			{
				kind: "message",
				role: "user",
				turnId: "user",
				parentTurnId: null,
				timestamp: entry.timestamp,
				payload: { text: "change" },
			},
			entry,
		];
		deepStrictEqual([...buildHandoffReadLedger(entries, { cwd: env.dir })], ["input.txt", "output.txt"]);
		deepStrictEqual(
			foldSessionArtifacts(entries, { workspace: env.dir }).map((artifact) => artifact.path),
			[target],
		);
		const assessment = assessFinishContract({ sessionEntries: entries });
		strictEqual(assessment.kind, "engage");
		deepStrictEqual(assessment.mutatedPaths, [target]);
		const index = buildPathIndex(entries, { cwd: env.dir });
		ok(index.byPath.has(source) && index.byPath.has(target));
		ok(!index.byRef.has("receipt"), "an aggregate cannot be indexed as just one child");
		for (const observation of index.observations) {
			strictEqual(observation.ref.entry, "receipt");
			strictEqual(observation.entryIndex, 1);
		}
		strictEqual(isProtected(entry, { entryIndex: 1, cutoffIndex: 10, index, input: {} as never }), true);
	});

	it("loads one real skill and returns its complete instructions before any dependent operation", async () => {
		const skillDir = join(env.dir, ".clio-coder", "skills", "chain-workflow");
		mkdirSync(skillDir, { recursive: true });
		const body = "Follow this scientific workflow.\n".repeat(1200);
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: chain-workflow\ndescription: Chain fixture.\ndisallowed-tools: write\n---\n\n${body}`,
		);
		registry.register({ ...createContextTool({ getCwd: () => env.dir }), placement: "gateway" });
		let activation = "";
		const policy = withModelSkillActivation(undefined, true);
		ok(policy);
		const gateway = resolveAgentTools({
			registry,
			invokeOptions: () => ({ pendingSkillPolicy: policy }),
			telemetry: {
				onFinish: (event) => {
					activation = event.skillActivation?.name ?? "";
				},
			},
		}).find((tool) => tool.name === "gateway");
		ok(gateway);
		const result = await gateway.execute("activation", {
			op: "chain",
			steps: [
				{ id: "load", capability: "context", args: { scope: "skills", name: "chain-workflow" } },
				{ id: "save", capability: "write", after: ["load"], args: { path: join(env.dir, "never.txt"), content: "x" } },
			],
		});
		strictEqual(activation, "chain-workflow", JSON.stringify(result));
		const text = result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const payload = JSON.parse(text);
		strictEqual(payload.status, "paused");
		deepStrictEqual(payload.pending, ["save"]);
		ok(
			payload.results[0].output.includes(body.trim()),
			"activation instructions are not divided by the chain output allowance",
		);
		const denied = resultOf(
			await registry.invoke(
				{
					tool: "gateway",
					args: { op: "call", capability: "write", args: { path: join(env.dir, "denied.txt"), content: "x" } },
				},
				{ pendingSkillPolicy: policy },
			),
		);
		strictEqual(denied.kind, "error", "the loaded workflow's exclusions still bind resumed work");
	});

	it("counts every chained child against the worker call budget and stops at the ceiling", async () => {
		const safety = createWorkerSafety({ cwd: env.dir });
		const guard = createLoopGuardRegistration({ safety, toolCallCap: 2 });
		const worker = createWorkerToolRegistry(undefined, safety, undefined, [guard]);
		writeFileSync(join(env.dir, "a.txt"), "a");
		writeFileSync(join(env.dir, "b.txt"), "b");
		const result = resultOf(
			await worker.invoke({
				tool: "gateway",
				args: {
					op: "chain",
					steps: [
						{ id: "one", capability: "read", args: { path: join(env.dir, "a.txt") } },
						{ id: "two", capability: "read", after: ["one"], args: { path: join(env.dir, "b.txt") } },
					],
				},
			}),
		);
		strictEqual(result.kind, "error");
		strictEqual(guard.callCount(), 3, "wrapper and both child attempts are counted");
		deepStrictEqual(
			payloadOf(result).results?.map((row) => row.kind),
			["ok", "error"],
		);
	});
});
