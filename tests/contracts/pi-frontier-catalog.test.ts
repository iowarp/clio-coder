import { deepStrictEqual } from "node:assert/strict";
import { it } from "node:test";
import { listCatalogModelsForRuntime } from "../../src/domains/providers/catalog.js";

// Pi 0.87.1 added these models and the Claude Code client version that Opus 5.5
// requires. `targets use` and fleet validation read this catalog, so a model
// missing here is refused before any request is made.
it("lists the Pi 0.87.1 frontier models on the subscription runtimes", () => {
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
});
