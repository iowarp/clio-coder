import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { rehydrateChatPanelFromTurns } from "../../src/interactive/chat-renderer.js";

const usage = {
	input: 7,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 12,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function replay(items: Array<{ role: "user" | "assistant"; payload: unknown } | { retry: true }>): string {
	const entries: SessionEntry[] = items.map((item, index) => ({
		turnId: `turn-${index}`,
		parentTurnId: index === 0 ? null : `turn-${index - 1}`,
		timestamp: "2026-09-17T00:00:00Z",
		...("retry" in item
			? {
					kind: "custom" as const,
					customType: "retryStatus",
					data: { phase: "scheduled", attempt: 1, maxAttempts: 1, errorMessage: "HTTP 503 Unavailable" },
				}
			: { kind: "message" as const, ...item }),
	}));
	const panel = createChatPanel();
	rehydrateChatPanelFromTurns(panel, entries);
	return panel.render(120).map(stripTerminalSequences).join("\n");
}
const toolCall = {
	role: "assistant" as const,
	payload: {
		stopReason: "toolUse",
		content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "notes.txt" } }],
		usage,
	},
};
const success = {
	role: "assistant" as const,
	payload: { stopReason: "stop", content: [{ type: "text", text: "Recovered answer" }], usage },
};

for (const stopReason of ["error", "aborted"] as const) {
	test(`a later tool-use turn cannot stamp Done on a previous ${stopReason} replay`, () => {
		const output = replay([
			{ role: "user", payload: { text: "First request" } },
			{
				role: "assistant",
				payload: {
					stopReason,
					errorMessage: "HTTP 503 Request ended",
					content: [],
					usage: { ...usage, input: 0, output: 0, totalTokens: 0 },
				},
			},
			{ role: "user", payload: { text: "Second request" } },
			toolCall,
			success,
		]);
		const [first, second] = output.split("› Second request");
		assert.ok(first !== undefined && second !== undefined);
		assert.match(first, /503/);
		assert.doesNotMatch(first, /\bDone\b/);
		assert.match(second, /Recovered answer/);
		assert.match(second, /\bDone\b/);
	});
}

test("transient error followed by tool use and recovery retains one final success receipt", () => {
	const output = replay([
		{ role: "user", payload: { text: "One request" } },
		{ role: "assistant", payload: { stopReason: "error", errorMessage: "HTTP 503 Unavailable", content: [] } },
		{ retry: true },
		toolCall,
		success,
	]);
	assert.match(output, /503/);
	assert.match(output, /Recovered answer/);
	assert.equal((output.match(/\bDone\b/g) ?? []).length, 1);
	assert.ok(output.indexOf("Done") > output.indexOf("Recovered answer"));
});

test("actual final failure after tool use retains a failed outcome while success remains Done", () => {
	for (const stopReason of ["error", "aborted", "stop"] as const) {
		const output = replay([
			{ role: "user", payload: { text: "One request" } },
			toolCall,
			{
				role: "assistant",
				payload: { stopReason, errorMessage: "Request ended", content: [{ type: "text", text: "Final response" }], usage },
			},
		]);
		assert.match(output, stopReason === "error" ? /Failed/ : stopReason === "aborted" ? /Cancelled/ : /Done/);
		if (stopReason !== "stop") assert.doesNotMatch(output, /\bDone\b/);
	}
});

test("a replay ending at an intermediate tool-use message does not invent completion", () => {
	const output = replay([{ role: "user", payload: { text: "Incomplete request" } }, toolCall]);
	assert.doesNotMatch(output, /\bDone\b/);
});
