/**
 * §13.2 golden import (#434): a bundle shaped like session vccap2ywu7n8 (#423) goes through import-bundle and the
 * shared folds, and the epic's invariants hold over what they return. It tests the importer and the folds, not the
 * incident: the bundle is synthetic, built from the figures #423 and the epic publish, and nothing in it comes from
 * a real home or session. #423's table of seven breaks sums to 1,284,189 re-prefilled tokens, 17,303 short of its
 * own 1,301,492 total, so the fixture puts the difference on the first break.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Fact, FactSum } from "../../src/core/telemetry/fact.js";
import type { CallSettled } from "../../src/core/telemetry/schemas.js";
import type { RouteObservation } from "../../src/domains/dispatch/route-policy.js";
import { estimateRoute } from "../../src/domains/dispatch/route-policy.js";
import type { BundleImport } from "../../src/domains/telemetry/bundle.js";
import { importTelemetryBundle } from "../../src/domains/telemetry/bundle.js";
import { readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { foldCallJournal, foldCalls } from "../../src/domains/telemetry/folds.js";
import type { JournalSource, SessionSource } from "../../src/domains/telemetry/read-model.js";
import {
	cacheReport,
	callsReport,
	journalSourceFromRead,
	runsReport,
	sessionTelemetry,
	timeline,
	whyStopped,
} from "../../src/domains/telemetry/read-model.js";
import { dtoLies } from "../harness/telemetry-lies.js";

const FIXTURE = new URL("../fixtures/telemetry/golden/vccap2ywu7n8/", import.meta.url).pathname;
const SESSION = "vccap2ywu7n8";
const WORKERS = ["2s47tzn7p4bz", "21ee9qwrugeq"];
// Money is summed in floating point; the crossing is asserted to the cent and the recorded spend to a micro-dollar.
const USD_TOLERANCE = 1e-6;

let root = "";
let imported: BundleImport;
let source: SessionSource;

before(async () => {
	root = await mkdtemp(join(tmpdir(), "telemetry-incident-golden-"));
	const out = join(root, "fixture");
	imported = await importTelemetryBundle(FIXTURE, out);
	const runs = new Map<string, JournalSource>();
	for (const runId of imported.manifest.source.runs)
		runs.set(runId, journalSourceFromRead(await readCallJournal(join(out, "runs", runId), "events.ndjson"), true, runId));
	source = {
		sessionId: SESSION,
		journal: journalSourceFromRead(await readCallJournal(out), true),
		legacy: { records: [], aggregates: 0 },
		runs,
		parent: null,
	};
});

after(async () => {
	if (root) await rm(root, { recursive: true, force: true });
});

/** The known part of a fact or a sum: its measured or estimated value. */
const known = (fact: Fact<number> | FactSum) =>
	"kind" in fact
		? fact.kind === "measured" || fact.kind === "estimated"
			? fact.value
			: Number.NaN
		: fact.measured + fact.estimated;
const settledAt = new Map<string, string>();
const mainCalls = () => {
	const records = source.journal.records;
	for (const record of records) if (record.k === "call.settled") settledAt.set(record.data.attemptId, record.t);
	return foldCallJournal(records)
		.attempts.filter((attempt) => attempt.started.label === "main")
		.map((attempt) => {
			ok(attempt.settled, `attempt ${attempt.started.attemptId} settled`);
			return { settled: attempt.settled, at: settledAt.get(attempt.started.attemptId) ?? "" };
		})
		.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
};

test("the bundle imports whole and byte for byte: every record readable, its three runs and both config objects", async () => {
	strictEqual(imported.manifest.source.sessionId, SESSION);
	strictEqual(imported.manifest.contentClass, "structural");
	strictEqual(imported.unreadable, 0);
	strictEqual(imported.runs, 3);
	strictEqual(imported.objects, 2);
	deepStrictEqual(imported.manifest.source.runs, [...WORKERS, "q7unpricedr1"].sort());
	strictEqual(source.journal.skipped + source.journal.damaged, 0);
	for (const file of imported.manifest.files)
		deepStrictEqual(
			await readFile(join(root, "fixture", file.path)),
			await readFile(join(FIXTURE, file.path)),
			file.path,
		);
});

