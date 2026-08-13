/**
 * The footer's last-turn line survived a `/tree` switch unchanged.
 *
 * `/cost` and the Σ total beside it are reseeded from the branch the transcript
 * is showing, so after a switch the footer read `✓ 610ms · ↑24 ↓3` for a turn on
 * the branch the reader had just left, next to totals that had already moved.
 * The line is now folded from the newest turn on the same active path.
 */
import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "../../src/domains/session/index.js";
import { lastTurnSummaryFromLedger } from "../../src/interactive/session-last-turn.js";

function at(minute: number, second = 0): string {
	return `2026-08-12T12:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
}

function userTurn(id: string, parentTurnId: string | null, timestamp: string): SessionEntry {
	return {
		kind: "message",
		role: "user",
		turnId: id,
		parentTurnId,
		timestamp,
		payload: { text: "go" },
	} as unknown as SessionEntry;
}

function assistantTurn(
	id: string,
	parentTurnId: string | null,
	timestamp: string,
	usage: Record<string, unknown>,
	overrides: Record<string, unknown> = {},
): SessionEntry {
	return {
		kind: "message",
		role: "assistant",
		turnId: id,
		parentTurnId,
		timestamp,
		payload: {
			text: "done",
			stopReason: "stop",
			provider: "llamacpp",
			responseModel: "Nemo-3.5-Lightning",
			usage,
			...overrides,
		},
	} as unknown as SessionEntry;
}

function toolResult(id: string, parentTurnId: string, timestamp: string, isError = false): SessionEntry {
	return {
		kind: "message",
		role: "tool_result",
		turnId: id,
		parentTurnId,
		timestamp,
		payload: { toolCallId: `${id}-call`, toolName: "view", result: "ok", isError },
	} as unknown as SessionEntry;
}

describe("contracts/last turn on the active branch", () => {
	/**
	 * u1 → a1, then a switch back to u1 and a second turn u2 → a2. The abandoned
	 * sibling stays in the append-only file and must not describe the footer.
	 */
	it("describes the newest turn on the pinned branch, not the abandoned sibling", () => {
		const branched: SessionEntry[] = [
			userTurn("u1", null, at(0)),
			assistantTurn("a1", "u1", at(0, 30), { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11 }),
			userTurn("u2", "a1", at(1)),
			assistantTurn("a2", "u2", at(1, 30), { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 22 }),
			userTurn("u3", "a1", at(2)),
			assistantTurn("a3", "u3", at(2, 12), { input: 30, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 33 }),
		];

		const onA3 = lastTurnSummaryFromLedger(branched, {}, "a3");
		strictEqual(onA3?.inputTokens, 30, "the leaf's own turn, not the file's last-written one");
		strictEqual(onA3?.outputTokens, 3);
		strictEqual(onA3?.elapsedMs, 12_000, "wall time from the submit that opened the turn");

		// Switching to the other branch moves the line with it.
		const onA2 = lastTurnSummaryFromLedger(branched, {}, "a2");
		strictEqual(onA2?.inputTokens, 20);
		strictEqual(onA2?.elapsedMs, 30_000);
	});

	it("folds the whole turn: every assistant call, its tools, and the target it ran under", () => {
		const entries: SessionEntry[] = [
			{
				kind: "modelChange",
				turnId: "m1",
				parentTurnId: null,
				timestamp: at(0),
				provider: "llamacpp",
				modelId: "Nemo-3.5-Lightning",
				target: "dynamo",
			} as unknown as SessionEntry,
			userTurn("u1", "m1", at(0, 10)),
			assistantTurn("a1", "u1", at(0, 20), {
				input: 100,
				output: 10,
				cacheRead: 40,
				cacheWrite: 5,
				reasoningTokens: 7,
				totalTokens: 155,
			}),
			// Every append parents onto the previous row, so the turn is one chain.
			toolResult("t1", "a1", at(0, 25)),
			toolResult("t2", "t1", at(0, 30), true),
			assistantTurn(
				"a2",
				"t2",
				at(0, 40),
				{ input: 200, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 220 },
				{ stopReason: "length" },
			),
		];

		const summary = lastTurnSummaryFromLedger(entries, {}, "a2");
		strictEqual(summary?.inputTokens, 300, "both calls of the turn");
		strictEqual(summary?.outputTokens, 30);
		strictEqual(summary?.cacheReadTokens, 40);
		strictEqual(summary?.cacheWriteTokens, 5);
		strictEqual(summary?.toolCount, 2);
		strictEqual(summary?.toolErrorCount, 1);
		strictEqual(summary?.stopReason, "length");
		strictEqual(summary?.targetId, "dynamo", "the target the modelChange row named, as /cost attributes it");
		strictEqual(summary?.modelId, "Nemo-3.5-Lightning");
		strictEqual(summary?.reasoningTokens, 7);
		strictEqual(summary?.reasoningTokenProvenance, "provider");
	});

	/**
	 * The ledger records provider-reported reasoning only. Estimating it back off
	 * replayed thinking text would put a number on the rescoped line that the
	 * live line never showed for the same turn.
	 */
	it("omits reasoning entirely when the provider reported none", () => {
		const summary = lastTurnSummaryFromLedger(
			[
				userTurn("u1", null, at(0)),
				assistantTurn("a1", "u1", at(0, 5), { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11 }),
			],
			{},
			"a1",
		);
		strictEqual(summary?.reasoningTokens, undefined);
		strictEqual(summary?.reasoningTokenProvenance, undefined);
	});

	it("reports nothing for a branch with no assistant reply on it", () => {
		strictEqual(lastTurnSummaryFromLedger([], {}, null), null, "an empty ledger describes no turn");
		const pending = lastTurnSummaryFromLedger([userTurn("u1", null, at(0))], {}, "u1");
		strictEqual(pending, null, "a submit with no reply yet is not a last turn");
	});

	it("follows the newest message's ancestry when no leaf is pinned", () => {
		const branched: SessionEntry[] = [
			userTurn("u1", null, at(0)),
			assistantTurn("a1", "u1", at(0, 30), { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11 }),
			userTurn("u2", "a1", at(1)),
			assistantTurn("a2", "u2", at(1, 30), { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 22 }),
			userTurn("u3", "a1", at(2)),
			assistantTurn("a3", "u3", at(2, 12), { input: 30, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 33 }),
		];
		const summary = lastTurnSummaryFromLedger(branched);
		ok(summary !== null);
		strictEqual(summary.inputTokens, 30, "the same fallback an offline read of the transcript takes");
	});
});
