import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { compact } from "../../src/domains/session/compaction/compact.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { Model } from "../../src/engine/types.js";

describe("contracts/skill activation compaction protection", () => {
	it("keeps the active skill turn instead of summarizing it away", async () => {
		const entries: SessionEntry[] = [
			{
				kind: "message",
				turnId: "turn-skill",
				parentTurnId: null,
				timestamp: "2026-06-06T00:00:00.000Z",
				role: "user",
				payload: { text: '<skill name="active-skill">Keep this active skill body.</skill>\n\nDo the task.' },
			},
			{
				kind: "skillActivation",
				turnId: "activation-1",
				parentTurnId: "turn-skill",
				timestamp: "2026-06-06T00:00:01.000Z",
				activation: {
					name: "active-skill",
					filePath: "/repo/.clio/skills/active-skill/SKILL.md",
					hash: "a".repeat(64),
					source: "clio",
					triggeredBy: "slash-command",
					turnId: "turn-skill",
				},
			},
			{
				kind: "message",
				turnId: "assistant-1",
				parentTurnId: "turn-skill",
				timestamp: "2026-06-06T00:00:02.000Z",
				role: "assistant",
				payload: { text: "Acknowledged." },
			},
		];

		const result = await compact({
			entries,
			model: {} as Model<never>,
			keepRecentTokens: 1,
		});

		strictEqual(result.summary, "");
		strictEqual(result.messagesSummarized, 0);
		strictEqual(result.firstKeptEntryIndex, 0);
		strictEqual(result.firstKeptTurnId, "turn-skill");
		strictEqual(result.isSplitTurn, false);
	});
});
