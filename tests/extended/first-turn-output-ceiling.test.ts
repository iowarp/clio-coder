import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { PromptsContract } from "../../src/domains/prompts/contract.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { setGlobalDefaultMaxOutputTokens } from "../../src/engine/apis/output-budget.js";
import { type CreateChatLoopDeps, createChatLoop } from "../../src/session-control/chat-loop.js";

for (const api of ["openai-completions", "ollama-native"]) {
	for (const { oversizedInput, unknownWindow } of [
		{ oversizedInput: false, unknownWindow: false },
		{ oversizedInput: true, unknownWindow: false },
		{ oversizedInput: true, unknownWindow: true },
	]) {
		test(`${api}: a first turn ${unknownWindow ? "reaches the server with an unknown window" : oversizedInput ? "refuses oversized input explicitly" : "fits with a full-window output maximum"}`, async () => {
			const settings = structuredClone(DEFAULT_SETTINGS);
			settings.chat.target = "local";
			settings.chat.model = "local";
			settings.chat.maxOutputTokens = 131072;
			settings.chat.prewarm = false;
			setGlobalDefaultMaxOutputTokens(settings.chat.maxOutputTokens);
			const capabilities = {
				chat: true,
				tools: true,
				reasoning: false,
				vision: false,
				audio: false,
				embeddings: false,
				rerank: false,
				fim: false,
				contextWindow: 131072,
				maxTokens: 131072,
			};
			const target = {
				id: "local",
				runtime: "local",
				url: "https://fixture.invalid",
				defaultModel: "local",
				capabilities: unknownWindow ? { maxTokens: 131072 } : capabilities,
			};
			const model = {
				id: "local",
				name: "local",
				api,
				provider: "local",
				baseUrl: target.url,
				reasoning: false,
				input: ["text"],
				contextWindow: 131072,
				maxTokens: 131072,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			const runtime = {
				id: "local",
				displayName: "In-process fixture",
				kind: "http",
				// A hosted route with no window endpoint falls back to its declared window, so the
				// unknown-window case has to be a local route.
				tier: unknownWindow ? "local" : "cloud",
				apiFamily: api,
				auth: "none",
				defaultCapabilities: capabilities,
				synthesizeModel: () => structuredClone(model),
			};
			const providers = {
				getTarget: () => target,
				getRuntime: () => runtime,
				getDetectedReasoning: () => false,
				list: () => [
					{
						target,
						runtime,
						capabilities,
						available: true,
						discoveredModels: ["local"],
						discoveredModelsSource: "probe",
						probeCapabilities: null,
					},
				],
			} as unknown as ProvidersContract;
			const submitted: string[] = [];
			const refusals: string[] = [];
			let compactCalls = 0;
			const systemPrompt = "p".repeat(oversizedInput ? 131073 * 4 : 11889 * 4);
			const loop = createChatLoop({
				getSettings: () => settings,
				providers,
				knownTargets: () => new Set(["local"]),
				createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => {
					const handle = createEngineAgent(options);
					handle.agent.prompt = async (text: unknown) => {
						submitted.push(String(text));
					};
					return handle;
				}) as NonNullable<CreateChatLoopDeps["createAgent"]>,
				prompts: {
					inputEpoch: () => 0,
					compileSessionPrompt: async () => ({
						systemPrompt,
						systemPromptHash: "first-turn",
						tokenEstimate: systemPrompt.length / 4,
						sections: [],
						fragmentManifest: [],
					}),
				} as unknown as PromptsContract,
				autoCompact: async () => {
					compactCalls += 1;
					throw new Error("no current session to compact");
				},
			});
			loop.onEvent((event) => {
				if (event.type === "notice" && event.admission) refusals.push(event.admission.reason);
			});
			try {
				// No session is supplied: this is the operator's first "hi".
				await loop.submit("hi");
				strictEqual(settings.chat.maxOutputTokens, 131072);
				if (unknownWindow) strictEqual(loop.liveBudget().effectiveWindow, null);
				if (oversizedInput && !unknownWindow) {
					deepStrictEqual(submitted, []);
					ok(refusals.includes("context-window-exceeded"));
				} else {
					deepStrictEqual(submitted, ["hi"]);
					strictEqual(compactCalls, 0);
					deepStrictEqual(refusals, []);
				}
			} finally {
				loop.dispose();
				setGlobalDefaultMaxOutputTokens(0);
			}
		});
	}
}
