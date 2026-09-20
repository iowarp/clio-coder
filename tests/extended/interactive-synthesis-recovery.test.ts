import { match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { lockedSynthesisFallbackText } from "../../src/engine/loop-guard.js";
import { createChatLoop } from "../../src/interactive/chat-loop.js";
import { startGatewayThinkingFixture } from "../harness/gateway-thinking-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const markup = '<tool_call>{"name":"read","arguments":{"path":"never-read.ts"}}</tool_call>';
for (const outcome of ["recovered", "exhausted", "usable-prose", "cancelled"] as const) {
	test(`interactive synthesis lock: ${outcome}`, async () => {
		const env = await isolateClioEnv("interactive-synthesis-");
		const bus = createSafeEventBus();
		const wire = await startGatewayThinkingFixture("lm-studio", "fixture-model", undefined, (_body, index) => {
			if (index === 0) {
				bus.emit(BusChannels.LoopBlocked, {
					tool: "read",
					repeatCount: 4,
					blocksThisTurn: 2,
					budget: 2,
					interrupted: false,
					disposition: "lockout",
					at: Date.now(),
				});
			}
			if (outcome === "cancelled") loop.cancel();
			if (outcome === "usable-prose") return `The command has no model flag.\n${markup}`;
			return index > 0 && outcome === "recovered" ? "The command has no model flag." : markup;
		});
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.chat.target = "fixture";
		settings.chat.model = wire.modelId;
		settings.chat.thinkingLevel = "off";
		settings.chat.prewarm = false;
		const target = { id: "fixture", runtime: "litellm", url: wire.url, capabilities: { reasoning: false } };
		const providers = {
			getTarget: () => target,
			getRuntime: () => ({ ...litellm, auth: "none" }),
			getDetectedReasoning: () => false,
			list: () => [
				{
					target,
					runtime: litellm,
					capabilities: litellm.defaultCapabilities,
					available: true,
					discoveredModels: [wire.modelId],
					discoveredModelsSource: "probe",
					probeCapabilities: null,
				},
			],
		} as unknown as ProvidersContract;
		let handle: ReturnType<typeof createEngineAgent> | undefined;
		const loop = createChatLoop({
			getSettings: () => settings,
			providers,
			bus,
			knownTargets: () => new Set([target.id]),
			createAgent: (options) => {
				handle = createEngineAgent(options);
				return handle;
			},
		});
		try {
			await loop.submit("Does this command accept a model flag?");
			if (outcome === "cancelled") {
				strictEqual(wire.requests.length, 1, "operator cancellation must not start recovery");
				return;
			}
			strictEqual(wire.requests.length, outcome === "usable-prose" ? 1 : 2);
			if (outcome !== "usable-prose") {
				strictEqual(wire.requests[1]?.tool_choice, "none");
				const serialized = JSON.stringify(wire.requests[1]?.messages);
				match(serialized, /Current execution phase: final synthesis/);
				match(serialized, /clio_synthesis_reprompt/);
				match(serialized, /Do not invent missing evidence/);
			}
			const last = handle?.agent.state.messages.at(-1);
			ok(last?.role === "assistant");
			const text = last.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("");
			strictEqual(text, outcome === "exhausted" ? lockedSynthesisFallbackText() : "The command has no model flag.");
			ok(
				!handle?.agent.state.systemPrompt.includes("Current execution phase: final synthesis"),
				"lock prompt must not persist into future turns",
			);
		} finally {
			loop.dispose();
			await wire.close();
			env.restore();
		}
	});
}
