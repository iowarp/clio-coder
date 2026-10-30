/**
 * P3 lie detectors over the read model (#434 §13.1): the golden P0 ledger, imported with stable ids, builds every
 * session DTO, and every quantity in them must hold L1 (unknown never zero), L2 (never-sent carries nothing), L3 (a
 * partial sum is never a total), L5 (every number resolves through explain to the same fact) and L9 (absent is
 * neither unknown nor zero). The detectors live in tests/harness/telemetry-lies.ts so the GUI route tests run the
 * same ones over the DTOs they serve.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	CacheReportSchema,
	CallsReportSchema,
	CostReportSchema,
	ReceiptEvidenceSchema,
	SessionTelemetrySchema,
	TimelineSchema,
	WhyStoppedSchema,
} from "../../src/core/telemetry/dto.js";
import type { TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { makeTelemetryRecord } from "../../src/core/telemetry/envelope.js";
import type { PendingTelemetry } from "../../src/core/telemetry/producer.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { readReceiptEvidence } from "../../src/domains/dispatch/receipt-facts.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { openCallJournal } from "../../src/domains/observability/call-journal.js";
import type { SessionSource } from "../../src/domains/observability/read-model.js";
import {
	cacheReport,
	callsReport,
	costReport,
	explain,
	sessionTelemetry,
	timeline,
	whyStopped,
} from "../../src/domains/observability/read-model.js";
import { createLiveTelemetryModel } from "../../src/domains/observability/telemetry-live.js";
import { isSessionEntry } from "../../src/domains/session/entries.js";
import { importLegacySession } from "../../src/domains/session/legacy-import.js";
import { loadSessionTelemetrySource } from "../../src/domains/session/telemetry-source.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import {
	absentRenderedOtherwise,
	quantitiesOf,
	unknownRenderedAsTotal,
	unmarkedEstimates,
	unparsableRefs,
} from "../harness/telemetry-lies.js";
import { telemetryCall } from "../harness/telemetry-view.js";

const ledger = readFileSync(new URL("../fixtures/telemetry/golden/p0/current.jsonl", import.meta.url), "utf8")
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line) as unknown)
	.filter(isSessionEntry);
const imported = importLegacySession("golden-p0", ledger, { ids: "derived" });
const source: SessionSource = {
	sessionId: "golden-p0",
	journal: { present: true, records: imported.records, modes: ["standard"], skipped: 0, damaged: 0 },
	legacy: { records: [], aggregates: 0 },
	runs: new Map(),
	parent: null,
};
const now = { now: new Date("2026-10-30T00:00:00.000Z") };
const dtos: Array<[string, TSchema, unknown]> = [
	["session", SessionTelemetrySchema, sessionTelemetry(source, now)],
	["calls", CallsReportSchema, callsReport(source, {}, now)],
	["cost by label", CostReportSchema, costReport(source, "label", now)],
	["cost by model", CostReportSchema, costReport(source, "model", now)],
	["cost by turn", CostReportSchema, costReport(source, "turn", now)],
	["cache", CacheReportSchema, cacheReport(source, now)],
	["timeline", TimelineSchema, timeline(source, null, now)],
	["why-stopped", WhyStoppedSchema, whyStopped(source, now)],
];

const all = dtos.flatMap(([, , dto]) => quantitiesOf(dto));

test("every DTO matches its published schema", () => {
	for (const [name, schema, dto] of dtos)
		ok(Value.Check(schema, dto), `${name}: ${[...Value.Errors(schema, dto)][0]?.message}`);
	ok(all.length > 100);
});

test("legacy ids are derived from ledger entries, so references survive a re-read (#434)", () => {
	deepStrictEqual(
		importLegacySession("golden-p0", ledger, { ids: "derived" }).records.map((record) => record.id),
		imported.records.map((record) => record.id),
	);
});

test("L5: every quantity names a reference that explains to the same fact and wording", () => {
	deepStrictEqual(unparsableRefs(all), []);
	deepStrictEqual(unmarkedEstimates(all), []);
	for (const quantity of all)
		deepStrictEqual(explain(quantity.ref, { session: source }, now)?.value, quantity, quantity.ref);
});

test("L1 and L3: unknown is never zero, and a partial sum is never shown as a total", () => {
	deepStrictEqual(unknownRenderedAsTotal(all), []);
});

test("L2 and L9: a never-sent call carries no usage, and absent renders as not applicable", () => {
	const calls = callsReport(source, { dispositions: ["never_sent"] }, now).calls;
	strictEqual(calls.length, 1);
	strictEqual(calls[0]?.usage, null);
	strictEqual("kind" in (calls[0]?.usd.fact ?? {}) ? (calls[0]?.usd.fact as { kind: string }).kind : null, "absent");
	deepStrictEqual(absentRenderedOtherwise(all), []);
});

test("live equals CLI: the live model folds exactly the batches a cold read of the same journal holds (#434 §11)", {
	timeout: 10_000,
}, async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-telemetry-live-"));
	const writer = await openCallJournal({
		sessionDirectory: join(stateDir, "sessions", "bucket", "golden-p0"),
		context: { sessionId: "golden-p0", label: "main" },
		writer: { clioCoderVersion: "test", piVersion: "test" },
	});
	const write = async (records: readonly TelemetryRecord[]) => {
		for (const record of records)
			ok(
				writer.enqueue({
					kind: record.k,
					data: record.data,
					ctx: record.ctx,
					wallMs: Date.parse(record.t),
					mono: record.mono,
					recordId: record.id,
				} as PendingTelemetry),
			);
		await writer.flush();
	};
	const third = Math.ceil(imported.records.length / 3);
	await write(imported.records.slice(0, third));
	const model = createLiveTelemetryModel({ stateDir: () => stateDir });
	try {
		model.bind("golden-p0");
		const seeded = new Promise<void>((resolve) =>
			model.subscribe("session", () => {
				if (model.live()?.seeding === false) resolve();
			}),
		);
		// Before the seed merges, live() is the hub-buffered view marked partial, never null.
		strictEqual(model.live()?.session().journal.seeding, true);
		await write(imported.records.slice(third, 2 * third));
		await seeded;
		await write(imported.records.slice(2 * third));
		const timeless = (dto: unknown) =>
			JSON.parse(JSON.stringify(dto, (key, value: unknown) => (key === "generatedAt" ? undefined : value))) as unknown;
		const equalsCold = (records: number) => {
			const live = model.live();
			const cold = loadSessionTelemetrySource(stateDir, "golden-p0");
			ok(live && cold);
			strictEqual(live.session().journal.records, records);
			const pairs: Array<[string, unknown, unknown]> = [
				["session", live.session(), sessionTelemetry(cold)],
				["calls", live.calls(), callsReport(cold)],
				["cost by model", live.cost("model"), costReport(cold, "model")],
				["cost by turn", live.cost("turn"), costReport(cold, "turn")],
				["cache", live.cache(), cacheReport(cold)],
				["timeline", live.timeline(), timeline(cold)],
				["why-stopped", live.whyStopped(), whyStopped(cold)],
			];
			for (const [name, actual, expected] of pairs) deepStrictEqual(timeless(actual), timeless(expected), name);
		};
		equalsCold(imported.records.length);
		// The live fold extends per batch: one record per batch, read between batches, with a later side call settling
		// before the main call it overlapped, still folds to the cold read's exact sums and order (#434 §11).
		const main = telemetryCall("golden-p0", { turnId: "turn-late", usage: { input: 7, output: null }, usd: 0.0137 });
		const side = telemetryCall("golden-p0", { label: "memory", turnId: "turn-late", usd: 0.0021 });
		// The main call's tool settles after it, so the call's tool time and round-trip facts move on a later batch.
		const golden = main[1] as Extract<TelemetryRecord, { k: "call.settled" }>;
		const settledMain: TelemetryRecord = { ...golden, data: { ...golden.data, stop: { reason: "toolUse" } } };
		main[1] = settledMain;
		const tool = makeTelemetryRecord(
			"tool.settled",
			{ tool: ToolNames.Tasks, outcome: "ok", durationMs: 4 },
			{ ...settledMain.ctx, toolCallId: "tc-late" },
			{ t: settledMain.t, mono: 0 },
		);
		for (const record of [main[0], side[0], side[1], main[1], tool]) {
			await write([record as TelemetryRecord]);
			model.live()?.cost("turn");
		}
		equalsCold(imported.records.length + 5);
	} finally {
		model.stop();
		await writer.close();
	}
});

test("a session's lifetime tells a clean close, an open owner, an abnormal end and an unprobeable host apart (#434 §6.1)", () => {
	const owner = { host: "elsewhere", pid: 4242, birthToken: null };
	const lifetime = (ledger: SessionSource["ledger"], alive: boolean | null) =>
		sessionTelemetry({ ...source, ...(ledger ? { ledger } : {}) }, { ...now, alive: () => alive }).lifetime;
	deepStrictEqual(
		{ ...lifetime({ endedAt: "2099-01-01T00:00:00.000Z", owner }, true), firstRecordAt: null, lastRecordAt: null },
		{
			firstRecordAt: null,
			lastRecordAt: null,
			state: "closed",
			closed: { at: "2099-01-01T00:00:00.000Z", reason: null },
		},
	);
	// Facts written after a ledger close, with no journal open or resume after it, do not reopen the session.
	strictEqual(lifetime({ endedAt: "2000-01-01T00:00:00.000Z", owner }, true).state, "closed");
	strictEqual(lifetime({ endedAt: null, owner }, true).state, "open");
	strictEqual(lifetime({ endedAt: null, owner }, false).state, "ended-abnormally");
	strictEqual(lifetime({ endedAt: null, owner }, null).state, "unverifiable");
	strictEqual(lifetime(undefined, true).state, "unknown");
	ok(Value.Check(SessionTelemetrySchema, sessionTelemetry({ ...source, ledger: { endedAt: null, owner } }, now)));
});

test("a run's receipt evidence carries sealed checks only under a seal that verifies (#434 §11.3)", () => {
	const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-receipt-evidence-"));
	mkdirSync(join(stateDir, "receipts"));
	const envelope = fixtureEnvelope("run-evidence");
	const receipt = withReceiptIntegrity(fixtureReceiptDraft(envelope), envelope);
	const writeReceipt = (value: unknown) =>
		writeFileSync(join(stateDir, "receipts", "run-evidence.json"), JSON.stringify(value));
	const read = () => readReceiptEvidence("run-evidence", stateDir, now);

	const missing = read();
	strictEqual(missing.receipt, "missing");
	strictEqual(missing.integrity.state, "unavailable");
	strictEqual(missing.sealed, null);

	writeReceipt(receipt);
	writeFileSync(join(stateDir, "runs.json"), JSON.stringify([envelope]));
	const verified = read();
	ok(Value.Check(ReceiptEvidenceSchema, verified), [...Value.Errors(ReceiptEvidenceSchema, verified)][0]?.message);
	strictEqual(verified.integrity.state, "verified");
	strictEqual(verified.sealed?.outcome, "succeeded");

	rmSync(join(stateDir, "runs.json"));
	strictEqual(read().integrity.state, "verified-ledger-evicted");

	writeReceipt({ ...receipt, outcome: "failed" });
	const tampered = read();
	strictEqual(tampered.integrity.state, "failed");
	ok(tampered.integrity.detail);
	strictEqual(tampered.sealed, null);
	strictEqual(tampered.trust.artifactIntegrity.state, "failed");
});

test("the timeline and why-stopped carry config, budget and quota records, spend marked as its calls were priced (#434 §8, §12.6)", () => {
	const ctx = { sessionId: "timeline-records", label: "main" as const };
	const clock = (t: string) => ({ t, mono: 0 });
	const object = {
		label: "resolvable" as const,
		function: "sha256" as const,
		canonicalization: "json-sorted-v1" as const,
		subject: "config" as const,
		id: `obj_${"a".repeat(64)}`,
	};
	const priced = telemetryCall("timeline-records", { at: "2026-10-30T00:00:01.000Z", usd: 4, pricedBy: "catalog" });
	const unpriced = telemetryCall("timeline-records", { at: "2026-10-30T00:00:02.000Z", usd: null });
	const records: TelemetryRecord[] = [
		makeTelemetryRecord(
			"config.snapshot",
			{ settings: object, settingsFingerprint: "f".repeat(64) },
			ctx,
			clock("2026-10-30T00:00:00.000Z"),
		),
		...priced,
		...unpriced,
		makeTelemetryRecord(
			"budget.crossing",
			{ level: "at", spendUsd: 5, ceilingUsd: 5, contextTokens: 1200 },
			ctx,
			clock("2026-10-30T00:00:03.000Z"),
		),
		makeTelemetryRecord(
			"budget.wait",
			{
				level: "at",
				spendUsd: 5,
				ceilingUsd: 5,
				outcome: "raised",
				waitedMs: 1500,
				raisedToUsd: 10,
				raisedBy: "settings-ui",
			},
			ctx,
			clock("2026-10-30T00:00:04.000Z"),
		),
		makeTelemetryRecord(
			"quota.reading",
			{
				provider: "codex",
				targetId: "fixture",
				source: "stream-event",
				observedAt: "2026-10-30T00:00:05.000Z",
				windows: [{ key: "primary", usedPct: { kind: "measured", value: 42, source: "provider" } }],
				limitReached: true,
			},
			ctx,
			clock("2026-10-30T00:00:05.000Z"),
		),
	];
	const recorded: SessionSource = { ...source, sessionId: "timeline-records", journal: { ...source.journal, records } };
	const dto = timeline(recorded, null, now);
	ok(Value.Check(TimelineSchema, dto), [...Value.Errors(TimelineSchema, dto)][0]?.message);
	deepStrictEqual(
		dto.entries.filter((entry) => entry.kind !== "call").map((entry) => entry.kind),
		["config", "budget", "budget", "quota"],
	);
	const [crossing, wait] = dto.entries.filter((entry) => entry.kind === "budget");
	// A catalog-priced call settled before the crossing makes the spend an estimate; the unpriced call stays beside it.
	strictEqual(crossing?.kind === "budget" ? crossing.spend.display : null, "~$5.00 +?");
	strictEqual(wait?.kind === "budget" ? wait.waited?.display : null, "1.50s");
	strictEqual(wait?.kind === "budget" ? wait.raisedBy : null, "settings-ui");
	// why-stopped reads the same records: the crossing, the held request's release and the limited account (#434 §12.6).
	const why = whyStopped(recorded, now);
	ok(Value.Check(WhyStoppedSchema, why), [...Value.Errors(WhyStoppedSchema, why)][0]?.message);
	deepStrictEqual(
		why.budget.map((entry) => entry.event),
		["crossing", "wait"],
	);
	strictEqual(why.quota[0]?.limitReached, true);
	deepStrictEqual(
		why.findings.filter((line) => /ceiling|limited/.test(line)),
		[
			"Priced spend reached the $5.00 ceiling at 2026-10-30T00:00:03.000Z: ~$5.00 +?.",
			"1 paid request was held at a ceiling; the last was released (raised to $10.00 by settings-ui) after 1.50s.",
			"codex reported the account limited at 2026-10-30T00:00:05.000Z: primary 42.0%.",
		],
	);
});

test("the timeline carries tool, middleware, auth, prompt, context, System One and worker channel records (#434 §8)", () => {
	const ctx = { sessionId: "timeline-signals", label: "main" as const, turnId: "turn-1" };
	const clock = (second: number) => ({ t: `2026-10-30T00:00:0${second}.000Z`, mono: 0 });
	const structure = {
		label: "resolvable" as const,
		function: "sha256" as const,
		canonicalization: "json-sorted-v1" as const,
		subject: "prompt-structure" as const,
		id: `obj_${"b".repeat(64)}`,
	};
	const records: TelemetryRecord[] = [
		makeTelemetryRecord(
			"auth.event",
			{
				provider: "openai-codex",
				trigger: "expiry",
				attempted: true,
				outcome: "refreshed",
				writerPid: 7,
				durationMs: 210,
			},
			ctx,
			clock(1),
		),
		makeTelemetryRecord(
			"prompt.compiled",
			{ structure, layoutVersion: 1, tokenEstimate: 9000, sections: 12 },
			ctx,
			clock(2),
		),
		makeTelemetryRecord(
			"context.snapshot",
			{
				snapshotId: "snap-1",
				categories: {
					system: 1,
					tools: 1,
					agents: 0,
					skills: 0,
					memory: 0,
					project: 0,
					messages: 1,
					reserve: 0,
					free: 0,
					streaming: 0,
				},
				window: { desired: 200_000, effective: 200_000, source: "catalog" },
				source: "reconciled",
				estimatedTokens: 9100,
				reconciledTokens: 9342,
			},
			ctx,
			clock(3),
		),
		makeTelemetryRecord(
			"system_one.decision",
			{
				site: "intent",
				outcome: "timeout",
				latencyMs: 900,
				deadlineMs: 800,
				routes: [{ engine: "local", kind: "model", outcome: "timeout", breaker: "opened" }],
				callIds: [],
			},
			ctx,
			clock(4),
		),
		makeTelemetryRecord(
			"middleware.fired",
			{ hook: "turn_start", phase: "sync", ruleId: "plan-request", effects: ["inject_reminder"], severity: "advisory" },
			ctx,
			clock(5),
		),
		makeTelemetryRecord(
			"tool.settled",
			{ tool: "bash", outcome: "ok", durationMs: 1250, resultBytes: 512 },
			{ ...ctx, toolCallId: "tc-1" },
			clock(6),
		),
		makeTelemetryRecord("run.ref", { runId: "run-signals" }, ctx, clock(7)),
	];
	const run = [
		makeTelemetryRecord(
			"worker.channel",
			{ lane: "stdin", frameType: "steer", errno: "EPIPE", afterExit: true, failure: "write-failed" },
			{ sessionId: "timeline-signals", runId: "run-signals", label: "worker" },
			clock(8),
		),
	];
	const dto = timeline(
		{
			...source,
			sessionId: "timeline-signals",
			journal: { ...source.journal, records },
			runs: new Map([["run-signals", { present: true, records: run, modes: ["standard"], skipped: 0, damaged: 0 }]]),
		},
		null,
		now,
	);
	ok(Value.Check(TimelineSchema, dto), [...Value.Errors(TimelineSchema, dto)][0]?.message);
	deepStrictEqual(
		dto.entries.map((entry) => entry.kind),
		["auth", "prompt", "context", "system-one", "middleware", "tool", "run", "worker-channel"],
	);
	const tool = dto.entries.find((entry) => entry.kind === "tool");
	strictEqual(tool?.kind === "tool" ? tool.duration.display : null, "1.25s");
	const context = dto.entries.find((entry) => entry.kind === "context");
	strictEqual(context?.kind === "context" ? context.estimated?.display : null, "~9,100 (chars/4)");
});

test("the main loop's time splits into harness, network, model and tools, and bookkeeping-only rounds count their re-read (#434 §12.3, §12.4)", () => {
	const stages = {
		admission: { start: 0, end: 10, waitedOn: "budget" as const },
		send: { start: 40, end: 45 },
		firstToken: 300,
		settle: 900,
	};
	const round = (at: string, tool: string, durationMs: number) => {
		const [started, settled] = telemetryCall("overhead", { at, usage: { input: 100, cacheRead: 900 }, usd: 0.01 });
		if (settled?.k !== "call.settled" || !started) throw new Error("fixture call missing");
		const asked: TelemetryRecord = {
			...settled,
			data: { ...settled.data, stop: { reason: "toolUse" }, stages: { ...settled.data.stages, ...stages } },
		};
		const ctx = { ...settled.ctx, toolCallId: `tc-${tool}` };
		return [
			started,
			asked,
			makeTelemetryRecord("tool.settled", { tool, outcome: "ok", durationMs }, ctx, { t: at, mono: 0 }),
		];
	};
	const records = [
		...round("2026-10-30T00:00:01.000Z", ToolNames.Tasks, 5),
		...round("2026-10-30T00:00:02.000Z", ToolNames.Bash, 1250),
	];
	const recorded: SessionSource = { ...source, sessionId: "overhead", journal: { ...source.journal, records } };
	const overhead = sessionTelemetry(recorded, now).overhead;
	ok(Value.Check(SessionTelemetrySchema, sessionTelemetry(recorded, now)));
	strictEqual(overhead.harness.display, "60ms");
	strictEqual(overhead.tool.display, "1.25s");
	strictEqual(overhead.bookkeepingRounds.display, "1");
	strictEqual(overhead.roundTripTax.display, "1,000");
	strictEqual(overhead.prompt.display, "2,000");
	// No connect span is recorded while Pi owns the socket, so network time stays unknown (option B).
	ok(/unknown/.test(overhead.network.display), overhead.network.display);
	deepStrictEqual(unknownRenderedAsTotal(quantitiesOf(overhead)), []);
	const why = whyStopped(recorded, now);
	ok(why.findings.includes("Bookkeeping-only rounds: 1, re-reading 1,000 prompt tokens."), why.findings.join("\n"));
});
