/**
 * `/cost` renders a process-lifetime accumulator under a title naming a
 * session. Only `startNewSession` reset it, so resuming kept the previous
 * session's totals and relabelled them: one process, two sessions, byte-identical
 * numbers under a different id. A process that resumed and sent nothing reported
 * zero for a session holding tens of thousands of tokens on disk.
 */
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ledgerUsageCalls, type SessionEntry } from "../../src/domains/session/index.js";
import { reseedSessionUsageFromLedger } from "../../src/interactive/session-usage-reseed.js";

interface Recorded {
	providerId: string;
	modelId: string;
	tokens: number;
	costUsd?: number;
	apiCalls?: number;
}

function makeSink(): {
	sink: Parameters<typeof reseedSessionUsageFromLedger>[0];
	resets: () => number;
	calls: Recorded[];
} {
	let resets = 0;
	const calls: Recorded[] = [];
	return {
		sink: {
			resetSession: () => {
				resets += 1;
			},
			recordTokens: (providerId, modelId, tokens, costUsd, breakdown) => {
				calls.push({
					providerId,
					modelId,
					tokens,
					...(costUsd !== undefined ? { costUsd } : {}),
					...(breakdown?.apiCalls !== undefined ? { apiCalls: breakdown.apiCalls } : {}),
				});
			},
		},
		resets: () => resets,
		calls,
	};
}

function assistantTurn(payload: Record<string, unknown>, id = "a1"): SessionEntry {
	return {
		kind: "message",
		role: "assistant",
		turnId: id,
		parentTurnId: null,
		timestamp: "2026-08-12T12:00:00.000Z",
		payload,
	} as unknown as SessionEntry;
}

const completedCall = {
	text: "done",
	stopReason: "stop",
	provider: "llamacpp",
	responseModel: "Nemo-3.5-Lightning",
	usage: { input: 138, output: 3, cacheRead: 10274, cacheWrite: 0, totalTokens: 10415, cost: { total: 0.25 } },
};

describe("contracts/session usage reseed", () => {
	it("rebuilds the running totals from the resumed session's own ledger", () => {
		const { sink, resets, calls } = makeSink();
		reseedSessionUsageFromLedger(sink, [
			assistantTurn(completedCall, "a1"),
			assistantTurn({ ...completedCall, usage: { ...completedCall.usage, totalTokens: 279 } }, "a2"),
		]);

		strictEqual(resets(), 1, "the previous session's totals are cleared first");
		strictEqual(calls.length, 2, "one record per completed call");
		strictEqual(
			calls.reduce((sum, call) => sum + call.tokens, 0),
			10415 + 279,
			"the total is the session's, not the process's",
		);
		deepStrictEqual(
			calls.map((call) => call.providerId),
			["llamacpp", "llamacpp"],
		);
	});

	// The symptom from the other end: resuming into a session and sending
	// nothing must report that session's spend, not the previous one's.
	it("resets to zero for a session whose ledger holds no completed calls", () => {
		const { sink, resets, calls } = makeSink();
		reseedSessionUsageFromLedger(sink, []);
		strictEqual(resets(), 1);
		strictEqual(calls.length, 0, "an empty ledger contributes nothing, rather than carrying totals over");
	});

	/**
	 * A cancelled partial persists a fully populated all-zero usage object next
	 * to real streamed text. Counting it would add an API call worth nothing to
	 * the tally.
	 */
	it("skips cancelled and failed turns and the all-zero usage a cancel writes", () => {
		const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };
		const calls = ledgerUsageCalls([
			assistantTurn({ text: "partial", stopReason: "aborted", usage: zeroUsage }, "a1"),
			assistantTurn({ text: "[Clio Coder] active response cancelled.", stopReason: "aborted" }, "a2"),
			assistantTurn({ text: "boom", stopReason: "error", errorMessage: "upstream", usage: completedCall.usage }, "a3"),
			assistantTurn({ text: "ok", stopReason: "stop", usage: zeroUsage }, "a4"),
			assistantTurn(completedCall, "a5"),
		]);
		strictEqual(calls.length, 1, "only the one completed call with real usage counts");
		strictEqual(calls[0]?.totalTokens, 10415);
	});

	it("ignores user turns, tool rows, and assistant turns with no usage block", () => {
		const calls = ledgerUsageCalls([
			{ kind: "message", role: "user", turnId: "u1", parentTurnId: null, timestamp: "t", payload: { text: "hi" } },
			{
				kind: "message",
				role: "tool_result",
				turnId: "t1",
				parentTurnId: "u1",
				timestamp: "t",
				payload: { toolCallId: "c", result: {}, usage: completedCall.usage },
			},
			assistantTurn({ text: "no usage recorded", stopReason: "stop" }, "a1"),
			assistantTurn(completedCall, "a2"),
		] as unknown as SessionEntry[]);
		strictEqual(calls.length, 1);
	});

	/**
	 * The live path records under the target id and the wire model. Reading the
	 * runtime out of the payload instead split one endpoint into two blocks in
	 * /cost, so a single `dynamo` target on `llamacpp` rendered as two providers
	 * whose turn counts diverged with every resume.
	 */
	it("attributes reseeded calls to the target, matching how live turns are recorded", () => {
		const calls = ledgerUsageCalls([assistantTurn(completedCall, "a1")], {
			target: "dynamo",
			model: "Nemo-3.5-Lightning",
		});
		strictEqual(calls[0]?.providerId, "dynamo", "not the runtime name from the payload");
		strictEqual(calls[0]?.modelId, "Nemo-3.5-Lightning");
	});

	it("follows a modelChange row so a session that switched targets attributes each call correctly", () => {
		const calls = ledgerUsageCalls(
			[
				assistantTurn(completedCall, "a1"),
				{
					kind: "modelChange",
					turnId: "m1",
					parentTurnId: "a1",
					timestamp: "t",
					provider: "lmstudio",
					modelId: "gemma-4",
					target: "mini",
				},
				assistantTurn(completedCall, "a2"),
			] as unknown as SessionEntry[],
			{ target: "dynamo", model: "Nemo-3.5-Lightning" },
		);
		deepStrictEqual(
			calls.map((call) => `${call.providerId}/${call.modelId}`),
			["dynamo/Nemo-3.5-Lightning", "mini/gemma-4"],
		);
	});

	it("falls back to the payload's own provider when the session names no target", () => {
		const calls = ledgerUsageCalls([assistantTurn(completedCall, "a1")]);
		strictEqual(calls[0]?.providerId, "llamacpp");
	});

	it("derives a total when the provider reported only the component counts", () => {
		const calls = ledgerUsageCalls([
			assistantTurn({ stopReason: "stop", usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1 } }, "a1"),
		]);
		strictEqual(calls[0]?.totalTokens, 126);
	});
});
