import { ok } from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { HEADLESS_PERMISSION_DENIED_REASON } from "../../src/core/headless-permission.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { type ChatLoopEvent, type CreateChatLoopDeps, createChatLoop } from "../../src/interactive/chat-loop.js";
import { bashTool } from "../../src/tools/bash.js";
import { createRegistry } from "../../src/tools/registry.js";

export const inline = `python3 -c "from pathlib import Path; Path('sentinel.txt').write_text('changed')"`;

export async function runtimeFixture(cwd: string) {
	const safety = createWorkerSafety({ cwd });
	const registry = createRegistry({ safety, autonomy: () => "full-auto" });
	registry.register(bashTool);
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	settings.chat.target = "fixture";
	settings.chat.model = "fixture-model";
	settings.safety.autonomy = "full-auto";
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
		maxTokens: 4096,
	};
	const target = {
		id: "fixture",
		runtime: "fixture",
		url: "https://fixture.invalid",
		defaultModel: "fixture-model",
		capabilities,
	};
	const model = {
		id: "fixture-model",
		name: "Fixture",
		api: "openai-completions",
		provider: "fixture",
		baseUrl: target.url,
		reasoning: false,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const runtime = {
		id: "fixture",
		displayName: "Fixture",
		kind: "http",
		tier: "cloud",
		apiFamily: "openai-completions",
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
				discoveredModels: ["fixture-model"],
				discoveredModelsSource: "probe",
				probeCapabilities: null,
			},
		],
	} as unknown as ProvidersContract;
	let pendingRequest: string | undefined;
	registry.onPermissionRequired((_call, _decision, meta) => {
		pendingRequest = meta.requestId;
	});
	const events: ChatLoopEvent[] = [];
	const loop = createChatLoop({
		getSettings: () => settings,
		providers,
		knownTargets: () => new Set(["fixture"]),
		toolRegistry: registry,
		createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => {
			const state = options?.initialState;
			ok(state);
			let listener: ((event: AgentEvent) => void) | undefined;
			return {
				agent: {
					state,
					abort() {},
					subscribe: (callback: (event: AgentEvent) => void) => {
						listener = callback;
						return () => {};
					},
					prompt: async () => {
						const bash = state.tools?.find((entry) => entry.name === "bash");
						ok(bash);
						const begin = (id: string, command: string) => {
							listener?.({ type: "tool_execution_start", toolName: "bash", toolCallId: id, args: { command } });
							return bash.execute(id, { command }).then(
								(result) => ({ result, isError: result.details.kind === "error" }),
								(error: unknown) => ({
									result: { content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }] },
									isError: true,
								}),
							);
						};
						const end = async (id: string, pending: ReturnType<typeof begin>) => {
							listener?.({ type: "tool_execution_end", toolName: "bash", toolCallId: id, ...(await pending) });
						};
						// Actual registry/adapter calls of the same tool finish in reverse start order.
						const denied = begin("ask-first", inline);
						await end("error-second", begin("error-second", "cat missing-blocked.txt"));
						ok(pendingRequest);
						registry.cancelParkedCall(pendingRequest, HEADLESS_PERMISSION_DENIED_REASON);
						await end("ask-first", denied);
						await end("success", begin("success", "cat sentinel.txt"));
						await end("hard", begin("hard", "rm -f sentinel.txt"));
						// Legacy producer controls have no admission telemetry. Words never classify them.
						for (const isError of [false, true])
							listener?.({
								type: "tool_execution_end",
								toolName: "legacy",
								toolCallId: `legacy-${isError}`,
								isError,
								result: { content: [{ type: "text", text: "blocked cancelled are ordinary result words" }] },
							});
						const message = {
							role: "assistant",
							content: [{ type: "text", text: "Done; inline mutation remained denied." }],
							stopReason: "stop",
							timestamp: Date.now(),
						} as AgentMessage;
						state.messages?.push(message);
						listener?.({ type: "message_end", message });
					},
				},
			};
		}) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
	});
	loop.onEvent((event) => events.push(event));
	return { loop, events, safety };
}
