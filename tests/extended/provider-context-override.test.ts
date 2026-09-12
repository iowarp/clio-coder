import { strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { withRunOverrides } from "../../src/core/run-overrides.js";
import { resolveContextWindowDetails } from "../../src/domains/providers/runtime-resolution.js";
import litellmRuntime from "../../src/domains/providers/runtimes/protocol/litellm.js";

it("uses an operator context limit instead of gateway training metadata", () => {
	const details = resolveContextWindowDetails(
		{ id: "mini", runtime: "litellm", capabilities: { contextWindow: 32_768 } },
		litellmRuntime,
		"mini/qwen3.8-27b-dense",
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
