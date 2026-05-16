import { deepStrictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import type { RuntimeDescriptor } from "../../src/domains/providers/index.js";
import {
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

	it("fails clearly when the worker rehydrates a different runtime descriptor shape", () => {
		const mismatched: RuntimeDescriptor = { ...runtime, apiFamily: "anthropic-messages" };

		throws(() => validateRehydratedWorkerRuntime(spec(), mismatched), /apiFamily/);
	});
});
