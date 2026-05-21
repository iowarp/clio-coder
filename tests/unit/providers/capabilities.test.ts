import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { mergeCapabilities } from "../../../src/domains/providers/capabilities.js";
import type { EndpointStatus, ProvidersContract, RuntimeDescriptor } from "../../../src/domains/providers/index.js";
import { resolveModelCapabilities } from "../../../src/domains/providers/model-capabilities.js";
import { resolveModelRuntimeCapabilities } from "../../../src/domains/providers/model-runtime-capabilities.js";
import { resolveRuntimeTarget, runtimeTargetSnapshot } from "../../../src/domains/providers/runtime-resolution.js";
import { BUILTIN_RUNTIMES } from "../../../src/domains/providers/runtimes/builtins.js";
import type { CapabilityFlags } from "../../../src/domains/providers/types/capability-flags.js";
import {
	availableThinkingLevels,
	EMPTY_CAPABILITIES,
	VALID_THINKING_LEVELS,
} from "../../../src/domains/providers/types/capability-flags.js";

function base(overrides: Partial<CapabilityFlags> = {}): CapabilityFlags {
	return { ...EMPTY_CAPABILITIES, chat: true, ...overrides };
}

describe("providers/capabilities mergeCapabilities", () => {
	it("precedence is userOverride > probe > kb > base", () => {
		const merged = mergeCapabilities(
			base({ contextWindow: 4096 }),
			{ contextWindow: 8192, tools: true },
			{ contextWindow: 16384, reasoning: true },
			{ contextWindow: 32768 },
		);
		strictEqual(merged.contextWindow, 32768);
		strictEqual(merged.tools, true);
		strictEqual(merged.reasoning, true);
		strictEqual(merged.chat, true);
	});

	it("ignores undefined keys so a layer can be partial without blanking prior layers", () => {
		const partialOverride: Partial<CapabilityFlags> = {};
		const merged = mergeCapabilities(base({ vision: false }), { vision: true }, null, partialOverride);
		strictEqual(merged.vision, true);
	});

	it("accepts null for any non-base layer (kb/probe/override optional)", () => {
		const merged = mergeCapabilities(base({ tools: false }), null, null, null);
		strictEqual(merged.tools, false);
		strictEqual(merged.chat, true);
	});

	it("probe overrides kb but not userOverride", () => {
		const merged = mergeCapabilities(
			base({ maxTokens: 1024 }),
			{ maxTokens: 2048 },
			{ maxTokens: 4096 },
			{ maxTokens: 512 },
		);
		strictEqual(merged.maxTokens, 512);
	});
});

describe("providers/capabilities EMPTY_CAPABILITIES", () => {
	it("is a valid CapabilityFlags base (every boolean false, numeric fields zero)", () => {
		strictEqual(EMPTY_CAPABILITIES.chat, false);
		strictEqual(EMPTY_CAPABILITIES.tools, false);
		strictEqual(EMPTY_CAPABILITIES.reasoning, false);
		strictEqual(EMPTY_CAPABILITIES.vision, false);
		strictEqual(EMPTY_CAPABILITIES.audio, false);
		strictEqual(EMPTY_CAPABILITIES.embeddings, false);
		strictEqual(EMPTY_CAPABILITIES.rerank, false);
		strictEqual(EMPTY_CAPABILITIES.fim, false);
		strictEqual(EMPTY_CAPABILITIES.contextWindow, 0);
		strictEqual(EMPTY_CAPABILITIES.maxTokens, 0);
	});

	it("does not carry the optional format fields so mergeCapabilities can layer them in", () => {
		const keys = Object.keys(EMPTY_CAPABILITIES);
		ok(!keys.includes("toolCallFormat"));
		ok(!keys.includes("thinkingFormat"));
		ok(!keys.includes("structuredOutputs"));
	});
});

