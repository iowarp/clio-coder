import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyThinkingMechanism,
	memoryInterventionModelMaxTokens,
	reasoningClassForMechanism,
	resolveModelRuntimeCapabilities,
	resolveModelRuntimeCapabilitiesForModel,
} from "../../src/domains/providers/model-runtime-capabilities.js";
import type { CapabilityFlags, ThinkingLevel } from "../../src/domains/providers/types/capability-flags.js";
import { availableThinkingLevels, EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { LocalModelQuirks } from "../../src/domains/providers/types/local-model-quirks.js";
import { createEngineAi } from "../../src/engine/ai.js";
import { engineStreamSimple as streamSimple } from "../../src/engine/api-registry.js";
import {
	patchProviderThinkingPayload,
	patchToolChoiceNamedPayload,
	patchToolChoiceNonePayload,
	patchWorkerRequestPayload,
} from "../../src/engine/provider-payload.js";

const engineAi = createEngineAi();

function anthropicCaps(maxTokens = 8192): CapabilityFlags {
	return {
		...EMPTY_CAPABILITIES,
		chat: true,
		tools: true,
		reasoning: true,
		thinkingFormat: "anthropic-extended",
		contextWindow: 200000,
		maxTokens,
	};
}

describe("contracts/thinking-runtime", () => {
	it("does not advertise xhigh for uncataloged Anthropic extended-thinking targets", () => {
		deepStrictEqual(availableThinkingLevels(anthropicCaps()), ["off", "minimal", "low", "medium", "high"]);

		const resolved = resolveModelRuntimeCapabilities({
			runtimeId: "anthropic",
			apiFamily: "anthropic-messages",
			modelId: "custom-claude",
			capabilities: anthropicCaps(8192),
			configuredThinkingLevel: "xhigh",
		});

		deepStrictEqual(resolved.thinking.supportedLevels, ["off", "minimal", "low", "medium", "high"]);
		strictEqual(resolved.thinking.effectiveLevel, "high");
		strictEqual(resolved.thinking.mechanism, "budget-tokens");
		strictEqual(resolved.thinking.budgetEnforcement, "enforced");
		strictEqual(resolved.request.budgetTokens, 7168);
	});

	it("uses cataloged Anthropic adaptive-thinking metadata for xhigh and max effort", () => {
		const opus = engineAi.getModel("anthropic", "claude-opus-4-7");
		ok(opus, "pi-ai catalog should include claude-opus-4-7");

		const resolved = resolveModelRuntimeCapabilitiesForModel(opus, "xhigh");

		strictEqual(resolved.capabilities.thinkingFormat, "anthropic-extended");
		deepStrictEqual(resolved.thinking.supportedLevels, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		strictEqual(resolved.thinking.effectiveLevel, "xhigh");
		strictEqual(resolved.thinking.mechanism, "effort-levels");
		strictEqual(resolved.request.reasoningEffort, "xhigh");
		strictEqual(resolved.request.budgetTokens, undefined);
	});

	it("coerces xhigh to high for Anthropic models without xhigh metadata", () => {
		const sonnet = engineAi.getModel("anthropic", "claude-sonnet-4-6");
		ok(sonnet, "pi-ai catalog should include claude-sonnet-4-6");

		const resolved = resolveModelRuntimeCapabilitiesForModel(sonnet, "xhigh");

		deepStrictEqual(resolved.thinking.supportedLevels, ["off", "minimal", "low", "medium", "high"]);
		strictEqual(resolved.thinking.effectiveLevel, "high");
		strictEqual(resolved.thinking.mechanism, "effort-levels");
		strictEqual(resolved.request.reasoningEffort, "high");
	});

	/**
	 * pi-ai's streamSimple owns Anthropic thinking assembly: adaptive effort
	 * comes from model.thinkingLevelMap and compat.forceAdaptiveThinking,
	 * budget models get a bounded budget_tokens. Clio no longer rewrites that
	 * payload, so the agent's thinking level reaches the wire exactly as pi
	 * maps it.
	 */
	async function anthropicWirePayload(modelId: string, reasoning: ThinkingLevel): Promise<Record<string, unknown>> {
		const model = engineAi.getModel("anthropic", modelId);
		ok(model, `pi-ai catalog should include ${modelId}`);
		let captured: Record<string, unknown> | undefined;
		const events = streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				apiKey: "sk-ant-test",
				...(reasoning === "off" ? {} : { reasoning }),
				onPayload: (payload) => {
					captured = payload as Record<string, unknown>;
					return undefined;
				},
				fetch: async () => new Response("", { status: 500 }),
			},
		);
		for await (const _event of events) {
			// Drain; the stubbed fetch fails the request after onPayload ran.
		}
		ok(captured, "pi must build the Anthropic payload before the request");
		return captured;
	}

	it("leaves pi's adaptive Anthropic payload untouched and pi sends the mapped effort", async () => {
		const payload = await anthropicWirePayload("claude-opus-4-7", "xhigh");
		deepStrictEqual(payload.thinking, { type: "adaptive", display: "summarized" });
		deepStrictEqual(payload.output_config, { effort: "xhigh" });
		const opus = engineAi.getModel("anthropic", "claude-opus-4-7");
		ok(opus);
		strictEqual(patchProviderThinkingPayload(payload, opus, "xhigh"), undefined);
	});

	it("leaves pi's budget Anthropic payload untouched and pi bounds budget_tokens", async () => {
		const payload = await anthropicWirePayload("claude-sonnet-4-5-20250929", "high");
		deepStrictEqual(payload.thinking, { type: "enabled", budget_tokens: 16384, display: "summarized" });
		const sonnet = engineAi.getModel("anthropic", "claude-sonnet-4-5-20250929");
		ok(sonnet);
		strictEqual(patchProviderThinkingPayload(payload, sonnet, "high"), undefined);
	});

	it("disables Anthropic thinking when the level is off", async () => {
		const payload = await anthropicWirePayload("claude-sonnet-4-5-20250929", "off");
		deepStrictEqual(payload.thinking, { type: "disabled" });
	});
});

