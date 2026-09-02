import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import {
	isLockedSynthesisFallbackOnly,
	LOCKED_SYNTHESIS_REPROMPT_TOOL,
	lockedSynthesisFallbackText,
	lockedSynthesisRepromptMessages,
	sanitizeLockedSynthesisMessage,
} from "../../src/engine/loop-guard.js";
import { patchWorkerRequestPayload } from "../../src/engine/provider-payload.js";
import type { AgentMessage, EngineModel } from "../../src/engine/types.js";

const model = { id: "m", provider: "llamacpp", api: "openai-completions" } as unknown as EngineModel;
const anthropicModel = { id: "m", provider: "anthropic", api: "anthropic-messages" } as unknown as EngineModel;
const payload = () => ({
	model: "m",
	messages: [{ role: "user", content: "hi" }],
	tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
});

describe("worker synthesis lock", () => {
	it("strips the tool surface on a locked round and keeps it under Anthropic's tool_choice", () => {
		const stripped = patchWorkerRequestPayload(payload(), model, {
			runtimeId: "llamacpp",
			toolSurfaceLocked: true,
		}) as Record<string, unknown>;
		strictEqual("tools" in stripped, false);
		strictEqual("tool_choice" in stripped, false);
		// Anthropic rejects a history carrying tool_use blocks unless tools are
		// defined, so the lock stays on the tool_choice knob there.
		const anthropic = patchWorkerRequestPayload(payload(), anthropicModel, {
			runtimeId: "anthropic",
			toolSurfaceLocked: true,
		}) as Record<string, unknown>;
		deepStrictEqual(anthropic.tools, payload().tools);
		deepStrictEqual(anthropic.tool_choice, { type: "none" });
	});

	it("recognizes a markup-only locked reply and shapes one paired re-prompt", () => {
		const message = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: '<tool_call>\n{"name":"read","arguments":{"path":"a.ts"}}\n</tool_call>' }],
		} as unknown as AgentMessage;
		strictEqual(sanitizeLockedSynthesisMessage(message), true);
		strictEqual(isLockedSynthesisFallbackOnly(message), true);
		const prose = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "The parser trims values." }],
		} as unknown as AgentMessage;
		strictEqual(isLockedSynthesisFallbackOnly(prose), false);
		ok(lockedSynthesisFallbackText().length > 0);
		const pair = lockedSynthesisRepromptMessages(1, { provider: "llamacpp", api: "openai-completions", model: "m" });
		strictEqual(pair.length, 2);
		const [call, result] = pair as unknown as [Record<string, unknown>, Record<string, unknown>];
		strictEqual(call.role, "assistant");
		strictEqual((call.content as Array<{ name: string }>)[0]?.name, LOCKED_SYNTHESIS_REPROMPT_TOOL);
		strictEqual(result.role, "toolResult");
		strictEqual(result.toolCallId, (call.content as Array<{ id: string }>)[0]?.id);
	});
});
