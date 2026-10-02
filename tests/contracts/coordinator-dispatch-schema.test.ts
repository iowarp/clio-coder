import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Value } from "typebox/value";
import { FLEET_ANTI_CHURN_RULE } from "../../src/domains/agents/catalog.js";
import { normalizeDispatchIntent } from "../../src/domains/dispatch/intent.js";
import { compile } from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { validateEngineToolArguments } from "../../src/engine/ai.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { resolveAgentTools } from "../../src/tools/agent-tools.js";
import { buildDispatchParameters, coordinatorDispatchParameters } from "../../src/tools/dispatch-schema.js";
import { createGatewayTool } from "../../src/tools/gateway/index.js";
import { createRegistry } from "../../src/tools/registry.js";
import type { IsolatedClioEnv } from "../harness/scratch-env.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

describe("compact coordinator dispatch contract", () => {
	let env: IsolatedClioEnv;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coordinator-dispatch-");
	});
	afterEach(() => env.restore());

	it("allows fresh operator dispatch requests after resolved runs", () => {
		match(FLEET_ANTI_CHURN_RULE, /while an identical run is pending/);
		match(FLEET_ANTI_CHURN_RULE, /operator merged, discarded, or kept/);
		match(FLEET_ANTI_CHURN_RULE, /new operator request may dispatch the same task again/);
	});

	it("passes canonical string, object, and mixed tasks through both validation stages", async () => {
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: env.dir }), autonomy: () => "yolo" });
		const received: Record<string, unknown>[] = [];
		registry.register({
			name: "dispatch",
			description: "Dispatch contract fixture.",
			parameters: buildDispatchParameters(),
			modelParameters: coordinatorDispatchParameters(),
			baseActionClass: "read",
			run: async (args) => {
				received.push(args);
				return { kind: "ok", output: "accepted" };
			},
		});
		const tool = resolveAgentTools({ registry }).find((entry) => entry.name === "dispatch");
		ok(tool);
		for (const tasks of [
			["first assignment", "second assignment"],
			[{ task: "first assignment", agent: "scout" }, { task: "second assignment" }],
			[
				"first assignment",
				{
					task: "second assignment",
					briefing: "evidence",
					intent: { verification: [{ check: "test", timeout_ms: 1000 }] },
				},
			],
		]) {
			const args = { agent: "coder", mode: "parallel", tasks };
			const validated = validateEngineToolArguments(tool, {
				type: "toolCall",
				id: "batch",
				name: "dispatch",
				arguments: args,
			});
			await tool.execute("batch", validated);
			deepStrictEqual(received.at(-1), args);
		}
		const invalid = { tasks: ["valid"], candidates: "many" };
		ok(Value.Check(tool.parameters, invalid), "hidden fields reach canonical validation");
		await rejects(tool.execute("invalid", invalid), /candidates/u);
		strictEqual(received.length, 3, "invalid canonical arguments never execute");
	});

	it("admits every shared ordinary field with its canonical type", () => {
		const canonical = buildDispatchParameters();
		const compact = coordinatorDispatchParameters();
		const ordinary = {
			list: false,
			agent: "coder",
			task: "one assignment",
			briefing: "evidence",
			mode: "sequential",
			worktree: true,
			detach: false,
			intent: {
				read_roots: ["src"],
				write_roots: ["src"],
				expected_outputs: ["src/x.ts"],
				verification: [{ check: "test", timeout_ms: 1000 }],
			},
		};
		for (const [field, value] of Object.entries(ordinary)) {
			ok(Value.Check(canonical, { [field]: value }), `canonical ${field}`);
			ok(Value.Check(compact, { [field]: value }), `compact ${field}`);
		}
		for (const intent of [ordinary.intent, { relevant_paths: ["src/x.ts"], verification: [{ check: "test" }] }]) {
			for (const args of [{ intent }, { tasks: [{ task: "assignment", agent: "scout", briefing: "evidence", intent }] }]) {
				ok(Value.Check(canonical, args));
				ok(Value.Check(compact, args));
			}
		}
	});

	it("rejects malformed advertised forms and describes the attached direct schema", async () => {
		const compact = coordinatorDispatchParameters();
		for (const args of [
			{ tasks: [3] },
			{ tasks: [{}] },
			{ tasks: [{ task: false }] },
			{ tasks: "assignment" },
			{ agent: [] },
			{ task: {} },
			{ list: "yes" },
			{ briefing: [] },
			{ mode: [] },
			{ worktree: false },
			{ detach: {} },
			{ intent: "paths" },
			{ intent: { read_roots: "src" } },
			{ intent: { write_roots: [false] } },
			{ intent: { expected_outputs: [1] } },
			{ intent: { verification: { check: "test" } } },
			{ intent: { verification: ["test"] } },
			{ intent: { verification: [{ check: 1 }] } },
			{ intent: { verification: [{ check: "test", timeout_ms: 0 }] } },
			{ intent: { verification: [{ check: "test", timeout_ms: "long" }] } },
			{ intent: { verification: [{ check: "test", command: "pnpm test" }] } },
		])
			strictEqual(Value.Check(compact, args), false, JSON.stringify(args));
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: env.dir }), autonomy: () => "yolo" });
		registry.register({
			name: "dispatch",
			description: "fixture",
			parameters: buildDispatchParameters(),
			modelParameters: compact,
			baseActionClass: "read",
			run: async () => ({ kind: "ok", output: "unused" }),
		});
		registry.register(createGatewayTool({ registry }));
		const verdict = await registry.invoke({ tool: "gateway", args: { op: "describe", capability: "dispatch" } });
		ok(verdict.kind === "ok" && verdict.result.kind === "ok");
		const described = JSON.parse(verdict.result.output) as {
			parameters: { properties: Record<string, unknown> };
			authority: string[];
		};
		const attached = resolveAgentTools({ registry });
		deepStrictEqual(described.parameters, attached.find((tool) => tool.name === "dispatch")?.parameters);
		for (const field of ["model", "candidates", "members", "context", "routing"]) {
			ok(!(field in compact.properties));
			ok(!(field in described.parameters.properties));
		}
		match(described.authority.join(" "), /"dispatch" is a direct tool.*call it directly, not through the gateway/u);
		const gatewayVerdict = await registry.invoke({ tool: "gateway", args: { op: "describe", capability: "gateway" } });
		ok(gatewayVerdict.kind === "ok" && gatewayVerdict.result.kind === "ok");
		const gatewayDescription = JSON.parse(gatewayVerdict.result.output) as { parameters: unknown; authority: string[] };
		deepStrictEqual(gatewayDescription.parameters, attached.find((tool) => tool.name === "gateway")?.parameters);
		match(
			gatewayDescription.authority.join(" "),
			/"gateway" is a direct tool.*call it directly, not through the gateway/u,
		);
	});

	it("teaches the declared-check array contract and still rejects invented check ids", () => {
		for (const schema of [coordinatorDispatchParameters(), buildDispatchParameters()]) {
			const description = JSON.stringify(schema.properties.intent);
			match(description, /array/u);
			match(description, /verify\(\)/u);
			match(description, /never invent/u);
		}
		const checks = new Map([["test", { id: "test", timeoutMs: 5000 }]]);
		const declared = normalizeDispatchIntent({ verification: [{ check: "test" }] }, checks);
		ok(declared.ok);
		deepStrictEqual(declared.intent.verification, [{ check: "test", timeoutMs: 5000 }]);
		const invented = normalizeDispatchIntent({ verification: [{ check: "test suite" }] }, checks);
		ok(!invented.ok);
		strictEqual(invented.reason, "verification_check_undeclared");
		const malformed = normalizeDispatchIntent({ verification: { check: "test" } }, checks);
		ok(!malformed.ok);
		strictEqual(malformed.reason, "verification_malformed");
	});

	it("guides direct trivial work while preserving substantial and explicitly requested delegation", () => {
		const compiled = compile(loadFragments(), {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.default",
			sessionInputs: {
				provider: "fixture",
				model: "fixture",
				providerSupportsTools: true,
				toolNames: ["dispatch", "gateway", "read", "edit"],
				coordinatorCapabilities: ["context"],
			},
		});
		const prompt = compiled.systemPrompt.replace(/\s+/gu, " ");
		match(
			prompt,
			/Execute a small, cohesive local implementation and its focused check directly when your admitted tools suffice and delegation adds no useful independence or capability/u,
		);
		match(prompt, /Delegate substantial work with independent parts or work requiring worker capabilities/u);
		strictEqual(prompt.includes("open-ended repository exploration belongs to Scout"), false);
		match(prompt, /honor explicit delegation requests/u);
		match(prompt, /explicit no-delegation/u);
	});
});
