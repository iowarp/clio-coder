import { match, rejects, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { MiddlewareContract } from "../../src/domains/middleware/contract.js";
import type { PromptsContract } from "../../src/domains/prompts/contract.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { SchedulingContract } from "../../src/domains/scheduling/contract.js";
import { admitCompactionSummaryCall } from "../../src/domains/session/compaction/flow.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import type { AdmissionHold } from "../../src/domains/telemetry/call-scope.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import { createSideRequestAdmission } from "../../src/entry/side-request-admission.js";
import { createChatLoop } from "../../src/session-control/chat-loop.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

it("a compaction summary call is checked against the session cost ceiling whatever its route's pricing", async () => {
	let checked = 0;
	const scheduling = {
		admitPaidRequest: async (options: { onBlocked?: (block: never) => void; getCeilingUsd?: () => number }) => {
			checked += 1;
			strictEqual(options.getCeilingUsd?.(), 2);
			options.onBlocked?.({} as never);
		},
	} as unknown as SchedulingContract;
	const hold: AdmissionHold = {};
	await admitCompactionSummaryCall({ scheduling, headless: true, getCeilingUsd: () => 2 }, hold);
	strictEqual(checked, 1);
	strictEqual(hold.waitedOn, "budget");
});

it("side questions, System One and the safety judge are checked against the cost ceiling on an unpriced route", async () => {
	await isolateClioEnv("clio-coder-side-call-ceiling-");
	let checked = 0;
	const scheduling = {
		preflight: () => ({ currentUsd: 5, ceilingUsd: 5, verdict: "at" }),
		async admitPaidRequest() {
			checked += 1;
			throw new Error("session cost ceiling reached");
		},
	} as unknown as SchedulingContract;
	// No rates anywhere: the route projects nothing, but the session already spent its ceiling elsewhere.
	const target = { id: "unpriced", runtime: "fixture", url: "https://unpriced.invalid/v1", defaultModel: "chat" };
	const judge = createSideRequestAdmission({
		providers: { getTarget: () => target },
		scheduling,
		getCeilingUsd: () => 5,
		currentSession: () => null,
		repoIdentity: () => null,
		role: "safety-judge",
	});
	await rejects(judge({ targetId: "unpriced", model: "chat", signal: new AbortController().signal }), /ceiling/u);
	strictEqual(checked, 1);

	const faux = registerEngineFauxProvider({ api: "side-ceiling-fixture", models: [{ id: "chat" }], tokensPerSecond: 0 });
	faux.setResponses([
		{
			role: "assistant",
			content: [{ type: "text", text: "answered past the ceiling" }],
			api: faux.api,
			provider: "fixture",
			model: "chat",
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	]);
	const capabilities = { chat: true, tools: true, reasoning: false, contextWindow: 131072, maxTokens: 8192 };
	const runtime = {
		id: "fixture",
		displayName: "Fixture",
		kind: "http",
		tier: "cloud",
		apiFamily: "openai-completions",
		auth: "oauth",
		defaultCapabilities: capabilities,
		synthesizeModel: (_target: unknown, id: string) => faux.getModel(id),
	} as unknown as RuntimeDescriptor;
	const providers = {
		list: () => [
			{ target, runtime, available: true, capabilities, discoveredModels: ["chat"], discoveredModelsSource: "probe" },
		],
		getTarget: () => target,
		getRuntime: () => runtime,
		getDetectedReasoning: () => false,
		auth: {
			resolveForTarget: async () => ({
				providerId: "fixture",
				available: true,
				credentialType: "oauth",
				source: "stored-oauth",
				detail: "fixture",
				apiKey: "fixture-key",
			}),
		},
	} as unknown as ProvidersContract;
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.target = target.id;
	settings.chat.model = "chat";
	settings.chat.thinkingLevel = "off";
	settings.chat.prewarm = false;
	const loop = createChatLoop({
		getSettings: () => settings,
		providers,
		scheduling,
		session: { current: () => null } as unknown as SessionContract,
		readSessionEntries: () => [],
		middleware: {
			registerHook: () => {},
			runHook: () => ({ effects: [], ruleIds: [] }),
		} as unknown as MiddlewareContract,
		knownTargets: () => new Set([target.id]),
		createAgent: (options) => createEngineAgent(options),
		prompts: {
			inputEpoch: () => 0,
			compileSessionPrompt: async () => ({
				systemPrompt: "fixture prompt",
				systemPromptHash: "fixture",
				tokenEstimate: 1,
				sections: [],
				fragmentManifest: [],
			}),
		} as unknown as PromptsContract,
	});
	const outcome = await loop.askSideQuestion("why?");
	strictEqual(checked, 2, JSON.stringify(outcome));
	strictEqual(outcome.status === "answered", false);
	match("reason" in outcome ? outcome.reason : "", /ceiling/u);
});
