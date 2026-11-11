import { match, rejects, strictEqual } from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

/** A chat loop on a route with no rates anywhere, so its calls project nothing. */
function unpricedLoop(target: { id: string; runtime: string }, scheduling: SchedulingContract, prewarm: boolean) {
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
		id: target.runtime,
		displayName: "Fixture",
		kind: "http",
		// Pre-warm runs only on local-native routes, which are the usual unpriced ones.
		tier: prewarm ? "local-native" : "cloud",
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
	settings.chat.prewarm = prewarm;
	return createChatLoop({
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
		isLatencySurface: () => prewarm,
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
}

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

it("side questions, System One and the safety judge are checked against the cost ceiling on an unpriced route", async (t) => {
	const env = await isolateClioEnv("clio-coder-side-call-ceiling-");
	t.after(() => env.restore());
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

	const loop = unpricedLoop(target, scheduling, false);
	const outcome = await loop.askSideQuestion("why?");
	strictEqual(checked, 2, JSON.stringify(outcome));
	strictEqual(outcome.status === "answered", false);
	match("reason" in outcome ? outcome.reason : "", /ceiling/u);
});

it("the pre-warm on an unpriced route is gated like the turn it warms, not held at the ceiling", async (t) => {
	const env = await isolateClioEnv("clio-coder-prewarm-ceiling-");
	t.after(() => env.restore());
	let checked = 0;
	const scheduling = {
		preflight: () => ({ currentUsd: 5, ceilingUsd: 5, verdict: "at" }),
		async admitPaidRequest() {
			checked += 1;
			throw new Error("session cost ceiling reached");
		},
	} as unknown as SchedulingContract;
	// A loaded, idle llama.cpp deployment on loopback, so the pre-warm reaches its prepare.
	const build = "b1-c841aee";
	const server = createServer((req, res) => {
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		res.setHeader("content-type", "application/json");
		if (path === "/props") return res.end(JSON.stringify({ build_info: build, is_sleeping: false }));
		if (path === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "chat" }] }));
		if (path === "/slots") return res.end(JSON.stringify([{ is_processing: false }]));
		res.writeHead(404);
		res.end("{}");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const target = {
		id: "unpriced",
		runtime: "llamacpp",
		url: `${root}/v1`,
		defaultModel: "chat",
		cache: { deployment: { backend: "llamacpp", controlUrl: root, model: "chat", build } },
	};
	const loop = unpricedLoop(target, scheduling, true);
	// The session-start round waits a quiet second on an unref'd timer; hold the loop open for it.
	const keepAlive = setTimeout(() => {}, 10_000);
	try {
		const outcome = await loop.whenPrewarmSettled();
		strictEqual(checked, 0, "the turn on this route is not gated, so neither is its pre-warm");
		strictEqual(outcome?.ran, true, JSON.stringify(outcome));
	} finally {
		clearTimeout(keepAlive);
		loop.dispose();
	}
});
