import { deepStrictEqual, ok } from "node:assert/strict";
import { test } from "node:test";
import { EVENTS } from "../../src/core/telemetry/events.js";
import { countVerifiedOutcomes } from "../../src/domains/evidence/verified-outcomes.js";
import { INSIGHT_RECORD_KINDS, outcomeLedgerProjection } from "../../src/domains/telemetry/insights.js";

const SECRET = "SENTINEL-CONTENT-7f3a";

test("telemetry insights reads only content-free records and a text-free projection of the ledger", () => {
	for (const kind of INSIGHT_RECORD_KINDS) {
		// Typecheck already refuses a content kind; this pins the registry the types are read from.
		const { cc, tier }: { cc: string; tier: string } = EVENTS[kind];
		ok(cc !== "content-bearing" && tier !== "research", `${kind} is content`);
	}
	const at = "2026-11-06T00:00:00.000Z";
	const base = { turnId: "turn-1", parentTurnId: null, timestamp: at };
	const ledger = [
		{ ...base, kind: "message", role: "user", payload: { content: SECRET } },
		{ ...base, kind: "message", role: "tool_call", payload: { name: "write", args: { path: `${SECRET}.tex` } } },
		{
			...base,
			kind: "message",
			role: "tool_result",
			payload: {
				toolName: "verify",
				isError: false,
				content: SECRET,
				result: {
					output: SECRET,
					details: {
						check: "fit",
						stdout: SECRET,
						report: { kind: "reproduce", passed: true, actual: { sha256: "a", preview: SECRET }, note: SECRET },
						judgement: { execution: "succeeded", validation: "passed", reason: SECRET },
					},
				},
			},
		},
		{
			...base,
			kind: "taskLedger",
			boardId: "board-1",
			activeRunIds: [],
			timestamp: "2026-11-06T00:01:00.000Z",
			goals: [{ id: "board", title: SECRET, status: "completed" }],
			subgoals: [{ id: "t1", title: SECRET, description: SECRET, status: "completed", parentGoalId: "board" }],
			requiredValidationEvidence: [
				{
					id: "t1.observed.0",
					description: SECRET,
					command: SECRET,
					status: "passed",
					observedAt: "2026-11-06T00:00:30.000Z",
				},
			],
		},
	];
	const projected = ledger.map(outcomeLedgerProjection).filter((entry) => entry !== null);
	ok(!JSON.stringify(projected).includes(SECRET));
	deepStrictEqual(countVerifiedOutcomes(projected, new Set()), countVerifiedOutcomes(ledger, new Set()));
	deepStrictEqual(countVerifiedOutcomes(projected, new Set()).total, 2);
});