describe("contracts/tool-choice lockout payload patch", () => {
	it("forces tool_choice none on an OpenAI-family payload that carries tools", () => {
		const model = { api: "openai-completions" } as Parameters<typeof patchToolChoiceNonePayload>[1];
		const patched = patchToolChoiceNonePayload({ model: "m", tools: [{ type: "function" }] }, model) as Record<
			string,
			unknown
		>;
		strictEqual(patched.tool_choice, "none");
		ok(Array.isArray(patched.tools), "tool schema bytes stay in the payload untouched");
	});

	it("uses the Anthropic tool_choice object shape", () => {
		const model = { api: "anthropic-messages" } as Parameters<typeof patchToolChoiceNonePayload>[1];
		const patched = patchToolChoiceNonePayload({ model: "m", tools: [{}] }, model) as Record<string, unknown>;
		deepStrictEqual(patched.tool_choice, { type: "none" });
	});

	it("leaves payloads without a tool surface alone", () => {
		const model = { api: "openai-completions" } as Parameters<typeof patchToolChoiceNonePayload>[1];
		strictEqual(patchToolChoiceNonePayload({ model: "m" }, model), undefined);
		strictEqual(patchToolChoiceNonePayload("not-a-record", model), undefined);
	});

	it("forces a named tool with provider-correct payload grammar", () => {
		const dispatchFunction = { type: "function", function: { name: "dispatch" } };
		const readFunction = { type: "function", function: { name: "read" } };
		const openai = { api: "openai-completions" } as Parameters<typeof patchToolChoiceNamedPayload>[1];
		deepStrictEqual(patchToolChoiceNamedPayload({ tools: [readFunction, dispatchFunction] }, openai, "dispatch"), {
			tools: [dispatchFunction],
			tool_choice: "required",
		});
		const responses = { api: "openai-responses" } as Parameters<typeof patchToolChoiceNamedPayload>[1];
		deepStrictEqual(patchToolChoiceNamedPayload({ tools: [readFunction, dispatchFunction] }, responses, "dispatch"), {
			tools: [dispatchFunction],
			tool_choice: { type: "function", name: "dispatch" },
		});
		const anthropic = { api: "anthropic-messages" } as Parameters<typeof patchToolChoiceNamedPayload>[1];
		deepStrictEqual(
			patchToolChoiceNamedPayload(
				{
					tools: [{ name: "read" }, { name: "dispatch" }],
					thinking: { type: "adaptive" },
					output_config: { effort: "high", format: "text" },
				},
				anthropic,
				"dispatch",
			),
			{
				tools: [{ name: "dispatch" }],
				output_config: { format: "text" },
				tool_choice: { type: "tool", name: "dispatch" },
			},
		);
		const google = { api: "google-generative-ai" } as Parameters<typeof patchToolChoiceNamedPayload>[1];
		deepStrictEqual(
			patchToolChoiceNamedPayload(
				{ config: { tools: [{ functionDeclarations: [{ name: "read" }, { name: "dispatch" }] }] } },
				google,
				"dispatch",
			),
			{
				config: {
					tools: [{ functionDeclarations: [{ name: "dispatch" }] }],
					toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["dispatch"] } },
				},
			},
		);
		const bedrock = { api: "bedrock-converse-stream" } as Parameters<typeof patchToolChoiceNamedPayload>[1];
		deepStrictEqual(
			patchToolChoiceNamedPayload(
				{ toolConfig: { tools: [{ toolSpec: { name: "read" } }, { toolSpec: { name: "dispatch" } }] } },
				bedrock,
				"dispatch",
			),
			{
				toolConfig: { tools: [{ toolSpec: { name: "dispatch" } }], toolChoice: { tool: { name: "dispatch" } } },
			},
		);
		const mistral = { api: "mistral-conversations" } as Parameters<typeof patchToolChoiceNamedPayload>[1];
		deepStrictEqual(patchToolChoiceNamedPayload({ tools: [readFunction, dispatchFunction] }, mistral, "dispatch"), {
			tools: [dispatchFunction],
			toolChoice: { type: "function", function: { name: "dispatch" } },
		});
	});

	it("never sends an object tool_choice on a generic openai-compatible payload", () => {
		// LM Studio and llama.cpp both answer HTTP 400 to the object form, so the
		// string spelling is the contract for every api family that lands on the
		// generic branch, not just openai-completions.
		const dispatchFunction = { type: "function", function: { name: "dispatch" } };
		const readFunction = { type: "function", function: { name: "read" } };
		for (const api of ["openai-completions", "ollama-native"] as const) {
			const model = { api } as Parameters<typeof patchToolChoiceNamedPayload>[1];
			const patched = patchToolChoiceNamedPayload(
				{ model: "qwen3.8-27b", tools: [readFunction, dispatchFunction] },
				model,
				"dispatch",
			) as Record<string, unknown>;
			strictEqual(patched.tool_choice, "required", `${api} must use the string tool_choice`);
			strictEqual(typeof patched.tool_choice, "string", `${api} must not send an object tool_choice`);
			deepStrictEqual(patched.tools, [dispatchFunction], `${api} narrows tools to the forced tool`);
		}
	});
});