test("main-loop dispositions come from recorded facts: 131 invoked of 136 started, and never-sent is not spent", () => {
	const calls = mainCalls();
	strictEqual(calls.length, 136);
	const count = (disposition: CallSettled["disposition"]) =>
		calls.filter((call) => call.settled.disposition === disposition);
	strictEqual(count("settled").length, 129);
	const [rejected] = count("settled_no_usage");
	strictEqual(count("settled_no_usage").length, 1);
	strictEqual(rejected?.at, "2026-10-19T10:50:36.000Z");
	strictEqual(rejected?.settled.stop.failure, "auth_rejected");
	const [dropped] = count("sent_unsettled");
	strictEqual(count("sent_unsettled").length, 1);
	strictEqual(dropped?.at, "2026-10-20T13:30:55.100Z");
	strictEqual(dropped?.settled.stop.failure, "transport_dropped");
	const unsent = count("never_sent");
	deepStrictEqual(unsent.map((call) => call.settled.stop.failure).sort(), [
		"budget_wait_aborted",
		"budget_wait_aborted",
		"budget_wait_aborted",
		"operator_cancel",
		"operator_cancel",
	]);
	for (const call of unsent) {
		strictEqual(call.settled.usage, null, "L2: a never-sent call carries no usage or estimate");
		strictEqual(call.settled.pricing.usd.kind, "absent");
	}
	ok(
		calls.every((call) => !call.settled.stop.failure?.startsWith("stall_")),
		"a budget wait is never a stall",
	);
});

test("Σ settled main-loop provider tokens is 26,987,154, beside the two invoked calls that reported none", () => {
	const fold = foldCallJournal(source.journal.records);
	const main = foldCalls(fold.attempts.filter((attempt) => attempt.started.label === "main"));
	strictEqual(main.totalTokens.measured, 26_987_154);
	strictEqual(main.totalTokens.estimated, 0);
	strictEqual(main.totalTokens.unknownCount, 2, "L3: the 401 and the dropped stream leave the sum a lower bound");
	strictEqual(main.totalTokens.absentCount, 5, "the five never-sent calls are not applicable, never zero");
	strictEqual(main.usage.input.measured, 1_641_549);
	strictEqual(main.usage.cacheRead.measured, 25_279_104);
});

test("the fold over all labels crosses $5.00 at 12:52:45.131Z, and the next call waits on the budget, never stalls", () => {
	const settled = [
		...foldCallJournal(source.journal.records).attempts,
		...[...source.runs.values()].flatMap((run) => foldCallJournal(run.records).attempts),
	];
	const at = new Map<string, string>();
	for (const journal of [source.journal, ...source.runs.values()])
		for (const record of journal.records) if (record.k === "call.settled") at.set(record.data.attemptId, record.t);
	const ordered = settled
		.map((attempt) => ({ attempt, t: at.get(attempt.started.attemptId) ?? "" }))
		.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
	let spend = 0;
	let crossing: { t: string; spend: number } | null = null;
	for (const { attempt, t } of ordered) {
		const usd = attempt.settled?.pricing.usd;
		if (usd?.kind === "measured" || usd?.kind === "estimated") spend += usd.value;
		if (spend >= 5 && crossing === null) crossing = { t, spend };
	}
	ok(crossing);
	strictEqual(crossing.t, "2026-10-20T12:52:45.131Z");
	const next = mainCalls().find((call) => call.at > crossing.t);
	strictEqual(next?.settled.stages.admission?.waitedOn, "budget");
	strictEqual(next?.settled.stop.failure, "budget_wait_aborted");
	strictEqual(next?.settled.disposition, "never_sent");

	const report = whyStopped(source);
	const recorded = report.budget.find((entry) => entry.event === "crossing");
	ok(recorded);
	ok(recorded.at > crossing.t && recorded.at < (next?.at ?? ""), "admission records the crossing on the held call");
	strictEqual(recorded.ceiling.usd, 5);
	ok(Math.abs(known(recorded.spend.fact) - crossing.spend) < USD_TOLERANCE, "the spend admission saw");
	deepStrictEqual(
		report.budget.filter((entry) => entry.event === "wait").map((entry) => entry.outcome),
		["aborted", "aborted", "aborted"],
	);
	deepStrictEqual(
		report.waits.map((wait) => [wait.on, known(wait.calls.fact)]),
		[["budget", 3]],
	);
	ok(report.causes.every((cause) => !cause.cause.startsWith("stall_")));
});

