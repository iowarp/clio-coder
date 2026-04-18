import { ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	PROVIDER_CATALOG,
	getModelSpec,
	getProviderSpec,
	isLocalEngineId,
} from "../../src/domains/providers/catalog.js";
import {
	ContextOverflowError,
	isContextOverflowError,
	toContextOverflowError,
} from "../../src/domains/providers/errors.js";
import { match } from "../../src/domains/providers/matcher.js";
import {
	VALID_THINKING_LEVELS,
	getAvailableThinkingLevels,
	isValidThinkingLevel,
} from "../../src/domains/providers/resolver.js";
import {
	getLocalRegisteredModel,
	registerLocalProviders,
	resolveLocalModelId,
} from "../../src/engine/local-model-registry.js";

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

describe("engine/local-model-registry/resolveLocalModelId", () => {
	it("composes modelId@endpoint for local engines with an endpoint", () => {
		strictEqual(resolveLocalModelId("llamacpp", "Qwen", "mini"), "Qwen@mini");
	});

	it("leaves cloud provider modelIds unchanged even when endpoint is provided", () => {
		strictEqual(resolveLocalModelId("anthropic", "claude-4", "mini"), "claude-4");
	});

	it("returns bare modelId when endpoint is undefined", () => {
		strictEqual(resolveLocalModelId("llamacpp", "Qwen", undefined), "Qwen");
	});

	it("resolves the registered Model via the composed lookup id", () => {
		registerLocalProviders({
			llamacpp: {
				endpoints: {
					mini: { default_model: "Q", url: "http://x" },
				},
			},
		});
		const lookupId = resolveLocalModelId("llamacpp", "Q", "mini");
		strictEqual(lookupId, "Q@mini");
		const model = getLocalRegisteredModel("llamacpp", lookupId);
		ok(model, "expected registered Model for llamacpp/Q@mini");
	});
});

// ---------------------------------------------------------------------------
// providers/errors — ContextOverflowError discriminator (slice 12d)
// ---------------------------------------------------------------------------

describe("providers/errors ContextOverflowError", () => {
	it("carries the literal kind discriminator for structural guards", () => {
		const err = new ContextOverflowError("too big");
		strictEqual(err.kind, "context-overflow");
		ok(isContextOverflowError(err));
	});

	it("isContextOverflowError matches plain objects carrying the kind tag", () => {
		ok(isContextOverflowError({ kind: "context-overflow", message: "ok" }));
		strictEqual(isContextOverflowError({ kind: "other" }), false);
		strictEqual(isContextOverflowError(null), false);
		strictEqual(isContextOverflowError("string error"), false);
	});
});

describe("providers/errors toContextOverflowError heuristic", () => {
	it("matches OpenAI context_length_exceeded variants", () => {
		const cases = [
			"This model's maximum context length is 128000 tokens.",
			"Error: context_length_exceeded — messages exceed context length",
			"context length exceeded, 200000 tokens requested",
		];
		for (const message of cases) {
			const wrapped = toContextOverflowError(new Error(message));
			ok(wrapped, `expected match for: ${message}`);
			strictEqual(wrapped.message, message);
		}
	});

	it("matches Anthropic prompt-is-too-long phrasing", () => {
		const wrapped = toContextOverflowError(new Error("prompt is too long: 205000 tokens > 200000"));
		ok(wrapped);
		strictEqual(wrapped.kind, "context-overflow");
	});

	it("matches llama.cpp and Groq context-window variants", () => {
		ok(toContextOverflowError(new Error("the context window was exceeded (65536 > 32768)")));
		ok(toContextOverflowError(new Error("tokens exceed the context_window of this model")));
	});

	it("matches request-too-large phrasing", () => {
		ok(toContextOverflowError(new Error("request is too large, reduce prompt size")));
		ok(toContextOverflowError(new Error("Request too large: 500000 bytes")));
	});

	it("returns null for unrelated errors so callers surface the original", () => {
		strictEqual(toContextOverflowError(new Error("rate limit exceeded")), null);
		strictEqual(toContextOverflowError(new Error("401 unauthorized")), null);
		strictEqual(toContextOverflowError(null), null);
		strictEqual(toContextOverflowError(undefined), null);
	});

	it("handles string and plain-object error shapes", () => {
		ok(toContextOverflowError("maximum context length is 8192 tokens"));
		ok(toContextOverflowError({ message: "prompt is too long" }));
		strictEqual(toContextOverflowError({ message: 123 }), null);
	});

	it("passes through an already-typed ContextOverflowError", () => {
		const original = new ContextOverflowError("prior");
		const round = toContextOverflowError(original);
		strictEqual(round, original);
	});
});
