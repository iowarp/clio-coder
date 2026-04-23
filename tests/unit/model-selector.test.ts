import { deepStrictEqual, ok } from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import { buildModelItems, modelsForEndpoint } from "../../src/interactive/overlays/model-selector.js";

describe("interactive/model-selector", () => {
	it("uses known runtime models for openai-codex when probes are empty", () => {
		const status = {
			endpoint: { id: "openai", runtime: "openai-codex", defaultModel: "gpt-5.4" },
			runtime: {
				id: "openai-codex",
				displayName: "OpenAI Codex",
				kind: "http",
				apiFamily: "openai-codex-responses",
				auth: "oauth",
				defaultCapabilities: EMPTY_CAPABILITIES,
				synthesizeModel: () => {
					throw new Error("unused");
				},
			},
			available: true,
			reason: "ready",
			health: { status: "unknown", lastCheckAt: null, lastError: null, latencyMs: null },
			capabilities: {
				...EMPTY_CAPABILITIES,
				chat: true,
				tools: true,
				reasoning: true,
				vision: true,
				contextWindow: 272000,
			},
			discoveredModels: [],
		} as const;

		const models = modelsForEndpoint(status);
		ok(models.includes("gpt-5.4"));
		ok(models.includes("gpt-5.4-mini"));
	});

	it("builds runtime-oriented labels and preserves endpoint/model refs", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.scope = ["openai/gpt-5.4-mini"];
		settings.orchestrator.endpoint = "openai";
		settings.orchestrator.model = "gpt-5.4";
		const providers: ProvidersContract = {
			list: () => [
				{
					endpoint: {
						id: "openai",
						runtime: "openai-codex",
						defaultModel: "gpt-5.4",
						wireModels: ["gpt-5.4", "gpt-5.4-mini"],
					},
					runtime: {
						id: "openai-codex",
						displayName: "OpenAI Codex",
						kind: "http",
						apiFamily: "openai-codex-responses",
						auth: "oauth",
						defaultCapabilities: EMPTY_CAPABILITIES,
						synthesizeModel: () => {
							throw new Error("unused");
						},
					},
					available: true,
					reason: "ready",
					health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: 100 },
					capabilities: {
						...EMPTY_CAPABILITIES,
						chat: true,
						tools: true,
						reasoning: true,
						vision: true,
						contextWindow: 272000,
					},
					discoveredModels: [],
				},
				{
					endpoint: { id: "local", runtime: "lmstudio-native", defaultModel: "qwq-local", wireModels: ["qwq-local"] },
					runtime: {
						id: "lmstudio-native",
						displayName: "LM Studio native API",
						kind: "http",
						apiFamily: "openai-responses",
						auth: "none",
						defaultCapabilities: EMPTY_CAPABILITIES,
						synthesizeModel: () => {
							throw new Error("unused");
						},
					},
					available: true,
					reason: "ready",
					health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: 10 },
					capabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: 8192 },
					discoveredModels: [],
				},
			],
			getEndpoint: () => null,
			getRuntime: () => null,
			probeAll: async () => undefined,
			probeAllLive: async () => undefined,
			probeEndpoint: async () => null,
			auth: {
				statusForTarget: (endpoint) => ({
					providerId: endpoint.runtime,
					available: endpoint.runtime === "openai-codex",
					credentialType: endpoint.runtime === "openai-codex" ? "oauth" : null,
					source: endpoint.runtime === "openai-codex" ? "stored-oauth" : "none",
					detail: endpoint.runtime,
				}),
				resolveForTarget: async () => {
					throw new Error("unused");
				},
				getStored: () => null,
				listStored: () => [],
				setApiKey: () => undefined,
				remove: () => undefined,
				login: async () => undefined,
				logout: () => undefined,
				getOAuthProviders: () => [],
			},
			credentials: {
				hasKey: () => false,
				get: () => null,
				set: () => undefined,
				remove: () => undefined,
			},
			knowledgeBase: null,
		};

		const result = buildModelItems({ settings, providers });
		deepStrictEqual(
			result.refs.map((ref) => `${ref.endpoint}/${ref.model}`),
			["openai/gpt-5.4", "openai/gpt-5.4-mini", "local/qwq-local"],
		);
		ok(result.items[0]?.label.includes("OpenAI Codex") ?? false);
		ok(result.items[1]?.label.includes("★") ?? false);
		ok(result.items[0]?.description?.includes("endpoint=openai") ?? false);
	});
});
