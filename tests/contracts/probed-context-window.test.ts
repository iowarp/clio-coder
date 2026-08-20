import { strictEqual } from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { collectRows } from "../../src/cli/models.js";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/contract.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import { FileKnowledgeBase } from "../../src/domains/providers/types/knowledge-base.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import type { EngineModel } from "../../src/engine/types.js";
import { synthesizeOrchestratorModel } from "../../src/entry/orchestrator.js";

const MODEL = "Qwen3.8-27B-IQ4_NL-262K";
const SERVED_WINDOW = 131_072;
const CATALOG_WINDOW = 262_144;

function fixture(): {
	providers: ProvidersContract;
	status: TargetStatus;
	target: TargetDescriptor;
} {
	const target: TargetDescriptor = { id: "mini", runtime: "llamacpp", defaultModel: MODEL };
	const runtime: RuntimeDescriptor = {
		id: "llamacpp",
		displayName: "llama.cpp",
		kind: "http",
		tier: "local-native",
		apiFamily: "openai-completions",
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: CATALOG_WINDOW },
		synthesizeModel: () =>
			({
				id: MODEL,
				name: MODEL,
				api: "openai-completions",
				provider: "llamacpp",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: CATALOG_WINDOW,
				maxTokens: 131_072,
			}) as EngineModel,
	};
	const status = {
		target,
		runtime,
		available: true,
		reason: "scripted probe",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities: { ...runtime.defaultCapabilities },
		probeCapabilities: { contextWindow: SERVED_WINDOW },
		probeModelCapabilities: { [MODEL]: { contextWindow: SERVED_WINDOW } },
		probeModelId: MODEL,
		discoveredModels: [MODEL],
	} as TargetStatus;
	const bundled = join(dirname(fileURLToPath(import.meta.url)), "../../src/domains/providers/models");
	const knowledgeBase = new FileKnowledgeBase([{ dir: bundled, label: "bundled" }]);
	const providers = {
		list: () => [status],
		getRuntime: (id: string) => (id === runtime.id ? runtime : null),
		getDetectedReasoning: () => null,
		knowledgeBase,
	} as unknown as ProvidersContract;
	return { providers, status, target };
}

describe("contracts/probed context window propagation", () => {
	it("patches the orchestrator engine model with the served window", () => {
		const { providers, target } = fixture();
		const model = synthesizeOrchestratorModel(providers, target, MODEL);
		strictEqual(model?.contextWindow, SERVED_WINDOW);
	});

	it("shows the served window in the models row", () => {
		const { providers, status } = fixture();
		const row = collectRows([status], providers).find((candidate) => candidate.modelId === MODEL);
		strictEqual(row?.contextWindow, SERVED_WINDOW);
	});
});
