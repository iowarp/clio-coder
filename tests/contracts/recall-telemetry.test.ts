import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { RecallTrigger, SessionEntry } from "../../src/domains/session/entries.js";
import {
	foldRecallTelemetry,
	formatRecallTelemetry,
	hasRecallTelemetry,
} from "../../src/domains/session/recall-telemetry.js";

let sequence = 0;
function recall(trigger: RecallTrigger, tokensReadmitted: number): SessionEntry {
	sequence += 1;
	return {
		kind: "contextRecall",
		turnId: `recall-${sequence}`,
		parentTurnId: null,
		timestamp: "2026-10-30T00:00:00.000Z",
		ref: { entry: `r${sequence}` },
		trigger,
		tokensReadmitted,
	};
}

const userMessage: SessionEntry = {
	kind: "message",
	role: "user",
	turnId: "user-1",
	parentTurnId: null,
	timestamp: "2026-10-30T00:00:00.000Z",
	payload: { text: "hello" },
};

// #422: a tool recall and a reread send the body back into the model's
// context and are billed on the following requests; an operator recall goes
// to the transcript only, so it is counted without its tokens.
test("folds recalls by trigger and bills only tool recalls and rereads", () => {
	const telemetry = foldRecallTelemetry([
		userMessage,
		recall("tool", 512),
		recall("reread", 300),
		recall("operator", 40_000),
		recall("tool", Number.NaN),
		recall("tool", -8),
	]);
	deepStrictEqual(telemetry, { toolRecalls: 3, rereads: 1, operatorRecalls: 1, readmittedTokens: 812 });
	strictEqual(hasRecallTelemetry(telemetry), true);
	strictEqual(formatRecallTelemetry(telemetry), "812 tokens · 3 recalls · 1 reread");
});

test("a slice without recalls reports nothing to show", () => {
	const telemetry = foldRecallTelemetry([userMessage]);
	deepStrictEqual(telemetry, { toolRecalls: 0, rereads: 0, operatorRecalls: 0, readmittedTokens: 0 });
	strictEqual(hasRecallTelemetry(telemetry), false);
});

test("an operator-only slice counts as telemetry with zero billed tokens", () => {
	const telemetry = foldRecallTelemetry([recall("operator", 1_000)]);
	strictEqual(hasRecallTelemetry(telemetry), true);
	strictEqual(telemetry.readmittedTokens, 0);
	strictEqual(formatRecallTelemetry(telemetry), "0 tokens · 0 recalls");
});
