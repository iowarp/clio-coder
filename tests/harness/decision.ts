import { strictEqual } from "node:assert/strict";
import { createDecisionBoardStore } from "../../src/domains/session/decision-board.js";
import type { DecisionLedgerEntry } from "../../src/domains/session/entries.js";
import { createDecideTool } from "../../src/tools/decide.js";

/** A persisted record produced by the real decide tool, before the receipt fixture's run window. */
export async function agentDecision(parentTurnId = "root", key = "cache-key"): Promise<DecisionLedgerEntry> {
	const entries: DecisionLedgerEntry[] = [];
	const board = createDecisionBoardStore({
		getSessionId: () => "session-1",
		readEntries: () => entries,
		getActiveLeafTurnId: () => parentTurnId,
		appendEntry: (entry) => {
			entries.push({ ...entry, turnId: `decision-${key}`, timestamp: "2026-06-25T11:00:00.000Z" });
		},
		now: () => new Date("2026-06-25T11:00:00.000Z"),
	});
	const result = await createDecideTool({ decisionBoard: board }).run({
		key,
		value: "capability tuple",
		alternatives: ["node id in src/cache.ts", "fleet hash"],
		rationale: "src/cache.ts needs keys that survive fleet changes",
	});
	strictEqual(result.kind, "ok", JSON.stringify(result));
	const entry = entries[0];
	if (!entry) throw new Error("decide did not append a record");
	return entry;
}
