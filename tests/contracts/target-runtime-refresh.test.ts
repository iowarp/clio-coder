import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { createChatLoop } from "../../src/interactive/chat-loop.js";
import { startGatewayThinkingFixture } from "../harness/gateway-thinking-fixture.js";

test("editing a selected target refreshes the next request and retains portable conversation", async () => {
	const first = await startGatewayThinkingFixture();
	const second = await startGatewayThinkingFixture();
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.target = "gateway";
	settings.chat.model = first.modelId;
	settings.chat.thinkingLevel = "off";
	settings.chat.prewarm = false;
	const target: TargetDescriptor = {
		id: "gateway",
		runtime: "litellm",
		url: first.url,
		capabilities: { reasoning: false },
		auth: { apiKeyRef: "first-fixture-key" },
	};
	const authTargets: string[] = [];
	const providers = {
		getTarget: () => target,
		getRuntime: () => litellm,
		getDetectedReasoning: () => false,
		list: () => [
			{
				target,
				runtime: litellm,
				capabilities: { ...litellm.defaultCapabilities, ...target.capabilities },
				available: true,
				discoveredModels: [first.modelId],
				discoveredModelsSource: "probe",
				probeCapabilities: null,
			},
		],
		auth: {
			resolveForTarget: async (current: TargetDescriptor) => {
				authTargets.push(current.auth?.apiKeyRef ?? "");
				return { apiKey: current.auth?.apiKeyRef };
			},
		},
	} as unknown as ProvidersContract;
	const agents: ReturnType<typeof createEngineAgent>[] = [];
	const loop = createChatLoop({
		getSettings: () => settings,
		providers,
		knownTargets: () => new Set([target.id]),
		createAgent: (options) => {
			const handle = createEngineAgent(options);
			agents.push(handle);
			return handle;
		},
	});
	try {
		await loop.submit("First authorized task");
		strictEqual(first.requests.length, 1);
		await loop.submit("Same target configuration");
		strictEqual(agents.length, 1, "unchanged target retains the agent");
		// In-place mutation matters: provider resolutions can retain this descriptor.
		target.url = second.url;
		target.auth = { apiKeyRef: "second-fixture-key" };
		target.cache = { retention: "none" };
		await loop.submit("Continue on the edited target");
		strictEqual(agents.length, 2);
		strictEqual(first.requests.length, 2);
		strictEqual(second.requests.length, 1, "next turn reaches the edited endpoint");
		ok(JSON.stringify(second.requests[0]?.messages).includes("First authorized task"));
		strictEqual(authTargets.at(-1), "second-fixture-key");
		strictEqual(
			(agents.at(-1)?.agent.state.model as { clioCoder?: { cache?: { retention?: string } } }).clioCoder?.cache?.retention,
			"none",
		);
	} finally {
		loop.dispose();
		await first.close();
		await second.close();
	}
});
