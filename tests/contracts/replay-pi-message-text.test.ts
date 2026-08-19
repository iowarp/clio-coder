import { deepStrictEqual, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { convertToLlm } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { buildReplayAgentMessagesFromTurns } from "../../src/interactive/chat-renderer.js";

function base(id: string, parentTurnId: string | null): Pick<SessionEntry, "turnId" | "parentTurnId" | "timestamp"> {
	return { turnId: id, parentTurnId, timestamp: `2026-06-08T00:00:${id.padStart(2, "0")}.000Z` };
}

function textOf(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
		.join("");
}

/**
 * The model sees Clio's ledger entries as the same text pi's `convertToLlm`
 * would produce for pi's own bashExecution, branchSummary, and
 * compactionSummary messages. pi owns that wording; Clio only maps its
 * entry shapes onto it.
 */
describe("contracts/replay-pi-message-text", () => {
	it("replays bash, branch summary, and compaction summary entries with pi's wording", () => {
		const entries: SessionEntry[] = [
			{ kind: "message", ...base("01", null), role: "user", payload: { text: "start" } },
			{
				kind: "bashExecution",
				...base("02", "01"),
				command: "ls -la",
				output: "total 0\n",
				exitCode: 2,
				cancelled: false,
				truncated: true,
				fullOutputPath: "/tmp/full.txt",
			},
			{ kind: "branchSummary", ...base("03", "02"), fromTurnId: "01", summary: "branch notes" },
			{
				kind: "compactionSummary",
				...base("04", "03"),
				summary: "## Goal\nolder context",
				tokensBefore: 1000,
				firstKeptTurnId: "02",
				trigger: "manual",
			},
			{ kind: "message", ...base("05", "04"), role: "user", payload: { text: "continue" } },
		];

		const replay = buildReplayAgentMessagesFromTurns(entries).map(textOf);
		const expected = convertToLlm([
			{
				role: "bashExecution",
				command: "ls -la",
				output: "total 0\n",
				exitCode: 2,
				cancelled: false,
				truncated: true,
				fullOutputPath: "/tmp/full.txt",
				timestamp: 0,
			},
			{ role: "branchSummary", summary: "branch notes", fromId: "01", timestamp: 0 },
			{ role: "compactionSummary", summary: "## Goal\nolder context", tokensBefore: 1000, timestamp: 0 },
		]).map(textOf);

		ok(expected.length === 3, `pi should convert all three custom messages, got ${expected.length}`);
		for (const text of expected) {
			ok(
				replay.some((line) => line === text.trim()),
				`replay must carry pi's text verbatim:\n${text}\n--- replay ---\n${replay.join("\n===\n")}`,
			);
		}
		deepStrictEqual(replay.at(-1), "continue");
	});
});
