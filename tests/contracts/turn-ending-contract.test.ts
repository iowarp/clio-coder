import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { MiddlewareContract } from "../../src/domains/middleware/contract.js";
import { createPlanCloseRegistration } from "../../src/domains/middleware/plan-close.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { compile } from "../../src/domains/prompts/compiler.js";
import type { PromptsContract } from "../../src/domains/prompts/contract.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import { createChatLoop } from "../../src/interactive/chat-loop.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("turn-ending contract in the session prompt", () => {
	const systemPrompt = (inputs: { headless?: boolean; operatorInterviews?: boolean }) =>
		compile(loadFragments(), {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.default",
			sessionInputs: {
				coordinatorCapabilities: [ToolNames.AskUser, ToolNames.Read],
				provider: "local",
				model: "stable-model",
				providerSupportsTools: true,
				toolNames: [ToolNames.AskUser, ToolNames.Read],
				...inputs,
			},
		}).systemPrompt;
	const identityHalf = "She ends a turn in one of two states.";

	it("teaches both states and the ask_user endings where an operator can answer", () => {
		const prompt = systemPrompt({ operatorInterviews: true });
		ok(prompt.includes("## Ending a turn"), prompt);
		ok(prompt.includes("Every turn ends in one of two states:"), prompt);
		ok(
			prompt.includes('A requested plan always ends with ask_user "Carry out this plan?", even with no question.'),
			prompt,
		);
		ok(prompt.includes("options carrying open choices: [Proceed with a per-user file (Recommended)"), prompt);
		ok(prompt.includes(identityHalf), prompt);
	});

	it("keeps only the no-offer half in headless and ACP prompts", () => {
		for (const inputs of [{ headless: true, operatorInterviews: true }, {}]) {
			const prompt = systemPrompt(inputs);
			ok(!prompt.includes("## Ending a turn"), prompt);
			ok(!prompt.includes('ask_user "'), prompt);
			ok(prompt.includes(identityHalf), prompt);
			ok(prompt.includes("stops\nthere, without a question"), prompt);
		}
	});
});

it("continues only an armed plan that has not asked or changed files, once", () => {
	let plan = false;
	let canAsk = true;
	const rule = createPlanCloseRegistration({ canAsk: () => canAsk, isPlan: () => plan });
	const start = (metadata: MiddlewareHookInput["metadata"] = {}) => rule.evaluate({ hook: "turn_start", metadata });
	const end = (stopReason = "stop") => rule.evaluate({ hook: "turn_end", metadata: { stopReason } });
	start();
	deepStrictEqual(end(), []);
	plan = true;
	start();
	const effects = end();
	strictEqual(effects.length, 1);
	strictEqual(effects[0]?.kind, "request_continuation");
	ok(effects[0]?.kind === "request_continuation" && effects[0].message.includes('ask_user "Carry out this plan?"'));
	deepStrictEqual(end(), []);
	start({ requestContinuation: true });
	deepStrictEqual(end(), []);
	for (const toolName of [ToolNames.AskUser, ToolNames.Edit, ToolNames.Write]) {
		start();
		rule.evaluate({ hook: "after_tool", toolName });
		deepStrictEqual(end(), []);
	}
	start();
	rule.evaluate({ hook: "after_tool", toolName: ToolNames.Read });
	strictEqual(end().length, 1);
	for (const stopReason of ["error", "aborted", "length"]) {
		start();
		deepStrictEqual(end(stopReason), []);
	}
	canAsk = false;
	start();
	deepStrictEqual(end(), []);
	canAsk = true;
	plan = false;
	start({ turnMode: "proposal" });
	strictEqual(end().length, 1);
});

