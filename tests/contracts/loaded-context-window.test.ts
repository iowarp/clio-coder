import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/contract.js";
import { resolveRuntimeTarget } from "../../src/domains/providers/runtime-resolution.js";
import { probeResultFromV1Models } from "../../src/domains/providers/runtimes/local-native/lmstudio.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { shouldCompact } from "../../src/domains/session/compaction/auto.js";
import { buildContextLedger } from "../../src/domains/session/context-ledger.js";
import { coldModelNotice } from "../../src/interactive/turn-runtime.js";

/**
 * The 2026-08-15 live case: qwen3.8-27b downloaded twice, one copy resident at
 * 100,608 tokens, `max_context_length` 262,144 on both.
 */
const MODEL = "qwen3.8-27b";
const LOADED_WINDOW = 100_608;
const MAX_WINDOW = 262_144;

function runtime(): RuntimeDescriptor {
	return {
		id: "lmstudio",
		displayName: "LM Studio",
		kind: "http",
		tier: "local-native",
		apiFamily: "openai-completions",
		auth: "api-key",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, maxTokens: 4096 },
		synthesizeModel: () => ({ id: MODEL, provider: "lmstudio" }) as never,
	};
}

function target(): TargetDescriptor {
	return { id: "dynamo", runtime: "lmstudio", url: "http://dynamo:1234", defaultModel: MODEL };
}

function status(overrides: Partial<TargetStatus> = {}): TargetStatus {
	return {
		target: target(),
		runtime: runtime(),
		available: true,
		reason: "ready",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: 4 },
		capabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: MAX_WINDOW },
		// What the catalog row says the weights allow, which is not what is served.
		probeModelCapabilities: { [MODEL]: { contextWindow: MAX_WINDOW } },
		probeModelId: MODEL,
		discoveredModels: [MODEL],
		discoveredModelsSource: "probe",
		discoveredModelStates: { [MODEL]: { state: "loaded", contextLength: LOADED_WINDOW } },
		...overrides,
	};
}

function providersFor(targetStatus: TargetStatus): ProvidersContract {
	return {
		list: () => [targetStatus],
		getTarget: (id: string) => (id === targetStatus.target.id ? targetStatus.target : null),
		getRuntime: (id: string) => (id === "lmstudio" ? targetStatus.runtime : null),
		getDetectedReasoning: () => null,
		knowledgeBase: null,
	} as never;
}

describe("contracts/loaded context window", () => {
	it("plans against the loaded window, not the window the model could support", () => {
		const resolution = resolveRuntimeTarget(providersFor(status()), {
			targetId: "dynamo",
			wireModelId: MODEL,
			use: "orchestrator",
		});

		ok(resolution.ok, "resolution must succeed");
		const details = resolution.target.contextWindowDetails;
		strictEqual(details.effectiveContextWindow, LOADED_WINDOW, "the backend serves 100,608, so that is the window");
		strictEqual(details.contextWindowSource, "loaded");
		strictEqual(details.loadedContextWindow, LOADED_WINDOW);
		strictEqual(resolution.target.capabilities.contextWindow, LOADED_WINDOW);

		// Autocompact and the meter both read the same effective window. Against
		// the declared 262,144 an 80% trigger sits at 209,715, which a backend
		// that fails at 100,608 can never reach.
		const atEightyPercentOfDeclared = Math.round(MAX_WINDOW * 0.8);
		const verdict = shouldCompact(atEightyPercentOfDeclared, 0.8, details.effectiveContextWindow);
		ok(verdict.shouldCompact, "compaction must have fired long before the declared threshold");
		ok(shouldCompact(85_000, 0.8, details.effectiveContextWindow).shouldCompact);

		const ledger = buildContextLedger({
			provider: "dynamo",
			model: MODEL,
			contextWindow: details.effectiveContextWindow,
			contextWindowSource: details.contextWindowSource,
		});
		strictEqual(ledger.contextWindow, LOADED_WINDOW);
		strictEqual(ledger.contextWindowSource, "loaded", "/context states which window it is planning against");
	});

	it("falls back to the probed window, labelled as probed, when no loaded window is reported", () => {
		const resolution = resolveRuntimeTarget(providersFor(status({ discoveredModelStates: null })), {
			targetId: "dynamo",
			wireModelId: MODEL,
			use: "orchestrator",
		});

		ok(resolution.ok);
		strictEqual(resolution.target.contextWindowDetails.effectiveContextWindow, MAX_WINDOW);
		strictEqual(
			resolution.target.contextWindowDetails.contextWindowSource,
			"probe",
			"a catalog row is not a statement about what is loaded",
		);
		strictEqual(resolution.target.contextWindowDetails.loadedContextWindow, null);
	});

	it("never warns that a model discovery reports as loaded is not resident", () => {
		strictEqual(coldModelNotice(status(), "dynamo", MODEL), null);

		// A loaded window is itself the residency answer, even when the state
		// field disagrees with it.
		const contradictory = status({
			discoveredModelStates: { [MODEL]: { state: "unloaded", contextLength: LOADED_WINDOW } },
		});
		strictEqual(coldModelNotice(contradictory, "dynamo", MODEL), null);

		const cold = status({ discoveredModelStates: { [MODEL]: { state: "unloaded" } } });
		const notice = coldModelNotice(cold, "dynamo", MODEL);
		ok(notice?.message.includes("is not resident on dynamo"), "a genuinely absent model still announces the load");

		const loading = status({ discoveredModelStates: { [MODEL]: { state: "loading" } } });
		ok(coldModelNotice(loading, "dynamo", MODEL)?.message.includes("is still loading"));
	});

	it("folds LM Studio's duplicate model rows onto the resident copy", () => {
		// LM Studio lists one row per downloaded copy: two quantizations of the
		// same weights share a key, and only one of them is loaded. The unloaded
		// duplicate used to overwrite the resident one.
		const payload = {
			models: [
				{
					type: "llm",
					key: MODEL,
					loaded_instances: [{ id: MODEL, config: { context_length: LOADED_WINDOW } }],
					max_context_length: MAX_WINDOW,
					capabilities: { vision: true, trained_for_tool_use: true, reasoning: { default: "on" } },
				},
				{
					type: "llm",
					key: MODEL,
					loaded_instances: [],
					max_context_length: MAX_WINDOW,
					capabilities: { vision: true, trained_for_tool_use: true },
				},
			],
		};

		const result = probeResultFromV1Models(payload, target());

		strictEqual(result.ok, true);
		strictEqual(result.models?.length, 1, "one model id, however many copies are downloaded");
		strictEqual(result.modelStates?.[MODEL]?.state, "loaded");
		strictEqual(result.modelStates?.[MODEL]?.contextLength, LOADED_WINDOW);
		strictEqual(result.modelCapabilities?.[MODEL]?.contextWindow, LOADED_WINDOW);
		strictEqual(result.discoveredCapabilities?.contextWindow, LOADED_WINDOW);
		strictEqual(result.modelCapabilities?.[MODEL]?.reasoning, true, "the resident row's facts survive the fold");
	});

	it("reports an unloaded model at its max context and no loaded window", () => {
		const payload = {
			models: [{ type: "llm", key: MODEL, loaded_instances: [], max_context_length: MAX_WINDOW }],
		};

		const result = probeResultFromV1Models(payload, target());

		strictEqual(result.modelStates?.[MODEL]?.state, "unloaded");
		strictEqual(result.modelStates?.[MODEL]?.contextLength, undefined);
		strictEqual(result.modelCapabilities?.[MODEL]?.contextWindow, MAX_WINDOW);
	});
});
