import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import type { PromptsContract } from "../../src/domains/prompts/contract.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { createChatLoop } from "../../src/session-control/chat-loop.js";

it("compiles a resumed session's next request after the probe restores its window (M-26)", async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.target = "route";
	settings.chat.model = "model";
	settings.chat.prewarm = false;
	const capabilities = { chat: true, tools: true, reasoning: false, vision: false, contextWindow: 0, maxTokens: 4096 };
	const target = { id: "route", runtime: "route", url: "https://fixture.invalid", defaultModel: "model" };
	const runtime = {
		id: "route",
		displayName: "Route",
		kind: "http",
		tier: "protocol",
		apiFamily: "openai-completions",
		auth: "none",
		defaultCapabilities: capabilities,
		synthesizeModel: (_target: unknown, id: string) => ({
			id,
			name: id,
			api: "openai-completions",
			provider: "route",
			baseUrl: target.url,
			reasoning: false,
			input: ["text"],
			contextWindow: 0,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}),
	};
	let probed = false;
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const status = () => ({
		target,
		runtime,
		available: true,
		capabilities,
		discoveredModels: ["model"],
		discoveredModelsSource: "probe",
		probeModelId: "model",
		probeCapabilities: probed ? { contextWindow: 200_000 } : null,
		health: { status: "healthy", lastCheckAt: new Date().toISOString(), lastError: null, latencyMs: 1 },
	});
	const providers = {
		getTarget: () => target,
		getRuntime: () => runtime,
		getDetectedReasoning: () => false,
		list: () => [status()],
		// A resumed process restores the probed window only when this answers.
		probeTarget: async () => {
			await gate;
			probed = true;
			return status();
		},
	} as unknown as ProvidersContract;
	const compiledWindows: Array<number | null | undefined> = [];
	const loop = createChatLoop({
		getSettings: () => settings,
		bus: createTelemetryHub(),
		providers,
		knownTargets: () => new Set(["route"]),
		createAgent: (options) => {
			const handle = createEngineAgent(options);
			handle.agent.prompt = async () => {};
			return handle;
		},
		prompts: {
			inputEpoch: () => "0",
			compileSessionPrompt: async (input) => {
				compiledWindows.push(input.sessionInputs?.contextWindow);
				const systemPrompt = `Context window: ${input.sessionInputs?.contextWindow ?? "unknown"}`;
				return { systemPrompt, systemPromptHash: systemPrompt, tokenEstimate: 8, sections: [], fragmentManifest: [] };
			},
			compileWorkerPrompt: async () => {
				throw new Error("not used");
			},
			reload() {},
		} as PromptsContract,
	});
	try {
		const replay = [{ role: "user", content: "earlier turn", timestamp: 1 }] as unknown as AgentMessage[];
		loop.resetForSession("leaf", replay);
		await new Promise<void>((resolve) => setImmediate(resolve));
		release();
		await loop.nextRequestReady();
		deepStrictEqual(compiledWindows, [200_000], "the resumed budget is priced from the prompt the submit sends");
		await loop.submit("next");
		deepStrictEqual(compiledWindows, [200_000], "the submit sends that compile instead of compiling again");
	} finally {
		loop.dispose();
	}
});

it("refreshes the attached serving window after the selected-route TTL without a new turn", {
	timeout: 12_000,
}, async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.target = "route";
	settings.chat.model = "model";
	settings.chat.maxOutputTokens = 1024;
	settings.chat.prewarm = false;
	const capabilities = {
		chat: true,
		tools: true,
		reasoning: false,
		vision: false,
		audio: false,
		embeddings: false,
		rerank: false,
		fim: false,
		contextWindow: 0,
		maxTokens: 4096,
	};
	const target = { id: "route", runtime: "route", url: "https://fixture.invalid", defaultModel: "model" };
	const model = {
		id: "model",
		name: "model",
		api: "openai-completions",
		provider: "route",
		baseUrl: target.url,
		reasoning: false,
		input: ["text"],
		contextWindow: 0,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const runtime = {
		id: "route",
		displayName: "Route",
		kind: "http",
		tier: "protocol",
		apiFamily: "openai-completions",
		auth: "none",
		defaultCapabilities: capabilities,
		synthesizeModel: (_target: unknown, wireModelId: string) => ({
			...structuredClone(model),
			id: wireModelId,
			baseUrl: target.url,
		}),
	};
	let servingWindow = 32_768;
	let observedWindow = 0;
	let probes = 0;
	const status = () => ({
		target,
		runtime,
		available: true,
		capabilities,
		discoveredModels: ["model", "other"],
		discoveredModelsSource: "probe",
		probeModelId: "model",
		probeCapabilities: observedWindow > 0 ? { contextWindow: observedWindow } : null,
		probeModelCapabilities: observedWindow > 0 ? { other: { contextWindow: observedWindow } } : null,
		health: { status: "healthy", lastCheckAt: new Date().toISOString(), lastError: null, latencyMs: 1 },
	});
	const providers = {
		getTarget: () => target,
		getRuntime: () => runtime,
		getDetectedReasoning: () => false,
		list: () => [status()],
		probeTarget: async () => {
			probes += 1;
			observedWindow = servingWindow;
			return status();
		},
	} as unknown as ProvidersContract;
	const actualNow = Date.now;
	let clock = actualNow();
	Date.now = () => clock;
	const bus = createTelemetryHub();
	const loop = createChatLoop({
		getSettings: () => settings,
		bus,
		providers,
		knownTargets: () => new Set(["route"]),
		createAgent: (options) => {
			const handle = createEngineAgent(options);
			handle.agent.prompt = async () => {};
			return handle;
		},
	});
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		strictEqual(loop.liveBudget().effectiveWindow, 32_768, "startup probe publishes the footer budget");
		await loop.submit("first");
		strictEqual(loop.liveBudget().effectiveWindow, 32_768);
		strictEqual(probes, 1);
		servingWindow = 65_536;
		clock += 30_001;
		await new Promise<void>((resolve) => setTimeout(resolve, 5_250));
		strictEqual(probes, 2);
		strictEqual(loop.liveBudget().effectiveWindow, 65_536);
		servingWindow = 131_072;
		settings.chat.model = "other";
		bus.emit("config.next_turn_scheduled", {
			source: "file",
			diff: { hotReload: [], nextTurn: ["chat.model"], restartRequired: [] },
			settings,
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		strictEqual(probes, 3, "a saved model change refreshes before the next submit");
		strictEqual(loop.liveBudget().effectiveWindow, 131_072);
		await loop.submit("selected model changed");
		strictEqual(probes, 3);
		strictEqual(loop.liveBudget().effectiveWindow, 131_072);
		servingWindow = 262_144;
		target.url = "https://another-fixture.invalid";
		bus.emit("config.next_turn_scheduled", {
			source: "file",
			diff: { hotReload: [], nextTurn: ["targets.route.url"], restartRequired: [] },
			settings,
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		strictEqual(probes, 4, "a saved target endpoint change refreshes before the next submit");
		await loop.submit("endpoint changed");
		strictEqual(probes, 4);
		strictEqual(loop.liveBudget().effectiveWindow, 262_144);
		servingWindow = 0;
		clock += 30_001;
		await loop.submit("metadata unavailable");
		strictEqual(loop.liveBudget().effectiveWindow, null, "an unavailable report cannot retain the old window");
		servingWindow = 880_128;
		clock += 30_001;
		await loop.submit("metadata restored");
		strictEqual(loop.liveBudget().effectiveWindow, 880_128);
	} finally {
		loop.dispose();
		Date.now = actualNow;
	}
});
