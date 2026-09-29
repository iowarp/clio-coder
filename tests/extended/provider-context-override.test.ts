import { strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { withRunOverrides } from "../../src/core/run-overrides.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import {
	refineRuntimeTargetWithModelHints,
	resolveContextWindowDetails,
	resolveRuntimeTarget,
	runtimeTargetSnapshot,
} from "../../src/domains/providers/runtime-resolution.js";
import litellmRuntime from "../../src/domains/providers/runtimes/protocol/litellm.js";

it("uses an operator context limit instead of gateway training metadata", () => {
	const details = resolveContextWindowDetails(
		{ id: "mini", runtime: "litellm", capabilities: { contextWindow: 32_768 } },
		litellmRuntime,
		"mini/qwen3.8-27b-dense-iq4nl",
		null,
		262_144,
		null,
		262_144,
		{ totalContextSize: 1_048_576, slots: 4 },
	);
	strictEqual(details.effectiveContextWindow, 32_768);
	strictEqual(details.contextWindowSource, "target-override");
	strictEqual(details.declaredContextWindow, 262_144);
	strictEqual(details.probedContextWindow, 262_144);
	strictEqual(details.contextWindowSlots, null);
});

it("caps a known loaded window without allowing configured capacity to inflate it", () => {
	for (const [configured, loaded, effective, source] of [
		[32_768, 131_072, 32_768, "target-override"],
		[131_072, 32_768, 32_768, "loaded"],
		[32_768, 32_768, 32_768, "loaded"],
	] as const) {
		const details = resolveContextWindowDetails(
			{ id: "local", runtime: "litellm", capabilities: { contextWindow: configured } },
			litellmRuntime,
			"local-model",
			null,
			262_144,
			loaded,
		);
		strictEqual(details.effectiveContextWindow, effective);
		strictEqual(details.contextWindowSource, source);
		strictEqual(details.loadedContextWindow, loaded);
	}
});

it("retains probe slot provenance without configuration and supports an explicit run override", async () => {
	const resolve = () =>
		resolveContextWindowDetails(
			{ id: "local", runtime: "litellm" },
			litellmRuntime,
			"local-model",
			null,
			32_768,
			null,
			262_144,
			{ totalContextSize: 131_072, slots: 4 },
		);
	const probed = resolve();
	strictEqual(probed.effectiveContextWindow, 32_768);
	strictEqual(probed.contextWindowSource, "probe");
	strictEqual(probed.contextWindowSlots?.slots, 4);
	await withRunOverrides({ maxContextTokens: 16_384 }, async () => {
		const overridden = resolve();
		strictEqual(overridden.effectiveContextWindow, 16_384);
		strictEqual(overridden.contextWindowSource, "target-override");
		strictEqual(overridden.contextWindowSlots, null);
	});
});

it("keeps a model maximum separate from an unknown serving window", () => {
	const details = resolveContextWindowDetails(
		{ id: "local", runtime: "litellm" },
		litellmRuntime,
		"local-model",
		null,
		null,
		null,
		262_144,
	);
	strictEqual(details.declaredContextWindow, 262_144);
	strictEqual(details.modelMaximum.kind, "model-maximum");
	strictEqual(details.servingLimit.value, null);
	strictEqual(details.servingLimit.kind, "unknown");
	strictEqual(details.effectiveContextWindow, 0);
	strictEqual(details.contextWindowSource, "unknown");
	strictEqual(details.warning, null);
});

it("does not promote descriptor defaults into resolved serving limits", () => {
	const target = { id: "local", runtime: "litellm", defaultModel: "local-model" };
	const providers = {
		getTarget: () => target,
		getRuntime: () => litellmRuntime,
		getDetectedReasoning: () => null,
		list: () => [],
		knowledgeBase: null,
	} as unknown as ProvidersContract;
	const result = resolveRuntimeTarget(providers, { targetId: target.id, wireModelId: target.defaultModel });
	strictEqual(result.ok, true);
	if (!result.ok) return;
	strictEqual(result.target.contextWindowDetails.servingLimit.value, null);
	strictEqual(result.target.capabilities.contextWindow, 0);
	strictEqual(result.target.maxOutputTokensField.value, null);
	strictEqual(result.target.capabilities.maxTokens, 0);
});

it("labels Pi cloud model limits without turning them into a serving window", () => {
	const target = { id: "cloud", runtime: "litellm", defaultModel: "cloud-model" };
	const providers = {
		getTarget: () => target,
		getRuntime: () => ({ ...litellmRuntime, tier: "cloud" }),
		getDetectedReasoning: () => null,
		list: () => [],
		knowledgeBase: null,
	} as unknown as ProvidersContract;
	const resolved = resolveRuntimeTarget(providers, { targetId: target.id, wireModelId: target.defaultModel });
	strictEqual(resolved.ok, true);
	if (!resolved.ok) return;
	const refined = refineRuntimeTargetWithModelHints(resolved.target, { contextWindow: 262_144, maxTokens: 8192 });
	const snapshot = runtimeTargetSnapshot(refined);
	strictEqual(snapshot.contextWindowField.value, null);
	strictEqual(snapshot.modelMaximumField.value, 262_144);
	strictEqual(snapshot.modelMaximumField.kind, "model-maximum");
	strictEqual(snapshot.maxOutputTokensField.value, 8192);
	strictEqual(snapshot.maxOutputTokensField.kind, "model-maximum");
	strictEqual(snapshot.maxOutputTokensField.source, "model-hint");
	strictEqual(snapshot.capabilities.maxTokens, 8192);
});
