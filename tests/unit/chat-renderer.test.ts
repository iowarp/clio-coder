import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioTurnRecord } from "../../src/engine/session.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { rehydrateChatPanelFromTurns } from "../../src/interactive/chat-renderer.js";

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
		ok(text.includes("clio: hello"), `missing first assistant:\n${text}`);
		ok(text.includes("you: next"), `missing second user:\n${text}`);
		ok(text.includes("clio: response"), `missing second assistant:\n${text}`);
		ok(text.indexOf("you: hi") < text.indexOf("clio: response"), "turn order preserved");
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
		ok(text.includes("clio: reply1"), text);
		ok(!text.includes("second"), `post-fork content leaked: ${text}`);
		ok(!text.includes("reply2"), `post-fork content leaked: ${text}`);
	});

	it("skips tool_call, tool_result, system, and checkpoint turns", () => {
		// The first rehydrate pass handles message turns only. Tool previews
		// rehydrate in a later slice once entry storage carries enough data to
		// reconstruct the paired start/end events.
		const panel = createChatPanel();
		const turns: ClioTurnRecord[] = [
			mkTurn({ id: "u1", kind: "user", payload: { text: "hi" } }),
			mkTurn({ id: "s1", kind: "system", payload: { text: "system boot" } }),
			mkTurn({ id: "t1", kind: "tool_call", payload: { name: "ls" } }),
			mkTurn({ id: "tr1", kind: "tool_result", payload: { out: "x" } }),
			mkTurn({ id: "c1", kind: "checkpoint", payload: { reason: "manual" } }),
			mkTurn({ id: "a1", kind: "assistant", payload: { text: "done" } }),
		];
		rehydrateChatPanelFromTurns(panel, turns);
		const text = strip(panel.render(80).join("\n"));
		ok(text.includes("you: hi"), text);
		ok(text.includes("clio: done"), text);
		ok(!text.includes("system boot"), `system turn leaked: ${text}`);
		ok(!text.includes("ls"), `tool_call leaked: ${text}`);
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
		ok(text.includes("clio: structured-assistant"), text);
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
});
