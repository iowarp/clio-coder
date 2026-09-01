import { notStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";

import { Type } from "typebox";

import type { CompiledSessionPrompt } from "../../src/domains/prompts/compiler.js";
import type { PromptsContract } from "../../src/domains/prompts/contract.js";
import { canonicalJson, sha256 } from "../../src/domains/prompts/hash.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { toolSignatureFromState } from "../../src/interactive/chat-loop-messages.js";
import {
	attachedToolSchemaBytes,
	attachedToolSchemasFromState,
	type MainPromptCacheIdentityInput,
	mainPromptCacheIdentity,
} from "../../src/interactive/prompt-cache-identity.js";
import { createTurnContext } from "../../src/interactive/turn-context.js";
import type { TurnMiddleware } from "../../src/interactive/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/interactive/turn-state.js";
import type { ToolRegistry } from "../../src/tools/registry.js";

function identityInput(): MainPromptCacheIdentityInput {
	return {
		targetId: "local",
		runtimeId: "llama.cpp",
		wireModelId: "stable-model",
		autonomy: "auto-edit",
		sessionId: "session-1",
		cwd: "/workspace",
		workingContextPaths: ["src/b.ts", "src/a.ts"],
		contextWindowSource: "loaded",
		sessionInputs: {
			provider: "local",
			model: "stable-model",
			contextWindow: 32_768,
			providerSupportsTools: true,
			thinkingGuidance: "Use the runtime envelope.",
			toolNames: ["read"],
			toolPromptHints: [{ tool: "read", hint: "Read narrowly." }],
			memorySection: "# Memory\n\n- stable",
		},
		attachedToolSchemas: [
			{
				name: "read",
				description: "Read one file.",
				parameters: { type: "object", properties: { path: { type: "string" } } },
			},
		],
	};
}

function compiledPrompt(systemPrompt: string): CompiledSessionPrompt {
	return {
		systemPrompt,
		systemPromptHash: sha256(systemPrompt),
		tokenEstimate: 1,
		sections: [{ id: "test", tokenEstimate: 1 }],
		fragmentManifest: [],
	};
}

describe("main compiled-prompt cache identity", () => {
	it("is deterministic and changes for every live byte-affecting input class", () => {
		const base = identityInput();
		const baseSchema = base.attachedToolSchemas[0];
		if (!baseSchema) throw new Error("test fixture requires one attached tool schema");
		const baseKey = mainPromptCacheIdentity(base);
		strictEqual(
			baseKey,
			mainPromptCacheIdentity({ ...identityInput(), workingContextPaths: ["src/a.ts", "src/b.ts"] }),
			"working-context set order must not churn the cache",
		);

		const variants: Array<[string, MainPromptCacheIdentityInput]> = [
			["runtime", { ...identityInput(), runtimeId: "ollama" }],
			[
				"context window",
				{ ...identityInput(), sessionInputs: { ...identityInput().sessionInputs, contextWindow: 16_384 } },
			],
			["context source", { ...identityInput(), contextWindowSource: "probe" }],
			[
				"tool support",
				{ ...identityInput(), sessionInputs: { ...identityInput().sessionInputs, providerSupportsTools: false } },
			],
			[
				"thinking guidance",
				{ ...identityInput(), sessionInputs: { ...identityInput().sessionInputs, thinkingGuidance: "Changed." } },
			],
			[
				"tool prompt hint",
				{
					...identityInput(),
					sessionInputs: {
						...identityInput().sessionInputs,
						toolPromptHints: [{ tool: "read", hint: "Changed." }],
					},
				},
			],
			[
				"memory",
				{ ...identityInput(), sessionInputs: { ...identityInput().sessionInputs, memorySection: "# Memory\n\n- changed" } },
			],
			[
				"schema name",
				{
					...identityInput(),
					attachedToolSchemas: [{ ...baseSchema, name: "read_file" }],
				},
			],
			[
				"schema description",
				{
					...identityInput(),
					attachedToolSchemas: [{ ...baseSchema, description: "Changed." }],
				},
			],
			[
				"schema parameters",
				{
					...identityInput(),
					attachedToolSchemas: [{ ...baseSchema, parameters: { type: "object", properties: {} } }],
				},
			],
			[
				"nested schema property order",
				{
					...identityInput(),
					attachedToolSchemas: [
						{
							...baseSchema,
							parameters: {
								type: "object",
								properties: { offset: { type: "number" }, path: { type: "string" } },
							},
						},
					],
				},
			],
			[
				"schema required order",
				{
					...identityInput(),
					attachedToolSchemas: [
						{
							...baseSchema,
							parameters: {
								type: "object",
								properties: { path: { type: "string" }, offset: { type: "number" } },
								required: ["offset", "path"],
							},
						},
					],
				},
			],
		];
		for (const [label, variant] of variants) {
			notStrictEqual(mainPromptCacheIdentity(variant), baseKey, `${label} must invalidate reuse`);
		}
	});

	it("preserves exact provider ordering for schema objects and tool arrays", () => {
		const schemaA = {
			name: "read",
			description: "Read one file.",
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, offset: { type: "number" } },
				required: ["path", "offset"],
			},
		};
		const schemaB = {
			name: "grep",
			description: "Search files.",
			parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
		};
		const reorderedProperties = {
			...schemaA,
			parameters: {
				type: "object",
				properties: { offset: { type: "number" }, path: { type: "string" } },
				required: ["path", "offset"],
			},
		};
		const reorderedRequired = {
			...schemaA,
			parameters: { ...schemaA.parameters, required: ["offset", "path"] },
		};
		const base = identityInput();
		const key = mainPromptCacheIdentity({ ...base, attachedToolSchemas: [schemaA, schemaB] });

		strictEqual(attachedToolSchemaBytes([schemaA, schemaB]), JSON.stringify([schemaA, schemaB]));
		notStrictEqual(
			mainPromptCacheIdentity({ ...base, attachedToolSchemas: [reorderedProperties, schemaB] }),
			key,
			"nested property insertion order must invalidate reuse",
		);
		notStrictEqual(
			mainPromptCacheIdentity({ ...base, attachedToolSchemas: [reorderedRequired, schemaB] }),
			key,
			"required array order must invalidate reuse",
		);
		notStrictEqual(
			mainPromptCacheIdentity({ ...base, attachedToolSchemas: [schemaB, schemaA] }),
			key,
			"attached tool array order must invalidate reuse",
		);
		notStrictEqual(toolSignatureFromState([schemaA, schemaB]), toolSignatureFromState([reorderedProperties, schemaB]));
		notStrictEqual(toolSignatureFromState([schemaA, schemaB]), toolSignatureFromState([reorderedRequired, schemaB]));
		notStrictEqual(toolSignatureFromState([schemaA, schemaB]), toolSignatureFromState([schemaB, schemaA]));
		notStrictEqual(toolSignatureFromState([schemaA]), toolSignatureFromState([{ ...schemaA, name: "read_file" }]));
		notStrictEqual(toolSignatureFromState([schemaA]), toolSignatureFromState([{ ...schemaA, description: "Changed." }]));
	});

	it("fails closed when attached schemas cannot be serialized", () => {
		const circular: Record<string, unknown> = { type: "object" };
		circular.self = circular;
		throws(
			() => attachedToolSchemaBytes([{ name: "circular", description: "Invalid.", parameters: circular }]),
			/attached tool schemas are not JSON-serializable/u,
		);
		throws(
			() =>
				mainPromptCacheIdentity({
					...identityInput(),
					attachedToolSchemas: [{ name: "bigint", description: "Invalid.", parameters: { value: 1n } }],
				}),
			/attached tool schemas are not JSON-serializable/u,
		);
	});

	it("resolves runtime inputs and exact attached schemas before deciding reuse", async () => {
		let compileCalls = 0;
		let memorySection = "# Memory\n\n- first";
		const prompts: PromptsContract = {
			async compileSessionPrompt(input) {
				compileCalls += 1;
				return compiledPrompt(canonicalJson(input.sessionInputs));
			},
			async compileWorkerPrompt() {
				throw new Error("not used");
			},
			reload() {},
		};
		const state = createTurnState("off");
		const runtime = {
			targetId: "local",
			runtimeId: "llama.cpp",
			wireModelId: "stable-model",
			runtimeResolution: {
				capabilityDecisions: { tools: true },
				contextWindowDetails: { effectiveContextWindow: 32_768, contextWindowSource: "loaded" },
			},
			agent: {
				state: {
					systemPrompt: "",
					thinkingLevel: "off",
					messages: [],
					model: { clio: { quirks: { thinking: { guidance: "Use the runtime envelope." } } } },
					tools: [
						{
							name: "read",
							description: "Read one file.",
							parameters: Type.Object({ path: Type.String() }),
						},
					] as unknown[],
				},
			},
		};
		const agentRuntime = runtime as unknown as AgentRuntime;
		const context = createTurnContext({
			state,
			getSettings: () => ({ safety: { autonomy: "auto-edit" } }) as never,
			providers: { getRuntime: () => undefined } as unknown as ProvidersContract,
			prompts,
			toolRegistry: { get: () => undefined } as unknown as ToolRegistry,
			middleware: {} as TurnMiddleware,
			getMemorySection: () => memorySection,
			emitNotice: () => {},
		});

		await context.ensureSessionPrompt(agentRuntime);
		await context.ensureSessionPrompt(agentRuntime);
		strictEqual(compileCalls, 1, "identical resolved inputs must reuse the compile");

		runtime.agent.state.tools = [
			{ name: "read", description: "Changed description.", parameters: Type.Object({ path: Type.String() }) },
		];
		await context.ensureSessionPrompt(agentRuntime);
		strictEqual(compileCalls, 2, "attached schema descriptions must invalidate reuse");

		runtime.agent.state.tools = [
			{
				name: "read",
				description: "Changed description.",
				parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()) }),
			},
		];
		await context.ensureSessionPrompt(agentRuntime);
		strictEqual(compileCalls, 3, "attached schema parameters must invalidate reuse");

		runtime.runtimeResolution.contextWindowDetails = {
			effectiveContextWindow: 16_384,
			contextWindowSource: "probe",
		} as never;
		await context.ensureSessionPrompt(agentRuntime);
		strictEqual(compileCalls, 4, "resolved context-window inputs must invalidate reuse");

		memorySection = "# Memory\n\n- second";
		await context.ensureSessionPrompt(agentRuntime);
		strictEqual(compileCalls, 5, "resolved memory input must invalidate reuse");

		strictEqual(attachedToolSchemasFromState(runtime.agent.state.tools)[0]?.description, "Changed description.");
		context.dispose();
	});
});