describe("providers/capabilities availableThinkingLevels", () => {
	it("reasoning=false collapses the list to ['off']", () => {
		const levels = availableThinkingLevels(base({ reasoning: false }));
		deepStrictEqual(Array.from(levels), ["off"]);
	});

	it("anthropic-extended includes 'xhigh' at the tail", () => {
		const levels = availableThinkingLevels(base({ reasoning: true, thinkingFormat: "anthropic-extended" }));
		deepStrictEqual(Array.from(levels), [...VALID_THINKING_LEVELS]);
		ok(levels.includes("xhigh"));
	});

	it("known anthropic catalog models use pi-ai thinkingLevelMap", () => {
		const sonnet = availableThinkingLevels(base({ reasoning: true, thinkingFormat: "anthropic-extended" }), {
			runtimeId: "anthropic",
			modelId: "claude-sonnet-4-6",
		});
		ok(sonnet.includes("high"));
		ok(!sonnet.includes("xhigh"));

		const opus = availableThinkingLevels(base({ reasoning: true, thinkingFormat: "anthropic-extended" }), {
			runtimeId: "anthropic",
			modelId: "claude-opus-4-6",
		});
		deepStrictEqual(Array.from(opus), [...VALID_THINKING_LEVELS]);
	});

	it("openai-codex gpt-5.4 follows the SDK thinking-level map", () => {
		const levels = availableThinkingLevels(base({ reasoning: true, thinkingFormat: "openai-codex" }), {
			runtimeId: "openai-codex",
			modelId: "gpt-5.4",
		});
		deepStrictEqual(Array.from(levels), ["off", "minimal", "low", "medium", "high", "xhigh"]);
	});

	it("openai-codex gpt-5.5 follows the SDK thinking-level map", () => {
		const levels = availableThinkingLevels(base({ reasoning: true, thinkingFormat: "openai-codex" }), {
			runtimeId: "openai-codex",
			modelId: "gpt-5.5",
		});
		deepStrictEqual(Array.from(levels), ["off", "minimal", "low", "medium", "high", "xhigh"]);
	});

	it("openai-codex gpt-5.1-codex-mini follows the SDK thinking-level map", () => {
		const levels = availableThinkingLevels(base({ reasoning: true, thinkingFormat: "openai-codex" }), {
			runtimeId: "openai-codex",
			modelId: "gpt-5.1-codex-mini",
		});
		deepStrictEqual(Array.from(levels), ["off", "minimal", "low", "medium", "high"]);
	});

	it("non-anthropic thinking format omits 'xhigh'", () => {
		const levels = availableThinkingLevels(base({ reasoning: true, thinkingFormat: "qwen-chat-template" }));
		ok(levels.includes("high"));
		ok(!levels.includes("xhigh"));
	});

	it("harmony exposes only GPT-OSS reasoning effort levels", () => {
		const byFormat = availableThinkingLevels(base({ reasoning: true, thinkingFormat: "harmony" }));
		deepStrictEqual(Array.from(byFormat), ["low", "medium", "high"]);

		const byModel = availableThinkingLevels(base({ reasoning: true }), {
			runtimeId: "llamacpp",
			modelId: "openai/gpt-oss-20b",
		});
		deepStrictEqual(Array.from(byModel), ["low", "medium", "high"]);
	});

	it("VALID_THINKING_LEVELS is a 6-element readonly tuple", () => {
		strictEqual(VALID_THINKING_LEVELS.length, 6);
		deepStrictEqual(Array.from(VALID_THINKING_LEVELS), ["off", "minimal", "low", "medium", "high", "xhigh"]);
	});
});

