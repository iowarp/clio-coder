/**
 * P3 lie detectors over the read model (#434 §13.1): the golden P0 ledger, imported with stable ids, builds every
 * session DTO, and every quantity in them must hold L1 (unknown never zero), L2 (never-sent carries nothing), L3 (a
 * partial sum is never a total), L5 (every number resolves through explain to the same fact) and L9 (absent is
 * neither unknown nor zero).
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { Quantity } from "../../src/core/telemetry/dto.js";
import {
	CacheReportSchema,
	CallsReportSchema,
	CostReportSchema,
	parseFactRef,
	SessionTelemetrySchema,
	TimelineSchema,
	WhyStoppedSchema,
} from "../../src/core/telemetry/dto.js";
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
import { isSessionEntry } from "../../src/domains/session/entries.js";
import { importLegacySession } from "../../src/domains/session/legacy-import.js";

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

function quantities(value: unknown, out: Quantity[] = []): Quantity[] {
	if (Array.isArray(value)) for (const item of value) quantities(item, out);
	else if (value && typeof value === "object") {
		if ("fact" in value && "display" in value && "ref" in value) out.push(value as Quantity);
		else for (const item of Object.values(value)) quantities(item, out);
	}
	return out;
}
const all = dtos.flatMap(([, , dto]) => quantities(dto));
const zero = /^(?:~?\$?0(?:\.0+)?|\$0\.00 local)$/;

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
	for (const quantity of all) {
		ok(parseFactRef(quantity.ref), quantity.ref);
		deepStrictEqual(explain(quantity.ref, { session: source }, now)?.value, quantity, quantity.ref);
		if (!("kind" in quantity.fact) && quantity.fact.coverage.estimated > 0) ok(quantity.display.includes("~"));
		if ("kind" in quantity.fact && quantity.fact.kind === "estimated") ok(quantity.display.includes("~"));
	}
});

test("L1 and L3: unknown is never zero, and a partial sum is never shown as a total", () => {
	for (const { fact, display, ref } of all) {
		if ("kind" in fact) {
			if (fact.kind === "unknown") ok(!zero.test(display) && /unknown|not measured/.test(display), `${ref}: ${display}`);
			continue;
		}
		if (fact.unknownCount === 0) continue;
		ok(!zero.test(display), `${ref}: ${display}`);
		const known = fact.coverage.measured + fact.coverage.estimated > 0;
		ok(known ? /≥|\+\?/.test(display) : /unknown|not measured/.test(display), `${ref}: ${display}`);
	}
});

test("L2 and L9: a never-sent call carries no usage, and absent renders as not applicable", () => {
	const calls = callsReport(source, { dispositions: ["never_sent"] }, now).calls;
	strictEqual(calls.length, 1);
	strictEqual(calls[0]?.usage, null);
	strictEqual("kind" in (calls[0]?.usd.fact ?? {}) ? (calls[0]?.usd.fact as { kind: string }).kind : null, "absent");
	for (const { fact, display, ref } of all) {
		const absent =
			"kind" in fact
				? fact.kind === "absent"
				: fact.absentCount > 0 && fact.coverage.measured + fact.coverage.estimated + fact.unknownCount === 0;
		if (absent) ok(display === "n/a" || display === "not captured (standard mode)", `${ref}: ${display}`);
	}
});