describe("turn_end effects inside one chat-loop run", () => {
	let env: IsolatedClioEnv;
	let faux: ReturnType<typeof registerEngineFauxProvider>;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-turn-ending-");
		faux = registerEngineFauxProvider({ api: "turn-ending-fixture", models: [{ id: "chat" }], tokensPerSecond: 0 });
	});
	afterEach(() => {
		faux.unregister();
		env.restore();
	});

	function fixture(turnEndEffects: (turnEnd: number) => MiddlewareEffect[]) {
		const requests: Context[] = [];
		faux.setResponses(
			Array.from({ length: 4 }, (_, index) => (context: Context) => {
				requests.push(structuredClone(context));
				return {
					role: "assistant" as const,
					content: [{ type: "text" as const, text: `reply ${index + 1}` }],
					api: faux.api,
					provider: "fixture",
					model: "chat",
					stopReason: "stop" as const,
					timestamp: Date.now(),
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
			}),
		);
		const capabilities = { chat: true, tools: true, reasoning: false, contextWindow: 131072, maxTokens: 8192 };
		const runtime = {
			id: "fixture",
			displayName: "Fixture",
			kind: "http",
			tier: "cloud",
			apiFamily: "openai-completions",
			auth: "none",
			defaultCapabilities: capabilities,
			synthesizeModel: (_target: unknown, id: string) => faux.getModel(id),
		} as unknown as RuntimeDescriptor;
		const target = {
			id: "chat-target",
			runtime: "fixture",
			url: "https://chat.invalid/v1",
			defaultModel: "chat",
			capabilities: { contextWindow: 131072 },
		};
		const providers = {
			list: () => [
				{
					target,
					runtime,
					available: true,
					capabilities,
					discoveredModels: ["chat"],
					discoveredModelsSource: "probe",
					probeCapabilities: null,
				},
			],
			getTarget: () => target,
			getRuntime: () => runtime,
			getDetectedReasoning: () => false,
		} as unknown as ProvidersContract;
		let turnEnds = 0;
		const middleware = {
			registerHook: () => {},
			runHook: (input: MiddlewareHookInput) => ({
				effects: input.hook === "turn_end" ? turnEndEffects(++turnEnds) : [],
				ruleIds: [],
			}),
		} as unknown as MiddlewareContract;
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.chat.target = target.id;
		settings.chat.model = "chat";
		settings.chat.thinkingLevel = "off";
		settings.chat.prewarm = false;
		const loop = createChatLoop({
			getSettings: () => settings,
			providers,
			middleware,
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
		let agentEnds = 0;
		const notices: string[] = [];
		loop.onEvent((event) => {
			if (event.type === "agent_end") agentEnds += 1;
			if (event.type === "notice") notices.push(event.text);
		});
		return { loop, requests, notices, agentEnds: () => agentEnds };
	}

	const serialized = (context: Context | undefined) => JSON.stringify(context?.messages ?? []);

	it("carries a turn_end continuation inside the run and settles once", async () => {
		const nudge = "Open tasks remain; finish them before you answer.";
		const f = fixture((turnEnd) => (turnEnd === 1 ? [{ kind: "request_continuation", message: nudge }] : []));
		try {
			await f.loop.submit("do the task");
			strictEqual(f.requests.length, 2);
			ok(!serialized(f.requests[0]).includes(nudge));
			ok(serialized(f.requests[1]).includes(nudge), serialized(f.requests[1]));
			strictEqual(f.agentEnds(), 1);
		} finally {
			f.loop.dispose();
		}
	});

	it("delivers a model-audience reminder with the next request and never as a notice", async () => {
		const advice = "Model-only advice: a scout dispatch covers long read-only exploration.";
		const f = fixture((turnEnd) =>
			turnEnd === 1 ? [{ kind: "inject_reminder", message: advice, severity: "info", audience: "model" }] : [],
		);
		try {
			await f.loop.submit("look around");
			await f.loop.submit("next request");
			strictEqual(f.requests.length, 2);
			ok(serialized(f.requests[1]).includes(advice), serialized(f.requests[1]));
			ok(!f.notices.some((text) => text.includes(advice)), f.notices.join("\n"));
		} finally {
			f.loop.dispose();
		}
	});
});
