import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyThinkingMechanism,
	reasoningClassForMechanism,
	resolveModelRuntimeCapabilities,
	resolveModelRuntimeCapabilitiesForModel,
} from "../../src/domains/providers/model-runtime-capabilities.js";
import type { CapabilityFlags } from "../../src/domains/providers/types/capability-flags.js";
import { availableThinkingLevels, EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { LocalModelQuirks } from "../../src/domains/providers/types/local-model-quirks.js";
import { createEngineAi } from "../../src/engine/ai.js";
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

	it("uses cataloged Anthropic adaptive-thinking metadata for xhigh effort", () => {
		const opus = engineAi.getModel("anthropic", "claude-opus-4-7");
		ok(opus, "pi-ai catalog should include claude-opus-4-7");

		const resolved = resolveModelRuntimeCapabilitiesForModel(opus, "xhigh");

		strictEqual(resolved.capabilities.thinkingFormat, "anthropic-extended");
		deepStrictEqual(resolved.thinking.supportedLevels, ["off", "minimal", "low", "medium", "high", "xhigh"]);
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

	it("patches Anthropic adaptive payloads with the resolved effort field", () => {
		const opus = engineAi.getModel("anthropic", "claude-opus-4-7");
		ok(opus, "pi-ai catalog should include claude-opus-4-7");
		const payload = {
			model: opus.id,
			messages: [],
			max_tokens: 128000,
			stream: true,
			thinking: { type: "adaptive", display: "summarized" },
		};

		const patched = patchProviderThinkingPayload(payload, opus, "xhigh") as Record<string, unknown>;

		deepStrictEqual(patched.thinking, { type: "adaptive", display: "summarized" });
		deepStrictEqual(patched.output_config, { effort: "xhigh" });
	});

	it("patches Anthropic budget payloads with bounded token budgets", () => {
		const sonnet = engineAi.getModel("anthropic", "claude-sonnet-4-5-20250929");
		ok(sonnet, "pi-ai catalog should include claude-sonnet-4-5-20250929");
		const payload = {
			model: sonnet.id,
			messages: [],
			max_tokens: 8192,
			stream: true,
			thinking: { type: "enabled", budget_tokens: 1024, display: "summarized" },
		};

		const patched = patchProviderThinkingPayload(payload, sonnet, "high") as Record<string, unknown>;

		deepStrictEqual(patched.thinking, { type: "enabled", budget_tokens: 7168, display: "summarized" });
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
			tool_choice: { type: "function", function: { name: "dispatch" } },
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
});
