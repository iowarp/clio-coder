import { ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	PROVIDER_CATALOG,
	getModelSpec,
	getProviderSpec,
	isLocalEngineId,
} from "../../src/domains/providers/catalog.js";
import { match } from "../../src/domains/providers/matcher.js";
import {
	VALID_THINKING_LEVELS,
	getAvailableThinkingLevels,
	isValidThinkingLevel,
} from "../../src/domains/providers/resolver.js";

describe("providers/catalog", () => {
	it("catalog is non-empty", () => {
		ok(PROVIDER_CATALOG.length > 0);
	});

	it("every catalog entry has unique id", () => {
		const ids = new Set(PROVIDER_CATALOG.map((p) => p.id));
		strictEqual(ids.size, PROVIDER_CATALOG.length);
	});

	it("every remote sdk/cli provider has at least one static model", () => {
		// Local engines + openrouter discover models at runtime and ship with empty lists.
		for (const p of PROVIDER_CATALOG) {
			if (p.tier === "native") continue;
			if (p.id === "openrouter") continue;
			ok(p.models.length > 0, `provider ${p.id} has zero models`);
		}
	});

	it("isLocalEngineId recognises locals", () => {
		strictEqual(isLocalEngineId("ollama"), true);
		strictEqual(isLocalEngineId("lmstudio"), true);
		strictEqual(isLocalEngineId("anthropic"), false);
	});

	it("getProviderSpec throws on unknown id", () => {
		throws(() => getProviderSpec("nope" as never));
	});

	it("getModelSpec returns null for unknown model", () => {
		strictEqual(getModelSpec("anthropic", "nope"), null);
	});
});

describe("providers/matcher", () => {
	it("matches exact provider + model", () => {
		const provider = PROVIDER_CATALOG[0];
		if (!provider) throw new Error("no providers in catalog");
		const model = provider.models[0];
		if (!model) throw new Error("no models");
		const m = match({ requestedProviderId: provider.id, requestedModelId: model.id });
		strictEqual(m.providerId, provider.id);
		strictEqual(m.modelId, model.id);
		strictEqual(m.confidence, "exact");
	});

	it("throws when exact provider+model has no match", () => {
		throws(() => match({ requestedProviderId: "anthropic", requestedModelId: "nope" }));
	});

	it("resolves model-only to the first provider with that model", () => {
		const anthropic = PROVIDER_CATALOG.find((p) => p.id === "anthropic");
		if (!anthropic) throw new Error("anthropic not in catalog");
		const modelId = anthropic.models[0]?.id;
		if (!modelId) throw new Error("no anthropic model");
		const m = match({ requestedModelId: modelId });
		strictEqual(m.providerId, "anthropic");
		strictEqual(m.modelId, modelId);
	});
});

describe("providers/resolver/thinking", () => {
	it("VALID_THINKING_LEVELS contains off", () => {
		ok(VALID_THINKING_LEVELS.includes("off"));
	});

	it("isValidThinkingLevel matches the table", () => {
		for (const level of VALID_THINKING_LEVELS) {
			strictEqual(isValidThinkingLevel(level), true);
		}
		strictEqual(isValidThinkingLevel("extreme"), false);
	});

	it("getAvailableThinkingLevels without model is off only", () => {
		const levels = getAvailableThinkingLevels(undefined);
		strictEqual(levels.length, 1);
		strictEqual(levels[0], "off");
	});

	it("thinking-capable model without xhigh exposes levels minus xhigh", () => {
		const levels = getAvailableThinkingLevels({ id: "claude-sonnet-4-6", reasoning: true } as never);
		ok(levels.includes("off"));
		ok(levels.includes("high"));
		ok(!levels.includes("xhigh"));
	});

	it("opus-4-6 exposes xhigh level", () => {
		const levels = getAvailableThinkingLevels({ id: "claude-opus-4-6", reasoning: true } as never);
		ok(levels.includes("xhigh"));
	});
});