test("seven cache breaks carry #423's causes, and Σ rePrefilledTokens is 1,301,492", () => {
	const report = cacheReport(source);
	deepStrictEqual(
		report.breaks.map((row) => [
			row.at.slice(0, 16),
			known(row.rePrefilled.fact),
			row.expectedColdReasons,
			row.firstDivergentSection.display,
		]),
		[
			// 58,825 in #423's table plus the 17,303 its rows fall short of its total.
			["2026-10-19T10:52", 76_128, ["prompt_recompiled", "thinking_change"], "safety"],
			["2026-10-19T11:43", 97_171, ["prompt_recompiled", "thinking_change"], "runtime"],
			["2026-10-19T12:15", 122_382, ["prompt_recompiled"], "safety"],
			// The prompt only extended its predecessor; the reasoning effort outside it changed.
			["2026-10-19T12:48", 182_904, ["thinking_change"], "none"],
			["2026-10-19T13:40", 214_671, ["prompt_recompiled"], "memory"],
			["2026-10-20T12:52", 274_662, [], "none"],
			["2026-10-20T13:43", 333_574, ["prompt_recompiled", "background_memory"], "memory"],
		],
	);
	strictEqual(known(report.rePrefilled.fact), 1_301_492);
	strictEqual(
		(report.rePrefilled.fact as FactSum).unknownCount,
		2,
		"the 401 and the dropped stream re-prefilled an unknown amount",
	);
	deepStrictEqual(
		report.byCause.map((cause) => [cause.cause, cause.breaks]),
		[
			["background_memory", 1],
			["prompt_recompiled", 5],
			["thinking_change", 3],
			// The 22-hour idle expiry stamps no expected-cold reason.
			["unattributed", 1],
		],
	);
	// A cache-served call that appended new content is partial with a re-prefill of zero, and no break (#423).
	ok(report.verdicts.partial > 3);
});

test("the two stranded coder workers are not contract_exhausted_after_repair, and an unpriced route never ranks cheapest", () => {
	const rows = new Map(runsReport(source).map((row) => [row.runId, row]));
	for (const runId of WORKERS) {
		strictEqual(rows.get(runId)?.terminalReason, "final_output_missing_no_repair", runId);
	}
	const observation = (runId: string): RouteObservation => {
		const usd = rows.get(runId)?.usd.fact as FactSum | undefined;
		ok(usd, runId);
		return {
			qualityLabel: "pass",
			reliability: "success",
			firstPass: true,
			completedCostUsd: usd.unknownCount === 0 && usd.coverage.unknown === 0 ? known(usd) : null,
			completedEndToEndMs: 60_000,
			cacheRead: null,
			queueWaitMs: 0,
		};
	};
	const unpriced = observation("q7unpricedr1");
	strictEqual(unpriced.completedCostUsd, null, "the litellm route declares no pricing");
	const priced = observation("2s47tzn7p4bz");
	ok(priced.completedCostUsd !== null && priced.completedCostUsd > 0);
	ok(estimateRoute([unpriced]).expectedCostUsd > estimateRoute([priced]).expectedCostUsd);
});

test("no DTO over the golden tells a lie the detectors know (§13.1)", () => {
	for (const [name, dto] of Object.entries({
		session: sessionTelemetry(source),
		calls: callsReport(source),
		cache: cacheReport(source),
		whyStopped: whyStopped(source),
		runs: runsReport(source),
		// Its config records are version 1, so their bare settings digest reads labelled (R7).
		timeline: timeline(source),
	})) {
		deepStrictEqual(dtoLies(dto), [], name);
	}
});