describe("contracts/llama.cpp response-schema payload patch", () => {
	it("composes JSON schema, thinking, and tool lockout without dropping tools", () => {
		const model = { api: "openai-responses" } as Parameters<typeof patchWorkerRequestPayload>[1];
		const responseSchema = {
			type: "object",
			properties: { summary: { type: "string" } },
			required: ["summary"],
		};
		const tools = [{ type: "function", function: { name: "read", parameters: { type: "object" } } }];
		const patched = patchWorkerRequestPayload(
			{
				model: "scout-model",
				messages: [],
				reasoning: { effort: "high" },
				chat_template_kwargs: { enable_thinking: true },
				tools,
			},
			model,
			{
				runtimeId: "llamacpp",
				thinkingLevel: "high",
				responseSchema,
				toolChoiceNone: true,
			},
		) as Record<string, unknown>;

		deepStrictEqual(patched.reasoning, { effort: "high", summary: "detailed" });
		deepStrictEqual(patched.chat_template_kwargs, { enable_thinking: true });
		strictEqual(patched.tools, tools);
		strictEqual(patched.tool_choice, "none");
		deepStrictEqual(patched.response_format, { type: "json_object", schema: responseSchema });
	});

	it("removes the tool surface for a synthesis-locked worker round on OpenAI-family APIs", () => {
		const model = { api: "openai-completions" } as Parameters<typeof patchWorkerRequestPayload>[1];
		const tools = [{ type: "function", function: { name: "read", parameters: { type: "object" } } }];
		const patched = patchWorkerRequestPayload({ model: "coder-model", messages: [], tools, tool_choice: "auto" }, model, {
			runtimeId: "llamacpp",
			toolSurfaceLocked: true,
		}) as Record<string, unknown>;
		// llama.cpp keeps rendering tools under tool_choice none and returns
		// the model's markup as content, so the lock removes the surface itself.
		strictEqual("tools" in patched, false);
		strictEqual("tool_choice" in patched, false);
		strictEqual(patched.model, "coder-model");
	});

	it("keeps tool_choice none for a synthesis-locked Anthropic round because tool history needs tools", () => {
		const model = { api: "anthropic-messages" } as Parameters<typeof patchWorkerRequestPayload>[1];
		const tools = [{ name: "read", input_schema: { type: "object" } }];
		const patched = patchWorkerRequestPayload({ model: "m", messages: [], tools }, model, {
			runtimeId: "anthropic",
			toolSurfaceLocked: true,
		}) as Record<string, unknown>;
		strictEqual(patched.tools, tools);
		deepStrictEqual(patched.tool_choice, { type: "none" });
	});

	it("leaves a payload without tools alone under the surface lock", () => {
		const model = { api: "openai-completions" } as Parameters<typeof patchWorkerRequestPayload>[1];
		strictEqual(
			patchWorkerRequestPayload({ model: "m", messages: [] }, model, { runtimeId: "llamacpp", toolSurfaceLocked: true }),
			undefined,
		);
	});

	it("refuses to silently apply responseSchema to another runtime", () => {
		const model = { api: "openai-completions" } as Parameters<typeof patchWorkerRequestPayload>[1];
		throws(
			() =>
				patchWorkerRequestPayload({ model: "m" }, model, {
					runtimeId: "openai",
					responseSchema: { type: "object" },
				}),
			/responseSchema requires the native llamacpp runtime/,
		);
	});
});

