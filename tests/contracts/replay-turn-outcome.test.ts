import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import type { MiddlewareToolChoiceControl } from "../../src/domains/middleware/index.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import type { ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { toolResultSummary } from "../../src/interactive/chat-loop-messages.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { rehydrateChatPanelFromTurns } from "../../src/interactive/chat-renderer.js";
import { createTurnPersistence } from "../../src/interactive/turn-persistence.js";
import type { ChatTurnState } from "../../src/interactive/turn-state.js";

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
		const [first, second] = output.split("▌ Second request");
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

test("a legacy replayed prompt drops the skill-request preamble the model received", () => {
	const composed = [
		"[Skill request]",
		"- test-hygiene (installed, source=slash-command) — task: pin the timers",
		'First call context with scope="skills" and name for: test-hygiene. Only these pending skill names are allowed this turn. After the skill loads, follow the loaded workflow.',
		"",
		"/skill test-hygiene pin the timers",
	].join("\n");
	const output = replay([{ role: "user", payload: { text: composed } }]);
	assert.doesNotMatch(output, /\[Skill request\]|Only these pending skill names/u);
	assert.match(output, /▌ \/skill test-hygiene pin the timers/u);
});

test("an unknown dynamic tool reads by its persisted action class, live and on replay", () => {
	const persisted: Array<{ kind: string; payload: Record<string, unknown> }> = [];
	const session = {
		append(turn: { kind: string; payload: Record<string, unknown> }) {
			persisted.push(turn);
			return { id: `persisted-${persisted.length}` };
		},
		current: () => null,
	} as unknown as SessionContract;
	const persistence = createTurnPersistence({
		state: { lastTurnId: null } as ChatTurnState,
		session,
		getSettings: () => ({}) as ClioSettings,
		middlewareToolChoice: {} as MiddlewareToolChoiceControl,
		consumePersistedEcho: () => false,
		removeQueuedMirrorEntry: () => {},
		promptCachePayloadForAssistant: () => ({}),
		promptSideTokens: () => 0,
	});
	const args = { stage: "staging" };
	// Enriched the way the turn runtime enriches every end event it forwards.
	const result = { content: [{ type: "text", text: "preview deployed" }], details: {} };
	const end = {
		type: "tool_execution_end" as const,
		toolCallId: "deploy-1",
		toolName: "deploy_preview",
		result,
		isError: false,
		durationMs: 1_200,
		resultSummary: toolResultSummary(result),
		actionClass: "execute",
	};
	persistence.appendToolResultTurn(end);
	assert.equal(persisted[0]?.payload.actionClass, "execute");

	const rowOf = (lines: string[]) => lines.map(stripTerminalSequences).find((line) => line.includes("deploy_preview"));
	const live = createChatPanel();
	live.applyEvent({
		type: "tool_execution_start",
		toolCallId: "deploy-1",
		toolName: "deploy_preview",
		args,
	} as ChatLoopEvent);
	live.applyEvent(end as ChatLoopEvent);
	const liveRow = rowOf(live.render(120));
	assert.equal(liveRow, "$ ran deploy_preview · stage staging · 16B ✓ · 1.2s");

	const replayed = createChatPanel();
	rehydrateChatPanelFromTurns(replayed, [
		{
			turnId: "turn-0",
			parentTurnId: null,
			timestamp: "2026-09-17T00:00:00Z",
			kind: "message",
			role: "tool_call",
			payload: { name: "deploy_preview", toolCallId: "deploy-1", args },
		},
		{
			turnId: "turn-1",
			parentTurnId: "turn-0",
			timestamp: "2026-09-17T00:00:01Z",
			kind: "message",
			role: "tool_result",
			payload: persisted[0]?.payload,
		},
	] as SessionEntry[]);
	assert.equal(rowOf(replayed.render(120)), liveRow);
});

test("a refused skill load reads the same live and on replay, from its persisted refusal", () => {
	const persisted: Array<{ kind: string; payload: Record<string, unknown> }> = [];
	const session = {
		append(turn: { kind: string; payload: Record<string, unknown> }) {
			persisted.push(turn);
			return { id: `persisted-${persisted.length}` };
		},
		current: () => null,
	} as unknown as SessionContract;
	const persistence = createTurnPersistence({
		state: { lastTurnId: null } as ChatTurnState,
		session,
		getSettings: () => ({}) as ClioSettings,
		middlewareToolChoice: {} as MiddlewareToolChoiceControl,
		consumePersistedEcho: () => false,
		removeQueuedMirrorEntry: () => {},
		promptCachePayloadForAssistant: () => ({}),
		promptSideTokens: () => 0,
	});
	const args = { scope: "skills", name: "tech-spec" };
	const result = {
		content: [{ type: "text", text: 'context: skill "tech-spec" requires explicit operator activation.' }],
		details: { refusal: { subject: "skill", name: "tech-spec", kind: "manual-only" } },
	};
	const end = {
		type: "tool_execution_end" as const,
		toolCallId: "load-1",
		toolName: "context",
		result,
		isError: true,
		resultSummary: toolResultSummary(result),
	};
	persistence.appendToolResultTurn(end);

	const live = createChatPanel();
	live.applyEvent({ type: "tool_execution_start", toolCallId: "load-1", toolName: "context", args } as ChatLoopEvent);
	live.applyEvent(end as ChatLoopEvent);
	const plain = (lines: string[]) => lines.map(stripTerminalSequences).filter((line) => line.length > 0);
	assert.deepEqual(plain(live.render(120)), ["§ skill tech-spec not loaded · manual-only: /skill tech-spec ✗"]);

	const replayed = createChatPanel();
	rehydrateChatPanelFromTurns(replayed, [
		{
			turnId: "turn-0",
			parentTurnId: null,
			timestamp: "2026-09-17T00:00:00Z",
			kind: "message",
			role: "tool_call",
			payload: { name: "context", toolCallId: "load-1", args },
		},
		{
			turnId: "turn-1",
			parentTurnId: "turn-0",
			timestamp: "2026-09-17T00:00:01Z",
			kind: "message",
			role: "tool_result",
			payload: persisted[0]?.payload,
		},
	] as SessionEntry[]);
	assert.deepEqual(plain(replayed.render(120)), plain(live.render(120)));
});
