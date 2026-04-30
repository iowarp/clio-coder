import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { ClioTurnRecord } from "../../src/engine/session.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import {
	buildReplayAgentMessagesFromTurns,
	rehydrateChatPanelFromTurns,
	selectReplayEntries,
} from "../../src/interactive/chat-renderer.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
function strip(s: string): string {
	return s.replace(ANSI, "");
}

function mkTurn(overrides: Partial<ClioTurnRecord>): ClioTurnRecord {
	return {
		id: "t0",
		parentId: null,
		at: "2026-04-23T00:00:00.000Z",
		kind: "user",
		payload: { text: "hi" },
		...overrides,
	};
}

describe("rehydrateChatPanelFromTurns", () => {
	it("replays interleaved user and assistant turns in order", () => {
		const panel = createChatPanel();
		const turns: ClioTurnRecord[] = [
			mkTurn({ id: "u1", kind: "user", payload: { text: "hi" } }),
			mkTurn({ id: "a1", kind: "assistant", payload: { text: "hello" } }),
			mkTurn({ id: "u2", kind: "user", payload: { text: "next" } }),
			mkTurn({ id: "a2", kind: "assistant", payload: { text: "response" } }),
		];
		rehydrateChatPanelFromTurns(panel, turns);
		const text = strip(panel.render(80).join("\n"));
		ok(text.includes("you: hi"), `missing first user line:\n${text}`);
		ok(text.includes("Clio Coder: hello"), `missing first assistant:\n${text}`);
		ok(text.includes("you: next"), `missing second user:\n${text}`);
		ok(text.includes("Clio Coder: response"), `missing second assistant:\n${text}`);
		ok(text.indexOf("you: hi") < text.indexOf("Clio Coder: response"), "turn order preserved");
	});

	it("stops after uptoTurnId inclusive so fork replay drops the post-fork tail", () => {
		const panel = createChatPanel();
		const turns: ClioTurnRecord[] = [
			mkTurn({ id: "u1", kind: "user", payload: { text: "first" } }),
			mkTurn({ id: "a1", kind: "assistant", payload: { text: "reply1" } }),
			mkTurn({ id: "u2", kind: "user", payload: { text: "second" } }),
			mkTurn({ id: "a2", kind: "assistant", payload: { text: "reply2" } }),
		];
		rehydrateChatPanelFromTurns(panel, turns, { uptoTurnId: "a1" });
		const text = strip(panel.render(80).join("\n"));
		ok(text.includes("you: first"), text);
		ok(text.includes("Clio Coder: reply1"), text);
		ok(!text.includes("second"), `post-fork content leaked: ${text}`);
		ok(!text.includes("reply2"), `post-fork content leaked: ${text}`);
	});

	it("renders tool_call, tool_result, system, and checkpoint turns", () => {
		const panel = createChatPanel();
		const turns: ClioTurnRecord[] = [
			mkTurn({ id: "u1", kind: "user", payload: { text: "hi" } }),
			mkTurn({ id: "s1", kind: "system", payload: { text: "system boot" } }),
			mkTurn({ id: "t1", kind: "tool_call", payload: { id: "call-1", name: "ls", args: { path: "." } } }),
			mkTurn({ id: "tr1", kind: "tool_result", payload: { toolCallId: "call-1", out: "x" } }),
			mkTurn({ id: "c1", kind: "checkpoint", payload: { reason: "manual" } }),
			mkTurn({ id: "a1", kind: "assistant", payload: { text: "done" } }),
		];
		rehydrateChatPanelFromTurns(panel, turns);
		const text = strip(panel.render(80).join("\n"));
		ok(text.includes("you: hi"), text);
		ok(text.includes("Clio Coder: done"), text);
		ok(text.includes("system: system boot"), text);
		ok(text.includes("▸ ls(.)"), text);
		ok(text.includes("│ x"), text);
		ok(text.includes("[checkpoint]"), text);
	});

	it("accepts bare-string payloads and {content:[{type:text}]} shapes", () => {
		const panel = createChatPanel();
		const turns: ClioTurnRecord[] = [
			mkTurn({ id: "u1", kind: "user", payload: "raw-string-user" }),
			mkTurn({
				id: "a1",
				kind: "assistant",
				payload: { content: [{ type: "text", text: "structured-assistant" }] },
			}),
		];
		rehydrateChatPanelFromTurns(panel, turns);
		const text = strip(panel.render(80).join("\n"));
		ok(text.includes("you: raw-string-user"), text);
		ok(text.includes("Clio Coder: structured-assistant"), text);
	});

	it("rehydrates persisted assistant thinking content instead of reducing the turn to text", () => {
		const panel = createChatPanel();
		const turns: ClioTurnRecord[] = [
			mkTurn({ id: "u1", kind: "user", payload: { text: "inspect this" } }),
			mkTurn({
				id: "a1",
				kind: "assistant",
				payload: {
					content: [
						{ type: "thinking", thinking: "Need to read the exact payload shape." },
						{ type: "text", text: "I will inspect the payload." },
					],
					text: "I will inspect the payload.",
					thinking: "Need to read the exact payload shape.",
				},
			}),
		];
		rehydrateChatPanelFromTurns(panel, turns);
		const text = strip(panel.render(96).join("\n"));
		ok(text.includes("thinking: Need to read"), text);
		ok(text.includes("Clio Coder: I will inspect the payload."), text);
	});

	it("skips empty-text turns silently without producing blank entries", () => {
		const panel = createChatPanel();
		const turns: ClioTurnRecord[] = [
			mkTurn({ id: "u1", kind: "user", payload: { text: "" } }),
			mkTurn({ id: "u2", kind: "user", payload: { text: "real" } }),
		];
		rehydrateChatPanelFromTurns(panel, turns);
		const text = strip(panel.render(80).join("\n"));
		ok(text.includes("you: real"), text);
		strictEqual((text.match(/you:/g) ?? []).length, 1, `extra user lines in:\n${text}`);
	});

	it("renders branch and compaction summary entries and keeps the compacted suffix", () => {
		const panel = createChatPanel();
		const entries: SessionEntry[] = [
			{
				kind: "message",
				turnId: "u1",
				parentTurnId: null,
				timestamp: "2026-04-23T00:00:00.000Z",
				role: "user",
				payload: { text: "old prompt" },
			},
			{
				kind: "message",
				turnId: "a1",
				parentTurnId: "u1",
				timestamp: "2026-04-23T00:00:01.000Z",
				role: "assistant",
				payload: { text: "old answer" },
			},
			{
				kind: "message",
				turnId: "u2",
				parentTurnId: "a1",
				timestamp: "2026-04-23T00:00:02.000Z",
				role: "user",
				payload: { text: "kept prompt" },
			},
			{
				kind: "branchSummary",
				turnId: "b1",
				parentTurnId: "u2",
				timestamp: "2026-04-23T00:00:03.000Z",
				fromTurnId: "fork-source",
				summary: "Inherited branch work.",
			},
			{
				kind: "compactionSummary",
				turnId: "c1",
				parentTurnId: "u2",
				timestamp: "2026-04-23T00:00:04.000Z",
				summary: "Old prompt and answer were compacted.",
				tokensBefore: 1234,
				firstKeptTurnId: "u2",
			},
			{
				kind: "message",
				turnId: "a2",
				parentTurnId: "c1",
				timestamp: "2026-04-23T00:00:05.000Z",
				role: "assistant",
				payload: { text: "after compaction" },
			},
		];
		rehydrateChatPanelFromTurns(panel, entries);
		const text = strip(panel.render(96).join("\n"));
		ok(text.includes("[compaction summary]"), text);
		ok(text.includes("Old prompt and answer were compacted."), text);
		ok(text.includes("you: kept prompt"), text);
		ok(text.includes("[branch summary]"), text);
		ok(text.includes("Inherited branch work."), text);
		ok(text.includes("Clio Coder: after compaction"), text);
		ok(!text.includes("you: old prompt"), `pre-compaction prefix leaked:\n${text}`);

		const selected = selectReplayEntries(entries).map((entry) => entry.turnId);
		strictEqual(selected.join(","), "c1,u2,b1,a2");
	});

	it("builds replay agent messages from entry-aware replay selection", () => {
		const entries: SessionEntry[] = [
			{
				kind: "message",
				turnId: "u1",
				parentTurnId: null,
				timestamp: "2026-04-23T00:00:00.000Z",
				role: "user",
				payload: { text: "hidden old prompt" },
			},
			{
				kind: "compactionSummary",
				turnId: "c1",
				parentTurnId: "u1",
				timestamp: "2026-04-23T00:00:01.000Z",
				summary: "Use the summary instead.",
				tokensBefore: 999,
				firstKeptTurnId: "missing-kept",
			},
			{
				kind: "bashExecution",
				turnId: "b1",
				parentTurnId: "c1",
				timestamp: "2026-04-23T00:00:02.000Z",
				command: "npm test",
				output: "ok",
				exitCode: 0,
				cancelled: false,
				truncated: false,
			},
		];
		const messages = buildReplayAgentMessagesFromTurns(entries);
		const serialized = JSON.stringify(messages);
		ok(serialized.includes("Use the summary instead."), serialized);
		ok(serialized.includes("Ran `npm test`"), serialized);
		ok(!serialized.includes("hidden old prompt"), serialized);
	});

	it("replays retry status entries and excludes failed assistant attempts from model context", () => {
		const panel = createChatPanel();
		const entries: SessionEntry[] = [
			{
				kind: "message",
				turnId: "u1",
				parentTurnId: null,
				timestamp: "2026-04-24T00:00:00.000Z",
				role: "user",
				payload: { text: "hello" },
			},
			{
				kind: "message",
				turnId: "a1",
				parentTurnId: "u1",
				timestamp: "2026-04-24T00:00:01.000Z",
				role: "assistant",
				payload: { text: "", stopReason: "error", errorMessage: "rate limit 429" },
			},
			{
				kind: "custom",
				turnId: "r1",
				parentTurnId: "a1",
				timestamp: "2026-04-24T00:00:02.000Z",
				customType: "retryStatus",
				display: true,
				data: { phase: "scheduled", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "rate limit 429" },
			},
			{
				kind: "message",
				turnId: "a2",
				parentTurnId: "a1",
				timestamp: "2026-04-24T00:00:03.000Z",
				role: "assistant",
				payload: { text: "ok now" },
			},
		];
		rehydrateChatPanelFromTurns(panel, entries);
		const text = strip(panel.render(96).join("\n"));
		ok(text.includes("Clio Coder: [error] rate limit 429"), text);
		ok(text.includes("[retry] attempt 1/3 scheduled in 2s: rate limit 429"), text);
		ok(text.includes("Clio Coder: ok now"), text);

		const serialized = JSON.stringify(buildReplayAgentMessagesFromTurns(entries));
		ok(!serialized.includes("rate limit 429"), serialized);
		ok(serialized.includes("ok now"), serialized);
	});

	it("replays rich assistant content and real tool results without duplicating sidecar tool_call entries", () => {
		const entries: SessionEntry[] = [
			{
				kind: "message",
				turnId: "u1",
				parentTurnId: null,
				timestamp: "2026-04-24T00:00:00.000Z",
				role: "user",
				payload: { text: "read package" },
			},
			{
				kind: "message",
				turnId: "a1",
				parentTurnId: "u1",
				timestamp: "2026-04-24T00:00:01.000Z",
				role: "assistant",
				payload: {
					text: "I will read it.",
					content: [
						{ type: "thinking", thinking: "Need package metadata." },
						{ type: "text", text: "I will read it." },
						{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "package.json" } },
					],
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } },
				},
			},
			{
				kind: "message",
				turnId: "tc1",
				parentTurnId: "a1",
				timestamp: "2026-04-24T00:00:02.000Z",
				role: "tool_call",
				payload: { toolCallId: "call-1", name: "read", args: { path: "package.json" } },
			},
			{
				kind: "message",
				turnId: "tr1",
				parentTurnId: "tc1",
				timestamp: "2026-04-24T00:00:03.000Z",
				role: "tool_result",
				payload: {
					toolCallId: "call-1",
					toolName: "read",
					result: { content: [{ type: "text", text: '{"name":"clio-coder"}' }] },
					isError: false,
				},
			},
		];

		const messages = buildReplayAgentMessagesFromTurns(entries);
		const serialized = JSON.stringify(messages);
		ok(serialized.includes("Need package metadata."), serialized);
		ok(serialized.includes('"type":"toolCall"'), serialized);
		ok(serialized.includes('"role":"toolResult"'), serialized);
		ok(serialized.includes("clio-coder"), serialized);
		strictEqual((serialized.match(/"type":"toolCall"/g) ?? []).length, 1, serialized);
	});

	it("replays protected artifact entries without injecting them into model context", () => {
		const panel = createChatPanel();
		const entries: SessionEntry[] = [
			{
				kind: "protectedArtifact",
				turnId: "pa1",
				parentTurnId: null,
				timestamp: "2026-04-24T00:00:00.000Z",
				action: "protect",
				artifact: {
					path: "dist/report.txt",
					protectedAt: "2026-04-24T00:00:00.000Z",
					reason: "validation passed",
					validationCommand: "npm test",
					validationExitCode: 0,
					source: "session",
				},
			},
			{
				kind: "message",
				turnId: "u1",
				parentTurnId: "pa1",
				timestamp: "2026-04-24T00:00:01.000Z",
				role: "user",
				payload: { text: "continue" },
			},
		];

		rehydrateChatPanelFromTurns(panel, entries);
		const text = strip(panel.render(96).join("\n"));
		ok(text.includes("[protected] dist/report.txt after npm test exit 0: validation passed"), text);
		ok(text.includes("you: continue"), text);

		const serialized = JSON.stringify(buildReplayAgentMessagesFromTurns(entries));
		ok(!serialized.includes("dist/report.txt"), serialized);
		ok(serialized.includes("continue"), serialized);
	});
});