describe("providers/model-runtime-capabilities", () => {
	it("resolves GPT-OSS Harmony as low/medium/high with Harmony request and response handling", () => {
		const resolved = resolveModelRuntimeCapabilities({
			targetId: "dynamo",
			runtimeId: "llamacpp",
			apiFamily: "openai-completions",
			modelId: "openai/gpt-oss-20b",
			capabilities: base({ reasoning: true }),
			configuredThinkingLevel: "off",
		});

		strictEqual(resolved.family, "openai-gpt-oss");
		deepStrictEqual(Array.from(resolved.thinking.supportedLevels), ["low", "medium", "high"]);
		strictEqual(resolved.thinking.effectiveLevel, "low");
		strictEqual(resolved.thinking.display, "low");
		strictEqual(resolved.request.reasoningEffort, "low");
		deepStrictEqual(resolved.request.chatTemplateKwargs, { reasoning_effort: "low" });
		strictEqual(resolved.response.parser, "harmony");
	});

	it("resolves on/off local models without surfacing fake effort levels", () => {
		const resolved = resolveModelRuntimeCapabilities({
			targetId: "dynamo",
			runtimeId: "lmstudio-native",
			apiFamily: "lmstudio-native",
			modelId: "nemotron-cascade-2-30b-a3b-i1",
			capabilities: base({ reasoning: true, thinkingFormat: "qwen-chat-template" }),
			quirks: { thinking: { mechanism: "on-off" } },
			configuredThinkingLevel: "high",
		});

		deepStrictEqual(Array.from(resolved.thinking.supportedLevels), ["off", "low"]);
		strictEqual(resolved.thinking.effectiveLevel, "low");
		strictEqual(resolved.thinking.display, "on");
		deepStrictEqual(resolved.request.chatTemplateKwargs, { enable_thinking: true });
		ok(resolved.thinking.notice.includes("high was coerced to on"));
	});

	it("marks budget-token levels as advisory when the target cannot enforce them", () => {
		const resolved = resolveModelRuntimeCapabilities({
			targetId: "mini",
			runtimeId: "llamacpp",
			apiFamily: "openai-completions",
			modelId: "qwen3.6-coder-local",
			capabilities: base({ reasoning: true, thinkingFormat: "qwen-chat-template" }),
			quirks: { thinking: { mechanism: "budget-tokens", budgetByLevel: { low: 1024, medium: 4096, high: 8192 } } },
			configuredThinkingLevel: "medium",
		});

		deepStrictEqual(Array.from(resolved.thinking.supportedLevels), ["off", "low", "medium", "high"]);
		strictEqual(resolved.thinking.effectiveLevel, "medium");
		strictEqual(resolved.thinking.display, "medium");
		strictEqual(resolved.request.budgetTokens, 4096);
		strictEqual(resolved.request.budgetEnforcement, "informational");
		ok(resolved.thinking.notice.includes("advisory"));
	});
});

