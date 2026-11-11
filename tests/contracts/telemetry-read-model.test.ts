/**
 * P3 lie detectors over the read model (#434 §13.1): the golden P0 session journal builds every
 * session DTO, and every quantity in them must hold L1 (unknown never zero), L2 (never-sent carries nothing), L3 (a
 * partial sum is never a total), L5 (every number resolves through explain to the same fact) and L9 (absent is
 * neither unknown nor zero). Their structure must hold L4 (a cache verdict shows its tokens), L6 (unmeasured never
 * reads false), L7 (every amount priced by the shared policy), L8 (every hash R7-labelled) and L10 (every cause from
 * its closed vocabulary). The detectors live in tests/harness/telemetry-lies.ts so the GUI route tests run the same
 * ones over the DTOs they serve.
 */
import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	CacheReportSchema,
	CallsReportSchema,
	CostReportSchema,
	type CostReportV1,
	parseFactRef,
	SessionTelemetrySchema,
	TimelineSchema,
	WhyStoppedSchema,
} from "../../src/core/telemetry/dto.js";
import type { TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { makeTelemetryRecord } from "../../src/core/telemetry/envelope.js";
import type { FactSum } from "../../src/core/telemetry/fact.js";
import type { PendingTelemetry } from "../../src/core/telemetry/producer.js";
import type { CallSettled } from "../../src/core/telemetry/schemas.js";
import { settingsFingerprintCommitment } from "../../src/core/telemetry/schemas.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { loadSessionTelemetrySource } from "../../src/domains/session/telemetry-source.js";
import { openCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { telemetrySessionDirectory } from "../../src/domains/telemetry/paths.js";
import type { RepoSource, SessionSource } from "../../src/domains/telemetry/read-model.js";
import {
	cacheReport,
	callsReport,
	continueSource,
	costReport,
	explain,
	repoCostReport,
	repoOwner,
	runningSelectionsForTesting,
	sessionOperatorMetrics,
	sessionTelemetry,
	timeline,
	turnsSum,
	usageReport,
	whyStopped,
} from "../../src/domains/telemetry/read-model.js";
import { createLiveTelemetryModel } from "../../src/domains/telemetry/telemetry-live.js";
import {
	absentRenderedOtherwise,
	costsOffPolicy,
	freeTextClassifiers,
	quantitiesOf,
	unknownRenderedAsTotal,
	unlabelledHashes,
	unmarkedEstimates,
	unmeasuredRenderedAsFalse,
	unparsableRefs,
	verdictsWithoutTokens,
} from "../harness/telemetry-lies.js";
import { goldenTelemetryRecords, telemetryCall } from "../harness/telemetry-view.js";

const imported = { records: goldenTelemetryRecords() };
const source: SessionSource = {
	sessionId: "golden-p0",
	journal: { present: true, records: imported.records, modes: ["standard"], skipped: 0, damaged: 0 },
	runs: new Map(),
	parent: null,
};
const now = { now: new Date("2026-10-30T00:00:00.000Z") };
const dtos: Array<[string, TSchema, unknown]> = [
	["session", SessionTelemetrySchema, sessionTelemetry(source, now)],
	["calls", CallsReportSchema, callsReport(source, {}, now)],
	["cost by role", CostReportSchema, costReport(source, "role", now)],
	["cost by model", CostReportSchema, costReport(source, "model", now)],
	["cost by turn", CostReportSchema, costReport(source, "turn", now)],
	["cache", CacheReportSchema, cacheReport(source, now)],
	["timeline", TimelineSchema, timeline(source, null, now)],
	["why-stopped", WhyStoppedSchema, whyStopped(source, now)],
];

const all = dtos.flatMap(([, , dto]) => quantitiesOf(dto));

test("model and target rows split a worker's actual routes, including token fields and explained cache share", () => {
	const runId = "mixed-routes";
	const worker = [
		...telemetryCall(source.sessionId, {
			role: "worker",
			targetId: "alpha",
			model: "one",
			usage: { input: 100, cacheRead: 300, output: 20 },
			usd: 0.1,
		}),
		...telemetryCall(source.sessionId, {
			role: "worker",
			targetId: "beta",
			model: "two",
			usage: { input: 200, output: 30 },
			usd: 0.2,
		}),
	].map((record) => ({ ...record, ctx: { ...record.ctx, runId } }) as TelemetryRecord);
	const recorded: SessionSource = {
		...source,
		journal: { ...source.journal, records: [] },
		runs: new Map([[runId, { ...source.journal, records: worker }]]),
	};
	for (const by of ["model", "target"] as const) {
		const report = costReport(recorded, by, now);
		strictEqual(report.groups.length, 2);
		const alpha = report.groups.find((row) => row.key === (by === "model" ? "alpha/one" : "alpha"));
		ok(alpha?.tokenFields && alpha.cacheShare);
		strictEqual(alpha.tokens.display, "420");
		strictEqual(alpha.tokenFields.input.display, "100");
		strictEqual(alpha.cacheShare.display, "75.0%");
		for (const quantity of quantitiesOf(report))
			deepStrictEqual(explain(quantity.ref, { session: recorded }, now)?.value, quantity, quantity.ref);
	}
	const unpriced = telemetryCall("unknown-cache", { usage: { input: null, cacheRead: 100 }, usd: null });
	const unknown = costReport(
		{ ...source, sessionId: "unknown-cache", journal: { ...source.journal, records: unpriced } },
		"model",
		now,
	).groups[0];
	ok(unknown);
	ok(/unknown/.test(unknown.cacheShare?.display ?? ""));
	ok(/unknown|not measured/.test(unknown.usd.display));
});

test("operator metrics fold settlements once, keep blocked calls separate, and leave missing timings as gaps", () => {
	const call = (at: string, firstToken: number | undefined) =>
		telemetryCall("operator-metrics", { at }).map((record) => {
			if (record.k !== "call.settled") return record;
			const { firstToken: _old, ...stages } = record.data.stages;
			return {
				...record,
				data: {
					...record.data,
					stages: {
						...stages,
						send: { start: 0, end: 0 },
						settle: 100,
						...(firstToken !== undefined ? { firstToken } : {}),
					},
				},
			};
		});
	const calls = [
		...call("2026-10-30T00:00:01.000Z", 10),
		...call("2026-10-30T00:00:02.000Z", 30),
		...call("2026-10-30T00:00:03.000Z", undefined),
	];
	const first = calls[0];
	if (!first?.ctx.callId) throw new Error("fixture call missing");
	const tools = (["ok", "error", "blocked"] as const).map((outcome, index) =>
		makeTelemetryRecord("tool.settled", { tool: "bash", outcome, durationMs: [10, 50, 0][index] ?? 0 }, first.ctx, {
			t: "2026-10-30T00:00:04.000Z",
			mono: 0,
		}),
	);
	const compact = makeTelemetryRecord(
		"compaction.settled",
		{ callIds: [first.ctx.callId], outcome: "committed", checkpointTurnId: "checkpoint" },
		first.ctx,
		{ t: "2026-10-30T00:00:05.000Z", mono: 0 },
	);
	const recorded: SessionSource = {
		...source,
		sessionId: "operator-metrics",
		journal: { ...source.journal, records: [...calls, ...tools, ...tools.slice(0, 1), compact] },
	};
	const performance = sessionOperatorMetrics(recorded).performance;
	strictEqual(performance.totals.toolCalls.display, "3");
	strictEqual(performance.tools[0]?.success.display, "50.0%");
	strictEqual(performance.tools[0]?.blocked.display, "1");
	strictEqual(performance.tools[0]?.latency.p50.display, "30ms");
	strictEqual(performance.compactionOutcomes.committed.display, "1");
	strictEqual(performance.sessions[0]?.ttft.p50.display, "20ms");
	strictEqual(performance.sessions[0]?.ttft.p95.display, "30ms");
	strictEqual(performance.sessions[0]?.ttft.missing.display, "1");
	deepStrictEqual(performance.sessions[0]?.trend, [10, 30, null]);
	const repo: RepoSource = { owner: repoOwner(null, 30), sessions: [recorded], runs: new Map() };
	const window = usageReport(repo, Date.parse("2026-10-01"), Date.parse("2026-10-31")).performance;
	for (const quantity of quantitiesOf(window.sessions))
		deepStrictEqual(explain(quantity.ref, { repo }, now)?.value, quantity, quantity.ref);
});

test("every DTO matches its published schema", () => {
	for (const [name, schema, dto] of dtos)
		ok(Value.Check(schema, dto), `${name}: ${[...Value.Errors(schema, dto)][0]?.message}`);
	ok(all.length > 100);
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

test("L4, L6, L7, L8 and L10: every DTO's labels, booleans, prices, hashes and causes hold, and each detector catches its lie", () => {
	for (const [name, , dto] of dtos) {
		deepStrictEqual(verdictsWithoutTokens(dto), [], name);
		deepStrictEqual(unmeasuredRenderedAsFalse(dto), [], name);
		deepStrictEqual(costsOffPolicy(dto), [], name);
		deepStrictEqual(unlabelledHashes(dto), [], name);
		deepStrictEqual(freeTextClassifiers(dto), [], name);
	}
	const unknown = { fact: { kind: "unknown", reason: "not-observed" }, display: "unknown", ref: "x" };
	const measured = (value: number, source = "provider") => ({
		fact: { kind: "measured", value, source },
		display: String(value),
		ref: "x",
	});
	strictEqual(verdictsWithoutTokens({ cache: { verdict: "cold", uncachedPrefill: unknown } }).length, 1);
	deepStrictEqual(verdictsWithoutTokens({ entry: { cacheVerdict: "hot", tokens: measured(40) } }), []);
	strictEqual(unmeasuredRenderedAsFalse({ reused: { fact: unknown.fact, display: "false" } }).length, 1);
	strictEqual(costsOffPolicy({ call: { usd: measured(0.4), pricedBy: "catalog" } }).length, 1);
	deepStrictEqual(costsOffPolicy({ call: { usd: measured(0, "local-count"), pricedBy: "free" } }), []);
	const sum = { measured: 0.4, estimated: 0, unknownCount: 0, absentCount: 0 };
	const fold = { ...sum, coverage: { measured: 2, estimated: 0, unknown: 0 } };
	const pricing = { provider: 1, "target-rates": 0, catalog: 1, free: 0, none: 0 };
	strictEqual(
		costsOffPolicy({ total: { usd: { fact: fold, display: "$0.40", ref: "x" }, pricedBy: pricing } }).length,
		1,
	);
	strictEqual(unlabelledHashes({ config: { settingsFingerprint: "a".repeat(64) } }).length, 1);
	const ref = { label: "resolvable", function: "sha256", canonicalization: "json-sorted-v1", subject: "config" };
	deepStrictEqual(unlabelledHashes({ settings: { ...ref, id: `obj_${"a".repeat(64)}` } }), []);
	strictEqual(freeTextClassifiers({ byCause: [{ cause: "the provider said no" }] }).length, 1);
	deepStrictEqual(
		freeTextClassifiers({ byCause: [{ cause: "unattributed", expectedColdReasons: ["compaction"] }] }),
		[],
	);
});

test("live equals CLI: the live model folds exactly the batches a cold read of the same journal holds (#434 §11)", {
	timeout: 10_000,
}, async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-telemetry-live-"));
	const writer = await openCallJournal({
		directory: telemetrySessionDirectory(stateDir, "golden-p0"),
		context: { sessionId: "golden-p0", agent: { role: "main", id: "golden-p0" } },
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
		const side = telemetryCall("golden-p0", { role: "memory", turnId: "turn-late", usd: 0.0021 });
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

for (const buffered of [true, false]) {
	test(`live seed keeps the unseen tail of a partially observed batch (${buffered ? "buffered" : "after seed"})`, async () => {
		const sessionId = `overlap-${buffered}`;
		const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-telemetry-overlap-"));
		const records = telemetryCall(sessionId, { usd: 0.25 });
		const cold: SessionSource = {
			sessionId,
			journal: { present: true, records: records.slice(0, 1), modes: ["standard"], skipped: 0, damaged: 0 },
			runs: new Map(),
			parent: null,
		};
		let resolveSeed!: (source: SessionSource) => void;
		const seed = new Promise<SessionSource>((resolve) => {
			resolveSeed = resolve;
		});
		let markReading!: () => void;
		const reading = new Promise<void>((resolve) => {
			markReading = resolve;
		});
		const model = createLiveTelemetryModel({
			stateDir: () => stateDir,
			loader: async () => ({
				loadSessionTelemetrySourceAsync: () => {
					markReading();
					return seed;
				},
				loadRunTelemetrySourceAsync: async () => cold.journal,
			}),
		});
		const writer = await openCallJournal({
			directory: telemetrySessionDirectory(stateDir, sessionId),
			context: { sessionId, agent: { role: "main", id: sessionId } },
			writer: { clioCoderVersion: "test", piVersion: "test" },
		});
		try {
			model.bind(sessionId);
			const settled = model.settled();
			await reading;
			if (!buffered) {
				resolveSeed(cold);
				await settled;
			}
			// A cold read may see a complete-line prefix before the writer publishes the whole fsync'd batch.
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
			resolveSeed(cold);
			await settled;
			const live = model.live();
			ok(live);
			strictEqual(live.session().journal.records, records.length);
			deepStrictEqual(live.cost().total, costReport({ ...cold, journal: { ...cold.journal, records } }).total);
		} finally {
			resolveSeed(cold);
			model.stop();
			await writer.close();
		}
	});
}

test("a long session keeps a bounded set of running turn selections, and a turn read again folds to its cold sums (#434 §11)", () => {
	const sessionId = "many-turns";
	const sourceOf = (records: readonly TelemetryRecord[]): SessionSource => ({
		sessionId,
		journal: { present: true, records, modes: ["standard"], skipped: 0, damaged: 0 },
		runs: new Map(),
		parent: null,
	});
	const turns = 150;
	const records = Array.from({ length: turns }, (_, turn) =>
		telemetryCall(sessionId, { turnId: `turn-${turn}`, usage: { input: turn + 1, output: 2 }, usd: 0.001 * (turn + 1) }),
	).flat();
	const live = sourceOf(records);
	// Each turn's receipt reads its own turn once, as the chat panel does over a long session.
	for (let turn = 0; turn < turns; turn++) turnsSum(live, [`turn-${turn}`], "input");
	ok(runningSelectionsForTesting(live) <= 65, `${runningSelectionsForTesting(live)} running selections`);
	// A later batch lands on a turn that left the cache and on one still in it.
	const later = [
		...telemetryCall(sessionId, { turnId: "turn-0", usage: { input: 1000, output: 1 }, usd: 0.5 }),
		...telemetryCall(sessionId, { turnId: `turn-${turns - 1}`, usage: { input: 7, output: 3 }, usd: 0.25 }),
	];
	const next = sourceOf([...records, ...later]);
	continueSource(next, live);
	const cold = sourceOf([...records, ...later]);
	for (const turn of ["turn-0", `turn-${turns - 1}`, "turn-80"])
		for (const metric of ["calls", "input", "output", "usd"] as const)
			deepStrictEqual(turnsSum(next, [turn], metric), turnsSum(cold, [turn], metric), `${turn} ${metric}`);
});

test("a session's lifetime tells a clean close, an open owner, an abnormal end and an unprobeable host apart, and why-stopped reads it (#434 §6.1)", () => {
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
	// why-stopped reads the same lifecycle: a ledger close with no session.closed record reads closed.
	const why = (ledger: NonNullable<SessionSource["ledger"]>, alive: boolean | null) =>
		whyStopped({ ...source, ledger }, { ...now, alive: () => alive });
	const closed = why({ endedAt: "2099-01-01T00:00:00.000Z", owner }, true);
	strictEqual(closed.state, "closed");
	ok(closed.findings.includes("The session closed at 2099-01-01T00:00:00.000Z."));
	const crashed = why({ endedAt: null, owner }, false);
	notStrictEqual(crashed.state, "closed");
	ok(crashed.findings.includes("The session's process ended without closing it."));
});

test("the timeline and why-stopped carry config, budget and quota records, spend marked as its calls were priced (#434 §8, §12.6)", () => {
	const ctx = { sessionId: "timeline-records", agent: { role: "main" as const, id: "timeline-records" } };
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
			"config.snapshotted",
			{ settings: object, settingsFingerprint: settingsFingerprintCommitment("f".repeat(64)) },
			ctx,
			clock("2026-10-30T00:00:00.000Z"),
		),
		...priced,
		...unpriced,
		makeTelemetryRecord(
			"budget.crossed",
			{ level: "at", spendUsd: 5, ceilingUsd: 5, contextTokens: 1200 },
			ctx,
			clock("2026-10-30T00:00:03.000Z"),
		),
		makeTelemetryRecord(
			"budget.held",
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
	];
	// A quota window belongs to the account, so the process journal keeps the reading the session reads (#434).
	const accountQuota: TelemetryRecord[] = [
		makeTelemetryRecord(
			"quota.read",
			{
				provider: "codex",
				displayName: "Codex",
				status: "ok",
				targetId: "fixture",
				source: "stream-event",
				observedAt: "2026-10-30T00:00:05.000Z",
				windows: [{ key: "primary", usedPct: { kind: "measured", value: 42, source: "provider" } }],
				limitReached: true,
			},
			{ sessionId: null, processId: "prc_fixture", agent: { role: "main", id: "prc_fixture" } },
			clock("2026-10-30T00:00:05.000Z"),
		),
	];
	const recorded: SessionSource = {
		...source,
		sessionId: "timeline-records",
		journal: { ...source.journal, records },
		accountQuota,
	};
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

test("why-stopped names a yolo halt still standing and the open decisions it left (ob-yolo D7)", () => {
	const ctx = { sessionId: "yolo-records", agent: { role: "main" as const, id: "yolo-records" } };
	const at = (t: string) => ({ t: `2026-10-30T00:00:0${t}.000Z`, mono: 0 });
	const usage = { toolCalls: 4, activeMs: 9000, tokens: 1200 };
	const records: TelemetryRecord[] = [
		makeTelemetryRecord(
			"autonomy.entered",
			{ confinement: "contained", capToolCalls: 4, capMinutes: 0, capTokens: 0 },
			ctx,
			at("0"),
		),
		makeTelemetryRecord("autonomy.cap_reached", { kind: "calls", limit: 2, ...usage, openDecisions: 0 }, ctx, at("1")),
		makeTelemetryRecord("autonomy.resumed", { cleared: "calls" }, ctx, at("2")),
		makeTelemetryRecord("autonomy.open_decision", { tool: "bash", kind: "operator-only", seq: 1 }, ctx, at("3")),
		makeTelemetryRecord(
			"autonomy.open_decision",
			{ tool: "bash", kind: "judge-block", rule: "exfil", seq: 2 },
			ctx,
			at("4"),
		),
		makeTelemetryRecord("autonomy.open_decision", { tool: "write", kind: "judge-block", seq: 3 }, ctx, at("5")),
		makeTelemetryRecord("autonomy.cap_reached", { kind: "judge", ...usage, openDecisions: 3 }, ctx, at("6")),
		makeTelemetryRecord("autonomy.ended", { reason: "judge-streak", ...usage, openDecisions: 3 }, ctx, at("7")),
	];
	const why = whyStopped({ ...source, sessionId: "yolo-records", journal: { ...source.journal, records } }, now);
	ok(Value.Check(WhyStoppedSchema, why), [...Value.Errors(WhyStoppedSchema, why)][0]?.message);
	deepStrictEqual(why.autonomy, {
		halt: { at: "2026-10-30T00:00:06.000Z", kind: "judge" },
		ended: { at: "2026-10-30T00:00:07.000Z", reason: "judge-streak" },
		openDecisions: 3,
		kinds: [
			{ kind: "operator-only", count: 1 },
			{ kind: "judge-block", count: 2 },
		],
	});
	deepStrictEqual(
		why.findings.filter((line) => line.startsWith("Yolo")),
		[
			"Yolo ended the run at 2026-10-30T00:00:06.000Z: the safety judge blocked too many calls (judge-streak).",
			"Yolo left 3 open decisions for the operator: 1 operator-only, 2 judge-block.",
		],
	);
	strictEqual(whyStopped(source, now).autonomy, undefined);
});

test("the timeline carries tool, middleware, auth, prompt, context, System One and worker channel records (#434 §8)", () => {
	const ctx = {
		sessionId: "timeline-signals",
		agent: { role: "main" as const, id: "timeline-signals" },
		turnId: "turn-1",
	};
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
			"auth.refreshed",
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
			"context.snapshotted",
			{
				snapshotId: "snap-1",
				providerId: "local",
				runtimeId: "fixture",
				modelId: "model",
				splits: {},
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
					streaming: 500,
				},
				window: { desired: 10_000, effective: 10_000, source: "catalog" },
				source: "reconciled",
				estimatedTokens: 900,
				reconciledTokens: 1000,
			},
			ctx,
			clock(3),
		),
		makeTelemetryRecord(
			"system_one.decided",
			{
				point: "consult",
				set: "consult-v1",
				askId: "dc_1",
				outcome: "timeout",
				latencyMs: 900,
				deadlineMs: 800,
				asked: 2,
				abstained: 2,
				routes: [{ engine: "local", kind: "systemone", profile: "generic", outcome: "timeout", breaker: "opened" }],
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
		makeTelemetryRecord("run.linked", { runId: "run-signals" }, ctx, clock(7)),
	];
	const run = [
		makeTelemetryRecord(
			"worker.channel_failed",
			{ lane: "stdin", frameType: "steer", errno: "EPIPE", afterExit: true, failure: "write-failed" },
			{ sessionId: "timeline-signals", runId: "run-signals", agent: { role: "worker", id: "run-signals" } },
			clock(8),
		),
	];
	const recorded: SessionSource = {
		...source,
		sessionId: "timeline-signals",
		journal: { ...source.journal, records },
		runs: new Map([["run-signals", { present: true, records: run, modes: ["standard"], skipped: 0, damaged: 0 }]]),
	};
	const dto = timeline(recorded, null, now);
	ok(Value.Check(TimelineSchema, dto), [...Value.Errors(TimelineSchema, dto)][0]?.message);
	deepStrictEqual(
		dto.entries.map((entry) => entry.kind),
		["auth", "prompt", "context", "system-one", "middleware", "tool", "run", "worker-channel"],
	);
	const tool = dto.entries.find((entry) => entry.kind === "tool");
	strictEqual(tool?.kind === "tool" ? tool.duration.display : null, "1.25s");
	const context = dto.entries.find((entry) => entry.kind === "context");
	strictEqual(context?.kind === "context" ? context.estimated?.display : null, "~900 (chars/4)");
	deepStrictEqual(context?.kind === "context" ? context.window.display : null, {
		desired: "10,000",
		effective: "10,000",
	});
	const occupied = sessionTelemetry(recorded, now).context;
	deepStrictEqual(occupied.used.fact, { kind: "measured", value: 1500, source: "provider" });
	deepStrictEqual(occupied.share.fact, { kind: "measured", value: 15, source: "provider" });
	deepStrictEqual(explain(occupied.used.ref, { session: recorded }, now)?.value, occupied.used);
	deepStrictEqual(explain(occupied.share.ref, { session: recorded }, now)?.value, occupied.share);
	const estimatedRecords = records.map((record) => {
		if (record.k !== "context.snapshotted") return record;
		const { reconciledTokens: _reconciled, ...data } = record.data;
		return { ...record, data };
	});
	const estimated = sessionTelemetry(
		{ ...recorded, journal: { ...recorded.journal, records: estimatedRecords } },
		now,
	).context;
	deepStrictEqual(estimated.used.fact, { kind: "estimated", value: 1400, method: "chars/4" });
	deepStrictEqual(estimated.share.fact, { kind: "estimated", value: 14, method: "chars/4" });
	const prompt = dto.entries.find((entry) => entry.kind === "prompt");
	strictEqual(prompt?.kind === "prompt" ? prompt.sectionsShown.display : null, "12");
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

test("a model's cost splits into the sessions' own calls and the worker runs, in a session and a repository window (#434 §11.3)", () => {
	const journal = (records: readonly TelemetryRecord[]) => ({
		present: true,
		records,
		modes: ["standard" as const],
		skipped: 0,
		damaged: 0,
	});
	const inRun = (runId: string, records: TelemetryRecord[]) =>
		records.map((record) => ({ ...record, ctx: { ...record.ctx, runId } }) as TelemetryRecord);
	const main = telemetryCall("split-session", { model: "shared", usd: 0.5 });
	const ref = makeTelemetryRecord(
		"run.linked",
		{ runId: "run-owned" },
		main[0]?.ctx ?? { sessionId: "split-session", agent: { role: "main", id: "split-session" } },
		{
			t: main[0]?.t ?? now.now.toISOString(),
			mono: 0,
		},
	);
	const session: SessionSource = {
		...source,
		sessionId: "split-session",
		journal: journal([...main, ref]),
		runs: new Map([
			[
				"run-owned",
				journal(inRun("run-owned", telemetryCall("split-session", { role: "worker", model: "shared", usd: 0.25 }))),
			],
		]),
	};
	const standalone = inRun(
		"run-standalone",
		telemetryCall("split-session", { role: "worker", model: "shared", usd: 0.125 }),
	);
	const repo: RepoSource = {
		owner: repoOwner(null, 30),
		sessions: [session],
		runs: new Map([["run-standalone", journal(standalone)]]),
	};
	const usd = (quantity: { fact: unknown }) => (quantity.fact as FactSum).measured;
	const check = (report: CostReportV1, own: number, runs: number, explainIn: Parameters<typeof explain>[1]) => {
		ok(Value.Check(CostReportSchema, report), [...Value.Errors(CostReportSchema, report)][0]?.message);
		const [group] = report.groups;
		strictEqual(report.groups.length, 1, "one model, whoever called it");
		const audience = group?.audience;
		if (!group || !audience) throw new Error("a model row carries its audience split");
		strictEqual(usd(group.usd), own + runs);
		strictEqual(usd(audience.session.usd), own);
		strictEqual(usd(audience.worker.usd), runs);
		strictEqual(parseFactRef(audience.session.usd.ref)?.scope, "own");
		strictEqual(parseFactRef(audience.worker.usd.ref)?.scope, "runs");
		for (const quantity of [audience.session.usd, audience.worker.tokens, audience.worker.calls])
			deepStrictEqual(explain(quantity.ref, explainIn, now)?.value, quantity, quantity.ref);
	};
	check(costReport(session, "model", now), 0.5, 0.25, { session });
	check(repoCostReport(repo, { repo: "all", days: 30 }, "model", now), 0.5, 0.375, { repo });
	ok(repoCostReport(repo, { repo: "all", days: 30 }, "role", now).groups.every((group) => group.audience === null));
});

test("a cache break re-prefills past the shared band, or an unknown amount on a missed cache, never a boundary loss (#423, #434 §13.2)", () => {
	// Attempts sort by start time, then attempt id; ids minted in one millisecond are random
	// UUIDv7s, so each call gets its own start second to keep the journal order.
	let second = 0;
	const call = (
		verdict: CallSettled["cache"]["verdict"],
		rePrefilled: CallSettled["cache"]["rePrefilledTokens"],
		cacheRead: number | null = 0,
		timed?: { input: number; uncached: number },
	) =>
		telemetryCall("cache-breaks", {
			at: new Date(Date.UTC(2026, 10, 6, 12, 0, second++)).toISOString(),
			usage: { cacheRead, ...(timed ? { input: timed.input } : {}) },
		}).map((record) =>
			record.k === "call.settled"
				? ({
						...record,
						data: {
							...record.data,
							cache: {
								...record.data.cache,
								verdict,
								rePrefilledTokens: rePrefilled,
								...(timed ? { uncachedPrefillTokens: { kind: "measured", value: timed.uncached, source: "provider" } } : {}),
							},
						},
					} as TelemetryRecord)
				: record,
		);
	const measured = (value: number) => ({ kind: "measured" as const, value, source: "local-count" as const });
	const unknown = { kind: "unknown" as const, reason: "not-observed" as const };
	const report = cacheReport(
		{
			...source,
			sessionId: "cache-breaks",
			journal: {
				...source.journal,
				records: [
					// An ordinary tool-result append on a warm prefix.
					...call("partial", measured(0)),
					// What an append loses at the provider's 128-token boundaries, and a loss under a tenth of the prefix.
					...call("partial", measured(849), 200_000),
					...call("partial", measured(5_000), 100_000),
					// A server whose usage omits its read, which read its prompt less the prefill its timings measured.
					...call("partial", measured(5_000), null, { input: 100_000, uncached: 5_000 }),
					...call("partial", measured(4_096)),
					...call("partial", unknown),
					...call("cold", unknown),
					...call("hot", unknown),
				],
			},
		},
		now,
	);
	deepStrictEqual(
		report.breaks.map((row) => row.verdict),
		["partial", "partial", "cold"],
	);
});

test("C-05: cached share skips an omitted read, and whole-block reads learn the engine floor", () => {
	let second = 0;
	const call = (cacheRead: number | null, input: number, verdict: CallSettled["cache"]["verdict"]) =>
		telemetryCall("cache-floor", {
			at: new Date(Date.UTC(2026, 10, 6, 12, 0, second++)).toISOString(),
			usage: { cacheRead, input },
			cache: { verdict, uncachedPrefillTokens: { kind: "unknown", reason: "not-observed" } },
		});
	const report = cacheReport(
		{
			...source,
			sessionId: "cache-floor",
			journal: {
				...source.journal,
				records: [
					...call(null, 9_000, "unknown"),
					...call(6_144, 2_600, "partial"),
					...call(6_144, 2_700, "partial"),
					...call(8_192, 2_100, "partial"),
				],
			},
		},
		now,
	);
	deepStrictEqual(
		report.engineFloor?.map((row) => [row.granularity, row.calls]),
		[[2_048, 3]],
	);
	deepStrictEqual([report.verdicts.hot, report.verdicts.partial, report.breaks.length], [3, 0, 0]);
	const share = report.share?.fact;
	ok(share?.kind === "measured" && Math.abs(share.value - (100 * 20_480) / (20_480 + 7_400)) < 1e-9);
});

test("a resumed request that departs from the last journaled one mid-transcript is a replay mismatch", () => {
	let second = 0;
	const d = (c: string) => c.repeat(16);
	const call = (structure: NonNullable<CallSettled["cache"]["structure"]>) =>
		telemetryCall("cache-replay", {
			at: new Date(Date.UTC(2026, 10, 6, 12, 0, second++)).toISOString(),
			usage: { cacheRead: 0, input: 9_000 },
			cache: { verdict: "cold", rePrefilledTokens: { kind: "unknown", reason: "not-observed" }, structure },
		});
	const head = { system: d("a"), tools: d("b") };
	const sourceOf = (resumed: string[]): SessionSource => ({
		...source,
		sessionId: "cache-replay",
		journal: {
			...source.journal,
			records: [
				// One process: the first request lists its transcript, the next only what it appended.
				...call({ ...head, entries: [`user:${d("1")}`] }),
				...call({ ...head, base: 1, entries: [`assistant:${d("2")}`, `toolResult:${d("3")}`] }),
				// The next process lists the whole transcript again.
				...call({ ...head, entries: resumed }),
			],
		},
	});
	const report = (resumed: string[]) => cacheReport(sourceOf(resumed), now);
	const mismatched = [`user:${d("1")}`, `assistant:${d("9")}`, `toolResult:${d("3")}`, `user:${d("4")}`];
	const replayed = report(mismatched);
	deepStrictEqual(
		replayed.byCause.map((row) => [row.cause, row.breaks]),
		[
			["replay_mismatch", 1],
			["unattributed", 2],
		],
	);
	strictEqual(replayed.breaks.at(-1)?.firstDivergentSection.display, "message[1]:assistant");
	// The report, and the session DTO ACP's usage update carries, name the replay's breaks and where it departed.
	const fromDto = sessionTelemetry(sourceOf(mismatched)).context.cache?.replayMismatch;
	for (const replay of [replayed.replayMismatch, fromDto])
		deepStrictEqual([replay?.breaks, replay?.firstDivergentSection.display], [1, "message[1]:assistant"]);
	// A resume that only extends the journaled transcript replayed it exactly.
	const exact = [`user:${d("1")}`, `assistant:${d("2")}`, `toolResult:${d("3")}`, `user:${d("4")}`];
	const extended = report(exact);
	deepStrictEqual(
		extended.byCause.map((row) => [row.cause, row.breaks]),
		[["unattributed", 3]],
	);
	strictEqual(extended.replayMismatch, undefined);
	strictEqual(sessionTelemetry(sourceOf(exact)).context.cache?.replayMismatch, undefined);
});
