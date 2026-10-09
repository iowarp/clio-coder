import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { listCatalogModelsForRuntime } from "../../src/domains/providers/catalog.js";

// `targets use` and fleet validation reject models missing from this catalog.
it("lists frontier models and preserves native Haiku 5.5 capabilities", () => {
	const ids = (runtime: string) => new Set(listCatalogModelsForRuntime(runtime).map((model) => model.id));
	const anthropic = ids("anthropic-max");
	const codex = ids("openai-codex");
	deepStrictEqual(
		{
			opus55: anthropic.has("claude-opus-5-5"),
			sol: codex.has("gpt-6-sol"),
			luna: codex.has("gpt-6-luna"),
		},
		{ opus55: true, sol: true, luna: true },
	);
	for (const runtime of ["anthropic", "anthropic-max"]) {
		const haiku = listCatalogModelsForRuntime(runtime).find((model) => model.id === "claude-haiku-5-5");
		ok(haiku);
		strictEqual(haiku.contextWindow, 1_000_000);
		strictEqual(haiku.maxTokens, 128_000);
		strictEqual(haiku.reasoning, true);
		deepStrictEqual(haiku.thinkingLevelMap, {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
		deepStrictEqual(haiku.compat, {
			supportsMidConvoEffort: true,
			supportsMidConvoSystemMessages: true,
			supportsMidConvoToolChanges: true,
			forceAdaptiveThinking: true,
			supportsTemperature: false,
			supportsStrictTools: true,
		});
	}
});