describe("providers/runtime-resolution", () => {
	function plainRuntime(overrides: Partial<RuntimeDescriptor> = {}): RuntimeDescriptor {
		return {
			id: "plain-http",
			displayName: "Plain HTTP",
			kind: "http",
			apiFamily: "openai-completions",
			auth: "none",
			defaultCapabilities: base({ tools: true, reasoning: false }),
			synthesizeModel: () => ({ id: "plain", provider: "openai" }) as never,
			...overrides,
		};
	}

	function providersFor(runtime: RuntimeDescriptor, status?: EndpointStatus): ProvidersContract {
		const endpoint = status?.endpoint ?? {
			id: "mini",
			runtime: runtime.id,
			defaultModel: "nemotron-cascade-2-30b-a3b-i1",
		};
		return {
			list: () => (status ? [status] : []),
			getEndpoint: (id) => (id === endpoint.id ? endpoint : null),
			getRuntime: (id) => (id === runtime.id ? runtime : null),
			probeAll: async () => {},
			probeAllLive: async () => {},
			probeEndpoint: async () => status ?? null,
			disconnectEndpoint: () => status ?? null,
			getDetectedReasoning: () => null,
			probeReasoningForModel: async () => null,
			auth: {
				statusForTarget: () => ({
					providerId: runtime.id,
					available: true,
					credentialType: null,
					source: "none",
					detail: null,
				}),
				resolveForTarget: async () => ({
					providerId: runtime.id,
					available: true,
					credentialType: null,
					source: "none",
					detail: null,
				}),
				getStored: () => null,
				listStored: () => [],
				setApiKey: () => {},
				remove: () => {},
				login: async () => {},
				logout: () => {},
				getOAuthProviders: () => [],
				setRuntimeOverrideForTarget: () => {},
				clearRuntimeOverrideForTarget: () => {},
			},
			credentials: { hasKey: () => false, get: () => null, set: () => {}, remove: () => {} },
			knowledgeBase: null,
		};
	}

	it("reports missing target, runtime, and model configuration before model resolution", () => {
		const runtime = plainRuntime();

		const unconfiguredTarget = resolveRuntimeTarget(providersFor(runtime), {
			endpointId: "",
			wireModelId: "plain",
		});
		strictEqual(unconfiguredTarget.ok, false);
		strictEqual(unconfiguredTarget.diagnostics[0]?.code, "target-not-configured");

		const missingTarget = resolveRuntimeTarget(providersFor(runtime), {
			endpointId: "missing",
			wireModelId: "plain",
		});
		strictEqual(missingTarget.ok, false);
		strictEqual(missingTarget.diagnostics[0]?.code, "target-not-found");

		const missingRuntimeProviders: ProvidersContract = { ...providersFor(runtime), getRuntime: () => null };
		const missingRuntime = resolveRuntimeTarget(missingRuntimeProviders, {
			endpointId: "mini",
			wireModelId: "plain",
		});
		strictEqual(missingRuntime.ok, false);
		strictEqual(missingRuntime.diagnostics[0]?.code, "runtime-not-registered");

		const missingModelProviders: ProvidersContract = {
			...providersFor(runtime),
			getEndpoint: (id) => (id === "mini" ? { id: "mini", runtime: runtime.id } : null),
		};
		const missingModel = resolveRuntimeTarget(missingModelProviders, { endpointId: "mini" });
		strictEqual(missingModel.ok, false);
		strictEqual(missingModel.diagnostics[0]?.code, "model-not-configured");
	});

	it("blocks subprocess runtimes for orchestrator and print surfaces", () => {
		const runtime = plainRuntime({
			id: "claude-code-cli",
			displayName: "Claude Code CLI",
			kind: "subprocess",
			apiFamily: "subprocess-claude-code",
			auth: "cli",
		});

		const orchestrator = resolveRuntimeTarget(providersFor(runtime), {
			endpointId: "mini",
			wireModelId: "claude-sonnet-4-6",
			use: "orchestrator",
		});
		const print = resolveRuntimeTarget(providersFor(runtime), {
			endpointId: "mini",
			wireModelId: "claude-sonnet-4-6",
			use: "print",
		});

		strictEqual(orchestrator.ok, false);
		strictEqual(orchestrator.diagnostics[0]?.code, "subprocess-orchestrator-unsupported");
		strictEqual(print.ok, false);
		strictEqual(print.diagnostics[0]?.code, "subprocess-orchestrator-unsupported");
	});

	it("keeps tools and output-budget incompatibilities as non-fatal diagnostics", () => {
		const runtime = plainRuntime({ defaultCapabilities: base({ tools: false, maxTokens: 0 }) });

		const resolved = resolveRuntimeTarget(providersFor(runtime), {
			endpointId: "mini",
			wireModelId: "plain",
			requireTools: true,
			requireOutputBudget: true,
			use: "orchestrator",
		});

		ok(resolved.ok);
		ok(resolved.diagnostics.some((entry) => entry.code === "tools-unsupported"));
		ok(resolved.diagnostics.some((entry) => entry.code === "output-budget-unknown"));
	});

	it("keeps requested and effective thinking decisions in one descriptor", () => {
		const runtime: RuntimeDescriptor = {
			id: "lmstudio-native",
			displayName: "LM Studio",
			kind: "http",
			apiFamily: "lmstudio-native",
			auth: "none",
			defaultCapabilities: base({ reasoning: true, thinkingFormat: "qwen-chat-template", tools: true }),
			synthesizeModel: () => ({ id: "nemotron-cascade-2-30b-a3b-i1", provider: "lmstudio" }) as never,
		};

		const resolved = resolveRuntimeTarget(providersFor(runtime), {
			endpointId: "mini",
			wireModelId: "nemotron-cascade-2-30b-a3b-i1",
			requestedThinkingLevel: "high",
			use: "orchestrator",
			requireTools: true,
		});

		ok(resolved.ok);
		strictEqual(resolved.target.requestedThinkingLevel, "high");
		strictEqual(resolved.target.effectiveThinkingLevel, "low");
		strictEqual(resolved.target.modelRuntime.thinking.display, "on");
		ok(resolved.target.diagnostics.some((entry) => entry.code === "thinking-coerced"));

		const snapshot = runtimeTargetSnapshot(resolved.target);
		strictEqual(snapshot.targetId, "mini");
		strictEqual(snapshot.runtimeId, "lmstudio-native");
		strictEqual(snapshot.requestedThinkingLevel, "high");
		strictEqual(snapshot.effectiveThinkingLevel, "low");
		strictEqual(snapshot.thinking.display, "on");
	});

	it("rejects required capabilities before dispatch can spawn", () => {
		const runtime = plainRuntime({ defaultCapabilities: base({ tools: false, reasoning: false }) });

		const resolved = resolveRuntimeTarget(providersFor(runtime), {
			endpointId: "mini",
			wireModelId: "plain",
			requiredCapabilities: ["tools"],
			use: "dispatch",
		});

		strictEqual(resolved.ok, false);
		ok(resolved.diagnostics.some((entry) => entry.code === "required-capability-missing"));
	});
});

