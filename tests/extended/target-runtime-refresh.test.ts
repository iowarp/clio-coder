import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { MiddlewareContract } from "../../src/domains/middleware/contract.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
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
	settings.chat.retry.baseDelayMs = 1;
	settings.chat.retry.maxDelayMs = 1;
	const target: TargetDescriptor = {
		id: "gateway",
		runtime: "litellm",
		url: first.url,
		capabilities: { reasoning: false, tools: true },
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
		toolRegistry: createWorkerToolRegistry(),
		middleware: {
			runHook: (input: Parameters<MiddlewareContract["runHook"]>[0]) => ({
				effects:
					input.hook === "turn_end" && input.metadata?.turnMode === "proposal"
						? [{ kind: "request_continuation", message: "Keep going" }]
						: [],
				ruleIds: [],
			}),
		} as unknown as MiddlewareContract,
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
		const constraints = { mode: "proposal" as const, allowedTools: ["read"] };
		const firstTurn = loop.submit("First authorized task", { constraints });
		constraints.allowedTools.push("edit");
		await firstTurn;
		strictEqual(first.requests.length, 1);
		deepStrictEqual(
			agents[0]?.agent.state.tools.map((tool) => tool.name),
			["read"],
			"caller mutation cannot widen an admitted turn",
		);
		deepStrictEqual(loop.currentTurnConstraints?.()?.allowedTools, ["read"]);
		await loop.submit("Same target configuration");
		strictEqual(
			loop.currentTurnConstraints?.(),
			undefined,
			"a fresh task does not inherit the previous task's restriction",
		);
		ok(agents[0]?.agent.state.tools.some((tool) => tool.name === "edit"));
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
		const retryPhases: string[] = [];
		loop.onEvent((event) => {
			if (event.type === "retry_status") retryPhases.push(event.status.phase);
		});
		second.dropNextConnection();
		await loop.submit("Recover a dropped connection on this exact route");
		strictEqual(second.requests.length, 3, "one failed connection and one visible retry, no SDK retries");
		strictEqual(first.requests.length, 2, "recovery must not fall back to another endpoint");
		ok(retryPhases.includes("retrying"));
		ok(retryPhases.includes("recovered"));
		strictEqual(agents.at(-1)?.agent.state.messages.at(-1)?.role, "assistant");
	} finally {
		loop.dispose();
		await first.close();
		await second.close();
	}
});
