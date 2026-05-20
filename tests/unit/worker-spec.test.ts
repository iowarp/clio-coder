import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import type { RuntimeDescriptor } from "../../src/domains/providers/index.js";
import {
	parseWorkerSpec,
	serializeWorkerRuntimeDescriptor,
	validateRehydratedWorkerRuntime,
	WORKER_RUNTIME_DESCRIPTOR_VERSION,
	WORKER_SPEC_VERSION,
	type WorkerSpec,
} from "../../src/worker/spec-contract.js";

const runtime: RuntimeDescriptor = {
	id: "openai",
	displayName: "OpenAI",
	kind: "http",
	tier: "cloud",
	apiFamily: "openai-responses",
	auth: "api-key",
	credentialsEnvVar: "OPENAI_API_KEY",
	defaultCapabilities: {
		chat: true,
		tools: true,
		reasoning: true,
		vision: false,
		audio: false,
		embeddings: false,
		rerank: false,
		fim: false,
		contextWindow: 128000,
		maxTokens: 4096,
	},
	synthesizeModel: (_endpoint, wireModelId) => ({ id: wireModelId, provider: "openai" }) as never,
};

function spec(): WorkerSpec {
	return {
		specVersion: WORKER_SPEC_VERSION,
		systemPrompt: "",
		task: "run",
		endpoint: { id: "openai", runtime: "openai", defaultModel: "gpt-test" },
		runtime: serializeWorkerRuntimeDescriptor(runtime),
		runtimeId: runtime.id,
		wireModelId: "gpt-test",
		allowedTools: ["read"],
	};
}

describe("dispatch worker spec contract", () => {
	it("serializes only the runtime fields required to validate worker rehydration", () => {
		deepStrictEqual(serializeWorkerRuntimeDescriptor(runtime), {
			version: WORKER_RUNTIME_DESCRIPTOR_VERSION,
			id: "openai",
			kind: "http",
			apiFamily: "openai-responses",
			auth: "api-key",
		});
	});

	it("accepts a rehydrated runtime whose worker-boundary fields match", () => {
		validateRehydratedWorkerRuntime(spec(), runtime);
	});

	it("parses the worker spec fields consumed by worker entry and runtime", () => {
		const parsed = parseWorkerSpec({
			...spec(),
			mode: "default",
			thinkingLevel: "medium",
			dynamicPromptMessages: [{ id: "dispatch-memory", body: "# Memory\n\nlesson", contentHash: "abc" }],
			allowedTools: ["read", "bash"],
			modelCapabilities: {
				reasoning: true,
				contextWindow: 128000,
				maxTokens: 4096,
			},
			middlewareSnapshot: {
				version: 1,
				rules: [
					{
						id: "example-rule",
						source: "builtin",
						description: "example",
						enabled: true,
						hooks: ["before_tool"],
						effectKinds: ["block_tool"],
					},
				],
			},
			autoApprove: "deny",
		});

		strictEqual(parsed.mode, "default");
		strictEqual(parsed.thinkingLevel, "medium");
		deepStrictEqual(parsed.dynamicPromptMessages, [
			{ id: "dispatch-memory", body: "# Memory\n\nlesson", contentHash: "abc" },
		]);
		deepStrictEqual(parsed.allowedTools, ["read", "bash"]);
	});

	it("rejects malformed consumed worker fields before runtime execution", () => {
		throws(() => parseWorkerSpec({ ...spec(), task: "" }), /WorkerSpec\.task/);
		const missingAllowedTools = { ...spec() } as Record<string, unknown>;
		Reflect.deleteProperty(missingAllowedTools, "allowedTools");
		throws(() => parseWorkerSpec(missingAllowedTools), /WorkerSpec\.allowedTools/);
		throws(
			() =>
				parseWorkerSpec({
					...spec(),
					endpoint: { id: "openai", runtime: "different-runtime" },
				}),
			/endpoint runtime mismatch/,
		);
		throws(() => parseWorkerSpec({ ...spec(), mode: "private-mode" }), /WorkerSpec\.mode/);
		throws(() => parseWorkerSpec({ ...spec(), allowedTools: ["read", ""] }), /WorkerSpec\.allowedTools\[1\]/);
		throws(
			() =>
				parseWorkerSpec({
					...spec(),
					dynamicPromptMessages: [{ id: "dispatch-memory", body: "", contentHash: "abc" }],
				}),
			/WorkerSpec\.dynamicPromptMessages\[0\]\.body/,
		);
		throws(
			() =>
				parseWorkerSpec({
					...spec(),
					middlewareSnapshot: { version: 1, rules: [{ id: "bad" }] },
				}),
			/source/,
		);
	});

	it("fails clearly when the worker rehydrates a different runtime descriptor shape", () => {
		const mismatched: RuntimeDescriptor = { ...runtime, apiFamily: "anthropic-messages" };

		throws(() => validateRehydratedWorkerRuntime(spec(), mismatched), /apiFamily/);
	});
});
