import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { rehydrateChatPanelFromTurns } from "../../src/interactive/chat-renderer.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const strip = (s: string): string => s.replace(ANSI, "");

// A grep tool_result as the on-disk ledger stores it: the full text body plus a
// structured observation envelope in `details` (match/byte counts, offload
// path). The live collapsed ledger line is derived from that envelope.
function grepReplayTurns(): unknown[] {
	const lines: string[] = [];
	for (let i = 1; i <= 261; i += 1) lines.push(`many.txt:${i}: e match line ${String(i).padStart(4, "0")}`);
	const body = `${lines.join("\n")}\n[grep: 261/261+ matches shown (16.0KB of 186.4KB) | full: /state/scratch/x.txt | next: limit=6000]`;
	const observation = {
		unit: "matches",
		shownCount: 261,
		totalCount: null,
		shownBytes: 16100,
		offloadPath: "/state/scratch/x.txt",
	};
	const ts = "2026-07-02T12:00:00.000Z";
	return [
		{
			kind: "message",
			role: "user",
			turnId: "u1",
			parentTurnId: null,
			timestamp: ts,
			payload: { text: "grep e in src" },
		},
		{
			kind: "message",
			role: "tool_call",
			turnId: "a1",
			parentTurnId: "u1",
			timestamp: ts,
			payload: { toolCallId: "g1", toolName: "grep", args: { pattern: "e", path: "src", limit: 3000 } },
		},
		{
			kind: "message",
			role: "tool_result",
			turnId: "a2",
			parentTurnId: "a1",
			timestamp: ts,
			payload: {
				toolCallId: "g1",
				toolName: "grep",
				result: { content: [{ type: "text", text: body }], details: { observation } },
				isError: false,
				durationMs: 114,
			},
		},
		{ kind: "message", role: "assistant", turnId: "a3", parentTurnId: "a2", timestamp: ts, payload: { text: "done" } },
	];
}

describe("contracts/resume replay ledger fidelity", () => {
	it("replays a grep tool as the collapsed one-line ledger summary, not the expanded body", () => {
		const panel = createChatPanel();
		rehydrateChatPanelFromTurns(panel, grepReplayTurns());
		const rendered = strip(panel.render(100).join("\n"));

		// Collapsed live-parity ledger line: grep verb + outcome facts from the
		// observation envelope (count, bytes, offload path).
		ok(rendered.includes("searching for"), "collapsed grep subline should show the grep verb");
		ok(rendered.includes("261+ matches"), "collapsed line should carry the match count from the observation envelope");
		ok(rendered.includes("full: /state/scratch/x.txt"), "collapsed line should carry the offload path");

		// The expanded body and its UI middle-elision must not appear in replay.
		ok(!rendered.includes("many.txt:1:"), "replay must not render the expanded grep body");
		ok(!rendered.includes("lines hidden"), "replay must not carry the expanded body's middle-elision");
	});
});
