/**
 * End-to-end compaction flow on a populated session.
 *
 * Slice B4 regression: `/compact` used to short-circuit with
 * "nothing to compact" on populated-but-below-20k-token sessions because
 * `findCutPoint` initialized `cutIndex` to the oldest valid cut. That left
 * `pre` empty in `compact()` and the orchestrator returned an empty summary
 * with `messagesSummarized = 0`.
 *
 * This test builds a ten-turn session sized well under `keepRecentTokens`,
 * wires a faux pi-ai model that returns a canned structured summary, and
 * asserts the compaction pipeline produces a non-empty summary covering the
 * older turns. Failure before the fix: `messagesSummarized === 0`,
 * `summary === ""`.
 */
import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { compact } from "../../src/domains/session/compaction/compact.js";
import { findCutPoint } from "../../src/domains/session/compaction/cut-point.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { fauxAssistantMessage, registerFauxProvider } from "../../src/engine/ai.js";
import type { Model } from "../../src/engine/types.js";

function userTurn(i: number): SessionEntry {
	return {
		kind: "message",
		turnId: `u${i}`,
		parentTurnId: i === 0 ? null : `a${i - 1}`,
		timestamp: "2026-04-23T00:00:00.000Z",
		role: "user",
		payload: { text: `user turn ${i}: please help with step ${i} of the task` },
	};
}

function assistantTurn(i: number): SessionEntry {
	return {
		kind: "message",
		turnId: `a${i}`,
		parentTurnId: `u${i}`,
		timestamp: "2026-04-23T00:00:01.000Z",
		role: "assistant",
		payload: { text: `assistant reply ${i}: acknowledged step ${i}, continuing` },
	};
}

describe("compaction flow on a populated sub-threshold session", () => {
	it("produces a non-empty summary and summarizes older turns", async () => {
		const faux = registerFauxProvider({
			provider: "faux-compaction-b4",
			models: [{ id: "faux-compactor", contextWindow: 200_000 }],
		});
		try {
			faux.setResponses([
				fauxAssistantMessage(
					[
						"## Goal",
						"Populated session compaction regression fixture",
						"",
						"## Progress",
						"### Done",
						"- [x] Ten user/assistant turns covered",
					].join("\n"),
					{ stopReason: "stop" },
				),
			]);
			const model = faux.getModel() as unknown as Model<never>;

			const entries: SessionEntry[] = [];
			for (let i = 0; i < 10; i++) {
				entries.push(userTurn(i));
				entries.push(assistantTurn(i));
			}

			const cut = findCutPoint(entries, 20_000);
			ok(cut.firstKeptEntryIndex > 0, `expected cut past index 0, got ${cut.firstKeptEntryIndex}`);

			const result = await compact({ entries, model });
			ok(
				result.messagesSummarized > 0,
				`expected messagesSummarized > 0 on populated session, got ${result.messagesSummarized}`,
			);
			ok(result.summary.length > 0, "expected non-empty summary from compaction model");
			strictEqual(typeof result.firstKeptTurnId, "string");
			ok(result.summary.includes("## Goal"), "faux model summary should flow through textFromAssistant unchanged");
		} finally {
			faux.unregister();
		}
	});
});
