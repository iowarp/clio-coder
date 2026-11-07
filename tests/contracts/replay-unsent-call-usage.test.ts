import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { lockedSynthesisRepromptMessages } from "../../src/engine/loop-guard.js";
import { assistantSessionPayload } from "../../src/session-control/chat-loop-messages.js";
import { buildReplayAgentMessagesFromTurns } from "../../src/session-control/session-replay-messages.js";

const usage = {
	input: 900,
	output: 40,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 940,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function entry(index: number, role: "user" | "assistant", payload: unknown): SessionEntry {
	return {
		kind: "message",
		turnId: `t${index}`,
		parentTurnId: index === 0 ? null : `t${index - 1}`,
		timestamp: `2026-11-07T14:10:${String(index).padStart(2, "0")}Z`,
		role,
		payload,
	} as SessionEntry;
}

// A turn the loop guard locked into synthesis, then a resumed turn (afterF-1).
// The re-prompt Clio wrote is persisted with `usage: null` (#434: no synthetic
// usage on disk for an unsent call), so the replay rebuilt every later turn
// around an assistant `toolUse` message whose usage was null, and pi-ai's
// request sizing threw on `totalTokens` before any call went out.
test("a resumed session sizes its context past a persisted synthesis re-prompt", async () => {
	const [reprompt] = lockedSynthesisRepromptMessages(1, {
		provider: "litellm",
		api: "openai-completions",
		model: "m",
	});
	const persisted = assistantSessionPayload(reprompt as AgentMessage, null);
	assert.equal(persisted.usage, null);
	const entries = [
		entry(0, "user", { text: "Read the files." }),
		entry(1, "assistant", { text: "Partial answer.", stopReason: "stop", usage }),
		entry(2, "assistant", persisted),
		entry(3, "assistant", { text: "Final answer.", stopReason: "stop", usage }),
		entry(4, "user", { text: "Now the next question." }),
	];
	const messages = buildReplayAgentMessagesFromTurns(entries);
	assert.equal((messages[2] as { usage?: unknown }).usage, null, "the record keeps the never-sent contract");
	const { agent } = createEngineAgent({
		initialState: { systemPrompt: "", tools: [], messages: [], thinkingLevel: "off" },
	});
	const wire = await agent.convertToLlm(messages);
	const estimate = estimateContextTokens(wire);
	// The re-prompt adds no usage of its own: the anchor stays the last real call.
	assert.equal(estimate.usageTokens, 940);
	assert.equal(estimate.lastUsageIndex, wire.length - 2);
});
