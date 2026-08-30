/**
 * Every request the orchestrator process sends to an inference endpoint has to
 * be visible to endpoint capacity while it is out (#250).
 *
 * The streaming turn registers one, and brief 05's pre-warm registers one. The
 * two rounds that go through the same `prepareOutOfTurnRound` admission path,
 * `/btw` and `/handoff`, send a full round against the very same endpoint and
 * were left out at merge time, so on a `--parallel 1` server dispatch admission
 * would admit a worker onto a slot the operator's side question is holding, and
 * the background-memory tier's `endpoint_busy` check (#229) would read the
 * endpoint as idle.
 */

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/contract.js";
import { foregroundStreamUsage } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import type { AgentEvent, AgentMessage, EngineModel } from "../../src/engine/types.js";
import { createChatLoop } from "../../src/interactive/chat-loop.js";
import type { runHandoffRound } from "../../src/interactive/handoff-round.js";
import type { runSideQuestion, SideQuestionResult } from "../../src/interactive/side-question.js";

const TARGET_URL = "http://127.0.0.1:8080/v1";
/** What `canonicalEndpointKey` makes of {@link TARGET_URL}; the terminal `/v1` mount is not identity. */
const ENDPOINT_KEY = "http://127.0.0.1:8080";

function target(): TargetDescriptor {
	return {
		id: "test-target",
		runtime: "fake-runtime",
		defaultModel: "model",
		url: TARGET_URL,
		capabilities: { contextWindow: 100_000, maxTokens: 4096, tools: true, chat: true },
	};
}

function settings(): ClioSettings {
	const value = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
	value.orchestrator.target = "test-target";
	value.orchestrator.model = "model";
	value.orchestrator.thinkingLevel = "off";
	value.targets = [target()];
	value.prewarm = { ...value.prewarm, enabled: false };
	return value;
}

function fakeModel(): EngineModel {
	return {
		id: "model",
		name: "model",
		api: "openai-completions",
		provider: "fake-runtime",
		baseUrl: TARGET_URL,
		contextWindow: 100_000,
		maxTokens: 4096,
		reasoning: false,
		input: [],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as unknown as EngineModel;
}

function providers(): ProvidersContract {
	const descriptor = target();
	const runtime: RuntimeDescriptor = {
		id: "fake-runtime",
		displayName: "Fake Runtime",
		kind: "http",
		tier: "local-native",
		apiFamily: "openai-completions",
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: 100_000, maxTokens: 4096 },
		synthesizeModel: () => fakeModel() as never,
	};
	const status: TargetStatus = {
		target: descriptor,
		runtime,
		available: true,
		reason: "test",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities: { ...runtime.defaultCapabilities },
		discoveredModels: ["model"],
	};
	return {
		list: () => [status],
		getTarget: (id: string) => (id === descriptor.id ? descriptor : null),
		getRuntime: (id: string) => (id === runtime.id ? runtime : null),
		getDetectedReasoning: () => null,
		probeTarget: async () => status,
		probeReasoningForModel: async () => null,
		knowledgeBase: null,
		auth: {
			statusForTarget: () => ({ kind: "not-required" }) as never,
			resolveForTarget: async () => ({ apiKey: "", source: "none" }) as never,
		} as never,
	} as never;
}

function createFakeAgentFactory() {
	return ((options: { initialState?: Record<string, unknown> } = {}) => {
		const listeners: Array<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void> = [];
		const state = {
			systemPrompt: (options.initialState?.systemPrompt as string) ?? "session prompt",
			model: options.initialState?.model ?? fakeModel(),
			thinkingLevel: (options.initialState?.thinkingLevel as string) ?? "off",
			tools: (options.initialState?.tools as unknown[]) ?? [],
			messages: (options.initialState?.messages as AgentMessage[]) ?? [],
			errorMessage: undefined as string | undefined,
		};
		const agent = {
			state,
			sessionId: undefined,
			maxRetryDelayMs: undefined,
			subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void) {
				listeners.push(listener);
				return () => {};
			},
			async prompt() {},
			async continue() {},
			followUp() {},
			abort() {},
			clearAllQueues() {},
			clearFollowUpQueue() {},
			clearSteeringQueue() {},
		};
		return { agent, state: () => state };
	}) as never;
}

function answered(): SideQuestionResult {
	return { text: "answer", usage: null, aborted: false };
}

/** Endpoint slots held on {@link ENDPOINT_KEY} at the moment the round is in flight. */
function sampleWhileRunning(sample: number[]): { round: typeof runSideQuestion; handoff: typeof runHandoffRound } {
	const observe = async (): Promise<SideQuestionResult> => {
		sample.push(foregroundStreamUsage()[ENDPOINT_KEY] ?? 0);
		return answered();
	};
	return { round: observe as unknown as typeof runSideQuestion, handoff: observe as unknown as typeof runHandoffRound };
}

describe("contracts/out-of-turn rounds hold an endpoint slot", () => {
	it("counts a /btw round against the endpoint it streams to, and releases it", async () => {
		const sample: number[] = [];
		const { round } = sampleWhileRunning(sample);
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			runSideQuestion: round,
			createAgent: createFakeAgentFactory(),
		} as never);

		const outcome = await loop.askSideQuestion("which file was that");
		strictEqual(outcome.status, "answered");
		deepStrictEqual(sample, [1], "the side question is one held request on the endpoint while it is out");
		strictEqual(foregroundStreamUsage()[ENDPOINT_KEY] ?? 0, 0, "and the slot is released when it settles");
		loop.dispose();
	});

	it("counts a /handoff round the same way", async () => {
		const sample: number[] = [];
		const { handoff } = sampleWhileRunning(sample);
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			runHandoffRound: handoff,
			createAgent: createFakeAgentFactory(),
		} as never);

		const outcome = await loop.extractHandoff("write the handoff");
		strictEqual(outcome.status, "answered");
		deepStrictEqual(sample, [1], "the handoff round is one held request on the endpoint while it is out");
		strictEqual(foregroundStreamUsage()[ENDPOINT_KEY] ?? 0, 0, "and the slot is released when it settles");
		loop.dispose();
	});

	it("releases the slot when the round throws", async () => {
		const failing = (async () => {
			throw new Error("the backend refused the round");
		}) as unknown as typeof runSideQuestion;
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			runSideQuestion: failing,
			createAgent: createFakeAgentFactory(),
		} as never);

		const outcome = await loop.askSideQuestion("which file was that");
		strictEqual(outcome.status, "failed");
		strictEqual(foregroundStreamUsage()[ENDPOINT_KEY] ?? 0, 0, "a failed round leaves no slot behind");
		loop.dispose();
	});
});
