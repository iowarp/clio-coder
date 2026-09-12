import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentMessage } from "../../src/engine/types.js";
import type { TurnContext } from "../../src/interactive/turn-context.js";
import type { TurnPersistence } from "../../src/interactive/turn-persistence.js";
import { createTurnRecovery } from "../../src/interactive/turn-recovery.js";
import type { AgentRuntime, ChatTurnState } from "../../src/interactive/turn-state.js";

describe("LiteLLM interactive failure policy", () => {
	it("persists one failure and never enters Clio's transient retry ladder", async () => {
		const failureMessage = {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "gateway unavailable",
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		let continueCalls = 0;
		let persisted = 0;
		let emitted = 0;
		const persistence = {
			wasPersisted: () => false,
			appendAssistantTurn: (message: AgentMessage) => {
				strictEqual(message, failureMessage);
				persisted += 1;
			},
			appendRetryStatus: () => {
				throw new Error("LiteLLM must not record a retry status");
			},
		} as unknown as TurnPersistence;
		const recovery = createTurnRecovery({
			state: { activeInterruptReason: null } as ChatTurnState,
			persistence,
			context: {} as TurnContext,
			retrySettings: () => ({
				enabled: true,
				maxRetries: 3,
				baseDelayMs: 1,
				maxDelayMs: 1,
				streamStallMs: 1,
			}),
			markPersistedUserEcho: async () => undefined,
			emitRetryStatus: () => {
				throw new Error("LiteLLM must not emit a retry status");
			},
			emitFailureMessage: (message) => {
				strictEqual(message, failureMessage);
				emitted += 1;
			},
			emitNotice: () => undefined,
		});
		const runtime = {
			runtimeId: "litellm",
			targetId: "blade",
			wireModelId: "dynamo/qwen3.8-27b",
			agent: {
				continue: async () => {
					continueCalls += 1;
				},
			},
		} as unknown as AgentRuntime;

		const handled = await recovery.runTransientRetryChain(runtime, "hello", {
			stopReason: "error",
			errorMessage: "gateway unavailable",
			message: failureMessage,
		});

		ok(handled);
		strictEqual(continueCalls, 0);
		strictEqual(persisted, 1);
		strictEqual(emitted, 1);
	});
});