describe("contracts/thinking-runtime local reasoning classes", () => {
	const qwenCaps: CapabilityFlags = {
		...EMPTY_CAPABILITIES,
		chat: true,
		tools: true,
		reasoning: true,
		thinkingFormat: "qwen-chat-template",
		contextWindow: 262144,
		maxTokens: 32768,
	};

	it("derives the reasoning class from the thinking mechanism", () => {
		strictEqual(reasoningClassForMechanism("none"), "never");
		strictEqual(reasoningClassForMechanism("always-on"), "always");
		strictEqual(reasoningClassForMechanism("on-off"), "switchable");
		strictEqual(reasoningClassForMechanism("effort-levels"), "switchable");
		strictEqual(reasoningClassForMechanism("budget-tokens"), "switchable");
		strictEqual(reasoningClassForMechanism(null), "switchable");
	});

	it("derives the memory completion budget from the resolved thinking mechanism", () => {
		strictEqual(memoryInterventionModelMaxTokens({ configuredMaxTokens: 2_000, thinkingMechanism: "none" }), 2_000);
		strictEqual(memoryInterventionModelMaxTokens({ configuredMaxTokens: 2_000, thinkingMechanism: "on-off" }), 2_000);
		strictEqual(memoryInterventionModelMaxTokens({ configuredMaxTokens: 2_000, thinkingMechanism: "always-on" }), 4_000);
		strictEqual(
			memoryInterventionModelMaxTokens({
				configuredMaxTokens: 2_000,
				thinkingMechanism: "always-on",
				modelMaxTokens: 3_000,
			}),
			3_000,
			"the model's known output cap remains authoritative",
		);
	});

	it("reasoning-class-never models emit no thinking payload at any dial", () => {
		const neverQuirks: LocalModelQuirks = { thinking: { mechanism: "none" } };
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"] as const) {
			const applied = applyThinkingMechanism(neverQuirks, level, qwenCaps);
			strictEqual(applied.thinkingActive, false, `${level} active`);
			strictEqual(applied.chatTemplateKwargs, undefined, `${level} kwargs`);
			strictEqual(applied.effort, undefined, `${level} effort`);
			strictEqual(applied.budgetTokens, undefined, `${level} budget`);
			if (level === "off") {
				strictEqual(applied.noticeKind, "applied");
			} else {
				strictEqual(applied.noticeKind, "unsupported");
				strictEqual(applied.notice, "model does not support thinking; level ignored");
			}
		}
	});

	it("reasoning-class-never models clamp the effective dial to off", () => {
		const resolved = resolveModelRuntimeCapabilities({
			runtimeId: "llamacpp",
			apiFamily: "openai-completions",
			modelId: "Qwopus3.6-35B-A3B-Coder-MTP-Q4_K_M-262K",
			capabilities: { ...qwenCaps, reasoning: false },
			quirks: { thinking: { mechanism: "none" } },
			configuredThinkingLevel: "low",
		});
		deepStrictEqual(resolved.thinking.supportedLevels, ["off"]);
		strictEqual(resolved.thinking.effectiveLevel, "off");
		strictEqual(resolved.thinking.mechanism, "none");
		strictEqual(resolved.request.chatTemplateKwargs, undefined);
		strictEqual(resolved.request.reasoningEffort, undefined);
		strictEqual(resolved.request.budgetTokens, undefined);
	});

	it("switchable qwen models put enable_thinking on the wire per dial", () => {
		const off = applyThinkingMechanism(undefined, "off", qwenCaps);
		deepStrictEqual(off.chatTemplateKwargs, { enable_thinking: false });
		strictEqual(off.thinkingActive, false);

		const low = applyThinkingMechanism(undefined, "low", qwenCaps);
		deepStrictEqual(low.chatTemplateKwargs, { enable_thinking: true });
		strictEqual(low.thinkingActive, true);
		strictEqual(low.noticeKind, "applied");

		const high = applyThinkingMechanism(undefined, "high", qwenCaps);
		deepStrictEqual(high.chatTemplateKwargs, { enable_thinking: true });
		strictEqual(high.noticeKind, "ignored-on-off");
		strictEqual(high.notice, "model has on/off thinking; level coerced to on");
	});

	it("always-on models report that off was ignored", () => {
		const alwaysQuirks: LocalModelQuirks = { thinking: { mechanism: "always-on" } };
		const applied = applyThinkingMechanism(alwaysQuirks, "off", qwenCaps);
		strictEqual(applied.thinkingActive, true);
		strictEqual(applied.noticeKind, "always-on");
		strictEqual(applied.notice, "model emits chain-of-thought unconditionally; off was ignored");
	});

	/**
	 * effort-levels used to drop the effort whenever the level was `off`, on the
	 * assumption that sending no field leaves a model silent. That holds only for
	 * models that reason on request. Measured on dynamo 2026-08-08,
	 * qwopus3.6-35b-a3b-coder-mtp spends 98 of 103 completion tokens reasoning on
	 * "what is 17+25" with no thinking field set, and reasoning_effort "none"
	 * takes it to 0. For such a family, omitting the field is a request to keep
	 * reasoning, so an explicitly mapped off-effort has to reach the wire.
	 */
	it("carries an explicitly mapped off-effort so a default-reasoning model can be silenced", () => {
		const quirks: LocalModelQuirks = {
			thinking: { mechanism: "effort-levels", effortByLevel: { off: "none", low: "low", high: "high" } },
		};

		const off = applyThinkingMechanism(quirks, "off", qwenCaps);
		strictEqual(off.mechanism, "effort-levels");
		strictEqual(off.effort, "none", "off must be expressible on the wire when a family maps it");
		strictEqual(off.thinkingActive, false);

		const high = applyThinkingMechanism(quirks, "high", qwenCaps);
		strictEqual(high.effort, "high");
		strictEqual(high.thinkingActive, true);
	});

	it("resolves the strict Qwen3.8 effort vocabulary for every Clio thinking level", () => {
		const quirks: LocalModelQuirks = {
			thinking: {
				mechanism: "effort-levels",
				effortByLevel: { low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh" },
			},
		};
		const cases: ReadonlyArray<{
			configured: ThinkingLevel;
			effective: ThinkingLevel;
			effort?: "low" | "medium" | "xhigh";
		}> = [
			{ configured: "off", effective: "off" },
			{ configured: "minimal", effective: "low", effort: "low" },
			{ configured: "low", effective: "low", effort: "low" },
			{ configured: "medium", effective: "medium", effort: "medium" },
			{ configured: "high", effective: "high", effort: "xhigh" },
			{ configured: "xhigh", effective: "xhigh", effort: "xhigh" },
			{ configured: "max", effective: "xhigh", effort: "xhigh" },
		];

		for (const expected of cases) {
			const resolved = resolveModelRuntimeCapabilities({
				runtimeId: "llamacpp",
				apiFamily: "openai-completions",
				modelId: "Qwen3.8-27B",
				capabilities: qwenCaps,
				quirks,
				configuredThinkingLevel: expected.configured,
			});

			deepStrictEqual(resolved.thinking.supportedLevels, ["off", "low", "medium", "high", "xhigh"]);
			strictEqual(resolved.thinking.effectiveLevel, expected.effective, `${expected.configured} effective level`);
			strictEqual(resolved.request.reasoningEffort, expected.effort, `${expected.configured} wire effort`);
			deepStrictEqual(
				resolved.request.chatTemplateKwargs,
				expected.configured === "off" ? { enable_thinking: false } : undefined,
				`${expected.configured} template toggle`,
			);
		}
	});

	it("keeps the applied effort empty for off when a family maps no off-effort", () => {
		const quirks: LocalModelQuirks = {
			thinking: { mechanism: "effort-levels", effortByLevel: { low: "low", high: "high" } },
		};

		const off = applyThinkingMechanism(quirks, "off", qwenCaps);
		strictEqual(off.effort, undefined, "off uses the template toggle instead of an invalid effort string");
		strictEqual(off.thinkingActive, false);
	});
});
