import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyModelCapabilityPatch } from "../../src/domains/providers/model-capabilities.js";
import {
	resolveModelRuntimeCapabilities,
	resolveModelRuntimeCapabilitiesForModel,
} from "../../src/domains/providers/model-runtime-capabilities.js";
import litellm, {
	aggregateLiteLLMCapabilities,
	capabilitiesFromLiteLLMModelInfo,
} from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import { FileKnowledgeBase } from "../../src/domains/providers/types/knowledge-base.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import type { Model } from "../../src/engine/types.js";
import { startGatewayThinkingFixture } from "../harness/gateway-thinking-fixture.js";

const kb = new FileKnowledgeBase(fileURLToPath(new URL("../../src/domains/providers/models/", import.meta.url)));

test("gateway control runtime requires unanimous explicit deployment metadata", () => {
	const lm = capabilitiesFromLiteLLMModelInfo({ runtime: "lm-studio" });
	const llama = capabilitiesFromLiteLLMModelInfo({ runtime: "llama.cpp" });
	strictEqual(lm.thinkingControlRuntime, "lmstudio");
	strictEqual(llama.thinkingControlRuntime, "llamacpp");
	strictEqual(aggregateLiteLLMCapabilities([lm, lm]).thinkingControlRuntime, "lmstudio");
	for (const rows of [[lm, llama], [lm, {}], [{}], []])
		strictEqual(aggregateLiteLLMCapabilities(rows).thinkingControlRuntime, undefined);
	strictEqual(
		capabilitiesFromLiteLLMModelInfo({ runtime: "unknown", api_base: "http://lmstudio:1234" }).thinkingControlRuntime,
		undefined,
	);
});

test("Qwen3.8 offers vendor levels and preserves the released high alias without changing off", () => {
	const hit = kb.lookup("dynamo/qwen3.8-27b");
	ok(hit);
	for (const [level, expected] of [
		["off", "off"],
		["low", "low"],
		["medium", "medium"],
		["high", "xhigh"],
		["xhigh", "xhigh"],
		["max", "xhigh"],
	] as const) {
		const resolved = resolveModelRuntimeCapabilities({
			runtimeId: "litellm",
			modelId: "dynamo/qwen3.8-27b",
			capabilities: { ...EMPTY_CAPABILITIES, ...hit.entry.capabilities },
			kbHit: hit,
			configuredThinkingLevel: level,
		});
		deepStrictEqual(resolved.thinking.supportedLevels, ["off", "low", "medium", "xhigh"]);
		strictEqual(resolved.thinking.effectiveLevel, expected);
		strictEqual(resolved.request.reasoningEffort, expected === "off" ? undefined : expected);
	}
});

test("actual gateway probe to engine stream disables reasoning while retaining gateway ownership", async () => {
	const fixture = await startGatewayThinkingFixture();
	try {
		const target = { id: "gateway", runtime: "litellm", url: fixture.url, defaultModel: fixture.modelId };
		const probe = await litellm.probe?.(target, { credentialsPresent: new Set(), httpTimeoutMs: 1000 });
		ok(probe?.ok);
		// JSON round-trip reproduces the capability projection carried to workers.
		const caps = JSON.parse(JSON.stringify(probe.modelCapabilities?.[fixture.modelId]));
		const model = applyModelCapabilityPatch(
			litellm.synthesizeModel(target, fixture.modelId, kb.lookup(fixture.modelId)),
			caps,
		) as Model<"openai-completions">;
		for (const level of ["off", "low", "off"] as const) {
			const stream = openAICompletionsApiProvider.streamSimple(
				model,
				{ messages: [{ role: "user", content: "17 times 19", timestamp: 0 }] },
				{ apiKey: "fixture", ...(level === "off" ? {} : { reasoning: level }) },
			);
			const result = await stream.result();
			strictEqual(result.stopReason, "stop");
			strictEqual(
				result.content.some((part) => part.type === "thinking"),
				level !== "off",
			);
			const request = fixture.requests.at(-1);
			strictEqual(request?.reasoning_effort, level === "off" ? "none" : "low");
			deepStrictEqual(request?.allowed_openai_params, ["reasoning_effort"]);
			strictEqual(model.provider, "litellm");
			strictEqual(
				(model as unknown as { clioCoder: { runtimeId: string; gateway: boolean } }).clioCoder.runtimeId,
				"litellm",
			);
			strictEqual((model as unknown as { clioCoder: { gateway: boolean } }).clioCoder.gateway, true);
		}
		ok(
			fixture.paths.every((path) =>
				["/health/liveliness", "/v1/models", "/v1/model/info", "/v1/chat/completions"].includes(path),
			),
			fixture.paths.join(","),
		);
		// A later unresolved declaration must remove a prior route-specific hint.
		applyModelCapabilityPatch(model, { reasoning: true });
		strictEqual(resolveModelRuntimeCapabilitiesForModel(model, "off").request.reasoningEffort, undefined);
	} finally {
		await fixture.close();
	}
});

test("unknown gateway routes do not invent an effort-only protocol or suppress observed thinking", async () => {
	const fixture = await startGatewayThinkingFixture("unknown");
	try {
		const model = litellm.synthesizeModel(
			{ id: "unknown", runtime: "litellm", url: fixture.url },
			fixture.modelId,
			kb.lookup(fixture.modelId),
		) as Model<"openai-completions">;
		const result = await openAICompletionsApiProvider
			.streamSimple(model, { messages: [{ role: "user", content: "17 times 19", timestamp: 0 }] }, { apiKey: "fixture" })
			.result();
		ok(result.content.some((part) => part.type === "thinking"));
		strictEqual(fixture.requests[0]?.reasoning_effort, undefined);
		strictEqual(fixture.requests[0]?.allowed_openai_params, undefined);
	} finally {
		await fixture.close();
	}
});
