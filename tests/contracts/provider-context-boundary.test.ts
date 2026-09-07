import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { serializeConversation } from "../../src/domains/session/compaction/branch-summary.js";
import { estimateTokens } from "../../src/domains/session/compaction/tokens.js";
import type { BashExecutionEntry } from "../../src/domains/session/entries.js";
import { streamSimple } from "../../src/engine/ai.js";
import { findEngineEnvKeys, getEngineEnvApiKey } from "../../src/engine/env-api-keys.js";
import type { AgentMessage, EngineModel } from "../../src/engine/types.js";
import { assistantSessionPayload } from "../../src/interactive/chat-loop-messages.js";
import { buildReplayAgentMessagesFromTurns } from "../../src/interactive/chat-renderer.js";

function bashEntry(
	id: string,
	command: string,
	output: string,
	excludeFromContext: boolean,
	parentTurnId: string | null,
): BashExecutionEntry {
	return {
		kind: "bashExecution",
		turnId: id,
		parentTurnId,
		timestamp: `2026-06-08T00:00:${id}.000Z`,
		command,
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		excludeFromContext,
	};
}

function messageText(messages: ReadonlyArray<unknown>): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") parts.push(content);
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
				parts.push((block as { text: string }).text);
			}
		}
	}
	return parts.join("\n");
}

describe("operator-private provider context boundary", () => {
	it("keeps !! command and output bytes out of replay, compaction, and accounting", () => {
		const visible = bashEntry("01", "printf visible-command", "visible-output", false, null);
		const privateEntry = bashEntry("02", "printf operator-private-command", "operator-private-output", true, "01");
		const entries = [visible, privateEntry];

		const replay = messageText(buildReplayAgentMessagesFromTurns(entries));
		const compaction = serializeConversation(entries);
		for (const providerInput of [replay, compaction]) {
			ok(providerInput.includes(visible.command));
			ok(providerInput.includes(visible.output));
			strictEqual(providerInput.includes(privateEntry.command), false);
			strictEqual(providerInput.includes(privateEntry.output), false);
		}
		ok(estimateTokens(visible) > 0);
		strictEqual(estimateTokens(privateEntry), 0);
	});
});

describe("Pi provider metadata across Clio persistence", () => {
	it("replays historical thinking effort through Pi's native Anthropic request builder", async () => {
		const model: EngineModel = {
			id: "claude-fable-5-1",
			name: "fixture",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://provider.invalid",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 4096,
			compat: { supportsMidConvoEffort: true, forceAdaptiveThinking: true },
		};
		const entries = ["high", "medium"].map((effort, index) => {
			const message: AgentMessage = {
				role: "assistant",
				api: "anthropic-messages",
				provider: "anthropic",
				model: model.id,
				providerThinkingLevel: effort,
				content: [{ type: "text", text: `response ${index}` }],
				stopReason: "stop",
				timestamp: index,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			return {
				kind: "message" as const,
				role: "assistant" as const,
				turnId: `turn-${index}`,
				parentTurnId: index === 0 ? null : "turn-0",
				timestamp: new Date(index).toISOString(),
				payload: JSON.parse(JSON.stringify(assistantSessionPayload(message, null))),
			};
		});
		const replay = buildReplayAgentMessagesFromTurns(entries).filter((message) => message.role === "assistant");
		strictEqual(replay.length, 2);
		let request: { messages: Array<{ output_config?: { effort?: string } }> } | undefined;
		const capture = new Error("request captured before network I/O");
		const stream = streamSimple(
			model,
			{
				messages: [
					{ role: "user", content: "first request", timestamp: 0 },
					...replay.slice(0, 1),
					{ role: "user", content: "second request", timestamp: 1 },
					...replay.slice(1),
					{ role: "user", content: "continue", timestamp: 2 },
				],
			},
			{
				apiKey: "fixture-key",
				reasoning: "high",
				onPayload(payload) {
					request = payload as typeof request;
					throw capture;
				},
			},
		);
		for await (const _event of stream) {
			/* Drain the capture failure without sending a request. */
		}
		ok(request, "Pi must reach request assembly before the test aborts it");
		deepStrictEqual(
			request.messages.flatMap((message) => (message.output_config ? [message.output_config.effort] : [])),
			["high", "medium", "high"],
			"historical turns retain their own effort before the active effort marker",
		);
	});

	it("discovers Qwen Individual credentials through the same environment convention as Pi", () => {
		const env = { QWEN_TOKEN_PLAN_API_KEY: "fixture-key" };
		deepStrictEqual(findEngineEnvKeys("qwen-token-plan-individual", env), ["QWEN_TOKEN_PLAN_API_KEY"]);
		strictEqual(getEngineEnvApiKey("qwen-token-plan-individual", env), "fixture-key");
	});
});
