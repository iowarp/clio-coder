/**
 * P3 lie detectors over the read model (#434 §13.1): the golden P0 ledger, imported with stable ids, builds every
 * session DTO, and every quantity in them must hold L1 (unknown never zero), L2 (never-sent carries nothing), L3 (a
 * partial sum is never a total), L5 (every number resolves through explain to the same fact) and L9 (absent is
 * neither unknown nor zero). The detectors live in tests/harness/telemetry-lies.ts so the GUI route tests run the
 * same ones over the DTOs they serve.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	CacheReportSchema,
	CallsReportSchema,
	CostReportSchema,
	SessionTelemetrySchema,
	TimelineSchema,
	WhyStoppedSchema,
} from "../../src/core/telemetry/dto.js";
import type { TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import type { PendingTelemetry } from "../../src/core/telemetry/producer.js";
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
		for (const record of [main[0], side[0], side[1], main[1]]) {
			await write([record as TelemetryRecord]);
			model.live()?.cost("turn");
		}
		equalsCold(imported.records.length + 4);
	} finally {
		model.stop();
		await writer.close();
	}
});