describe("providers/model-capabilities catalog alignment", () => {
	it("uses pi-ai catalog windows and reasoning for known cloud models", () => {
		const runtime = BUILTIN_RUNTIMES.find((entry) => entry.id === "openrouter");
		ok(runtime, "missing openrouter runtime");

		const caps = resolveModelCapabilities(
			{
				endpoint: { id: "or", runtime: "openrouter", defaultModel: "openai/gpt-5.4" },
				runtime,
				capabilities: base({ reasoning: false, contextWindow: 128000, maxTokens: 8192 }),
				probeCapabilities: null,
				probeModelId: null,
			},
			"openai/gpt-5.4",
			null,
		);

		strictEqual(caps.reasoning, true);
		strictEqual(caps.vision, true);
		strictEqual(caps.contextWindow, 1050000);
		strictEqual(caps.maxTokens, 128000);
	});

	it("does not apply probe-only capabilities to a different selected wire model", () => {
		const runtime = BUILTIN_RUNTIMES.find((entry) => entry.id === "llamacpp");
		ok(runtime, "missing llamacpp runtime");

		const caps = resolveModelCapabilities(
			{
				endpoint: { id: "mini", runtime: "llamacpp", defaultModel: "small-model" },
				runtime,
				capabilities: base({ reasoning: false, contextWindow: 8192, maxTokens: 4096 }),
				probeCapabilities: { reasoning: true, contextWindow: 262144, maxTokens: 32768 },
				probeModelId: "small-model",
			},
			"large-model",
			null,
		);

		strictEqual(caps.reasoning, false);
		strictEqual(caps.contextWindow, runtime.defaultCapabilities.contextWindow);
		strictEqual(caps.maxTokens, runtime.defaultCapabilities.maxTokens);
	});

	it("applies unkeyed probe-only capabilities only to the endpoint default model", () => {
		const runtime = BUILTIN_RUNTIMES.find((entry) => entry.id === "llamacpp");
		ok(runtime, "missing llamacpp runtime");
		const status = {
			endpoint: { id: "mini", runtime: "llamacpp", defaultModel: "loaded-model" },
			runtime,
			capabilities: base({ reasoning: false, contextWindow: 8192, maxTokens: 4096 }),
			probeCapabilities: { reasoning: true, contextWindow: 262144, maxTokens: 32768 },
			probeModelId: null,
		};

		const defaultCaps = resolveModelCapabilities(status, "loaded-model", null);
		const otherCaps = resolveModelCapabilities(status, "other-model", null);

		strictEqual(defaultCaps.reasoning, true);
		strictEqual(defaultCaps.contextWindow, 262144);
		strictEqual(otherCaps.reasoning, false);
		strictEqual(otherCaps.contextWindow, runtime.defaultCapabilities.contextWindow);
	});

	it("treats detected reasoning=false as authoritative for the selected wire model", () => {
		const runtime = BUILTIN_RUNTIMES.find((entry) => entry.id === "llamacpp");
		ok(runtime, "missing llamacpp runtime");

		const caps = resolveModelCapabilities(
			{
				endpoint: { id: "mini", runtime: "llamacpp", defaultModel: "reasoning-model" },
				runtime,
				capabilities: base({ reasoning: true, contextWindow: 8192, maxTokens: 4096 }),
				probeCapabilities: null,
				probeModelId: null,
			},
			"reasoning-model",
			null,
			{ detectedReasoning: false },
		);

		strictEqual(caps.reasoning, false);
	});
});
