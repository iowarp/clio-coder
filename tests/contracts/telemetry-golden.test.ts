/**
 * P0.9 golden (#434): a legacy ledger shaped like the #423 incident replays
 * through import-legacy and the shared fold without the P0 lies: never-sent is
 * not spent (L2), unknown is never zero (L1, L3), unmeasured is never false
 * (L6), a budget wait is never a stall, and an unpriced route never ranks cheapest.
 */
import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { CallSettled } from "../../src/core/telemetry/schemas.js";
import type { RouteObservation } from "../../src/domains/dispatch/route-policy.js";
import { estimateRoute, routeObservationFromHistory } from "../../src/domains/dispatch/route-policy.js";
import { aggregateCostAmounts, renderCostAggregate } from "../../src/domains/observability/cost.js";
import { foldCallJournal } from "../../src/domains/observability/folds.js";
import { isSessionEntry } from "../../src/domains/session/entries.js";
import { usageCallsFromJournal } from "../../src/domains/session/journal-usage.js";
import { importLegacySession } from "../../src/domains/session/legacy-import.js";

const ledger = readFileSync(new URL("../fixtures/telemetry/golden/p0/current.jsonl", import.meta.url), "utf8")
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line) as unknown)
	.filter(isSessionEntry);
const imported = importLegacySession("golden-p0", ledger);
const settled = imported.records.flatMap((record) => (record.k === "call.settled" ? [record.data as CallSettled] : []));

test("dispositions and causes come from recorded facts, and a budget wait is never a stall", () => {
	strictEqual(imported.invalid, 0);
	deepStrictEqual(
		settled.map((call) => call.disposition),
		["settled", "never_sent", "sent_unsettled", "settled_no_usage", "settled"],
	);
	const [, budget, dropped, rejected] = settled;
	ok(budget && dropped && rejected);
	strictEqual(budget.usage, null, "L2: the stale 300K estimate is not carried");
	strictEqual(budget.pricing.usd.kind, "absent");
	strictEqual(budget.stop.failure, "budget_wait_aborted");
	ok(settled.every((call) => !call.stop.failure?.startsWith("stall_")));
	strictEqual(dropped.stop.failure, "transport_dropped");
	strictEqual(dropped.usage?.input.kind, "unknown", "L1: placeholder zeros on a dropped stream stay unknown");
	strictEqual(rejected.stop.failure, "auth_rejected");
});

test("an out-of-turn error row keeps its recorded tokens and cost as a lower bound (#434)", () => {
	const row = {
		sessionId: "side",
		label: "side-question" as const,
		repoIdentity: null,
		timestamp: "2026-10-20T12:00:00.000Z",
		target: "fixture",
		attributedModelId: "model",
		callOutcome: "error" as const,
		usage: { input: 300, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null, totalTokens: 300, costUsd: 0.01 },
	};
	const unrecorded = { ...row, usage: { ...row.usage, input: null, totalTokens: null, costUsd: null } };
	const records = importLegacySession("side", [], {
		outOfTurn: [row, unrecorded],
		costProvenance: "known",
	}).records;
	const calls = records.flatMap((record) => (record.k === "call.settled" ? [record.data as CallSettled] : []));
	deepStrictEqual(
		calls.map((call) => call.disposition),
		["sent_unsettled", "sent_unsettled"],
		"a usage report is not evidence that the response ended",
	);
	deepStrictEqual(calls[0]?.usage?.input, { kind: "measured", value: 300, source: "provider" });
	strictEqual(calls[0]?.usage?.output.kind, "unknown", "a zero where the stream stopped is not a measured zero");
	deepStrictEqual(
		calls.map((call) => call.pricing.usd.kind === "measured" && call.pricing.usd.value),
		[0.01, false],
	);
	const totals = foldCallJournal(records).totals;
	strictEqual(totals.totalTokens.measured, 300);
	strictEqual(totals.totalTokens.unknownCount, 2, "every unsettled call leaves its sum partial");
});

test("totals keep unknown apart from zero and render partial cost with its marker", () => {
	const fold = foldCallJournal(imported.records);
	strictEqual(fold.totals.neverSent, 1);
	strictEqual(fold.totals.totalTokens.measured, 5050 + 220);
	strictEqual(fold.totals.totalTokens.unknownCount, 2, "L3: two invoked calls leave the sum a known subtotal");
	strictEqual(fold.totals.usd.unknownCount, 3, "the dropped, rejected and unpriced calls have no price");
	const calls = usageCallsFromJournal(imported.records);
	strictEqual(calls.length, 4, "L2: the never-sent call is not projected as spending");
	const display = renderCostAggregate(
		aggregateCostAmounts(
			calls.map((call) => ({
				usd: call.costUsd,
				provenance: call.costProvenance ?? "unknown",
				...(call.costSummary ? { costSummary: call.costSummary } : {}),
			})),
		),
	);
	notStrictEqual(display, "$0.00", "L1");
	match(display, /\+\?$/u, "L3: a partly priced total says so");
});

test("unmeasured cache reads are never false and an unpriced route never ranks cheapest", () => {
	const legacy = { version: 3, cacheRead: false, completedCostUsd: null } as unknown as Parameters<
		typeof routeObservationFromHistory
	>[0];
	strictEqual(routeObservationFromHistory(legacy).cacheRead, null, "L6");
	const sample = (completedCostUsd: number | null): RouteObservation => ({
		qualityLabel: "pass",
		reliability: "success",
		firstPass: true,
		completedCostUsd,
		completedEndToEndMs: 1000,
		cacheRead: null,
		queueWaitMs: 0,
	});
	const priced = estimateRoute(Array.from({ length: 5 }, () => sample(0.02)));
	const unpriced = estimateRoute(Array.from({ length: 5 }, () => sample(null)));
	ok(unpriced.expectedCostUsd > priced.expectedCostUsd);
});
