import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CallLabel, Disposition } from "../../src/core/telemetry/enums.js";
import type { TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { makeTelemetryRecord } from "../../src/core/telemetry/envelope.js";
import type { Fact } from "../../src/core/telemetry/fact.js";
import { newAttemptId, newCallId, newRecordId } from "../../src/core/telemetry/ids.js";
import type { PendingTelemetry } from "../../src/core/telemetry/producer.js";
import type { CallSettled } from "../../src/core/telemetry/schemas.js";
import { openCallJournal } from "../../src/domains/observability/call-journal.js";
import type { TelemetryReadModel, TelemetryView } from "../../src/domains/observability/contract.js";
import type { JournalSource } from "../../src/domains/observability/read-model.js";
import { callsReport, costReport, runsReport, sessionTelemetry } from "../../src/domains/observability/read-model.js";
import { telemetryView } from "../../src/domains/observability/telemetry-live.js";
import { isSessionEntry } from "../../src/domains/session/entries.js";
import { importLegacySession } from "../../src/domains/session/legacy-import.js";
import { loadSessionTelemetrySource } from "../../src/domains/session/telemetry-source.js";
import type { DispatchRunUsage } from "../../src/interactive/dispatch-board.js";
import { dispatchRunUsage } from "../../src/interactive/dispatch-board.js";

/**
 * A `TelemetryView` built through the real read model, for surface fixtures (#434 §11.3). A surface test feeds it
 * the records its scenario needs and asserts what the surface renders, so no fixture restates a number the read
 * model would compute differently.
 */
export function telemetryViewOf(
	sessionId: string,
	records: readonly TelemetryRecord[],
	runs: ReadonlyMap<string, readonly TelemetryRecord[]> = new Map(),
): TelemetryView {
	const journal = (owned: readonly TelemetryRecord[]): JournalSource => ({
		present: owned.length > 0,
		records: owned,
		modes: ["standard"],
		skipped: 0,
		damaged: 0,
	});
	return telemetryView({
		sessionId,
		journal: journal(records),
		legacy: { records: [], aggregates: 0 },
		runs: new Map([...runs].map(([runId, owned]) => [runId, journal(owned)])),
		parent: null,
	});
}

/** The golden P0 ledger's calls, imported with stable ids: five calls, one never sent, one with unknown usage. */
export function goldenTelemetryRecords(sessionId = "golden-p0"): TelemetryRecord[] {
	const ledger = readFileSync(new URL("../fixtures/telemetry/golden/p0/current.jsonl", import.meta.url), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as unknown)
		.filter(isSessionEntry);
	return importLegacySession(sessionId, ledger, { ids: "derived" }).records;
}

export interface TelemetryCallOptions {
	label?: CallLabel;
	targetId?: string;
	/** The model the provider reported; it names the call's `target/model` group. */
	model?: string;
	turnId?: string;
	at?: string;
	/** Token counts; null is a count the provider did not report. Omitted counts are a measured zero. */
	usage?: Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite" | "reasoning", number | null>>;
	/** null is a cost nobody could price. */
	usd?: number | null;
	pricedBy?: CallSettled["pricing"]["pricedBy"];
	disposition?: Disposition;
	/** An interrupted call's display estimate, as the producer journals it beside the usage. */
	interruptedEstimate?: CallSettled["interruptedEstimate"];
	/** Cache facts over the golden call's own. */
	cache?: Partial<CallSettled["cache"]>;
}

/** One call's started and settled records, cloned from a golden settled call with fresh ids and the given facts. */
export function telemetryCall(sessionId: string, options: TelemetryCallOptions = {}): TelemetryRecord[] {
	const golden = goldenTelemetryRecords(sessionId);
	const settled = golden.find((record) => record.k === "call.settled" && record.data.disposition === "settled");
	if (settled?.k !== "call.settled" || settled.data.usage === null) throw new Error("golden settled call missing");
	const started = golden.find((record) => record.k === "call.started" && record.data.callId === settled.data.callId);
	if (started?.k !== "call.started") throw new Error("golden started call missing");
	// The golden call's reported total describes its own counts, not the ones given here.
	const { total: _total, ...base } = settled.data.usage;
	const label = options.label ?? "main";
	const callId = newCallId();
	const attemptId = newAttemptId();
	const at = options.at ?? settled.t;
	const ctx = { ...settled.ctx, label, callId, attemptId, ...(options.turnId ? { turnId: options.turnId } : {}) };
	const model = options.model ?? "fixture-model";
	const target = {
		...started.data.target,
		targetId: options.targetId ?? "fixture",
		requestedModel: model,
		reportedModel: { kind: "measured" as const, value: model, source: "provider" as const },
	};
	const count = (value: number | null | undefined): Fact<number> =>
		value === null
			? { kind: "unknown", reason: "provider-omitted" }
			: { kind: "measured", value: value ?? 0, source: "provider" };
	const pricedBy = options.pricedBy ?? (options.usd === null ? "none" : "target-rates");
	const usd: Fact<number> =
		options.usd === null
			? { kind: "unknown", reason: "provider-omitted" }
			: pricedBy === "catalog"
				? { kind: "estimated", value: options.usd ?? 0, method: "catalog" }
				: { kind: "measured", value: options.usd ?? 0, source: "local-count" };
	const usage = options.usage ?? {};
	return [
		{ ...started, id: newRecordId(), t: at, ctx, data: { ...started.data, callId, attemptId, label, target } },
		{
			...settled,
			id: newRecordId(),
			t: at,
			ctx,
			data: {
				...settled.data,
				callId,
				attemptId,
				label,
				target,
				disposition: options.disposition ?? "settled",
				usage: {
					...base,
					input: count(usage.input),
					output: count(usage.output),
					cacheRead: count(usage.cacheRead),
					cacheWrite: count(usage.cacheWrite),
					reasoning: count(usage.reasoning),
				},
				pricing: { usd, pricedBy },
				cache: { ...settled.data.cache, ...options.cache },
				...(options.interruptedEstimate ? { interruptedEstimate: options.interruptedEstimate } : {}),
			},
		},
	];
}

/** A board run's usage read through the real read model from the calls its run journal holds (#434 §11.3). */
export function runUsageOf(
	runId: string,
	calls: readonly TelemetryCallOptions[],
	sessionId = "fixture-session",
): DispatchRunUsage {
	const records = calls.flatMap((call) => telemetryCall(sessionId, call));
	return dispatchRunUsage(telemetryViewOf(sessionId, [], new Map([[runId, records]])), runId);
}

/**
 * A live read model over records a test appends as its scenario runs, for surfaces that take the read model rather
 * than one view (#434 §11.3). `sessionId` names the session it is bound to once the surface opens one.
 */
export function readModelOf(
	sessionId: () => string | null,
	records: () => readonly TelemetryRecord[],
	runs: () => ReadonlyMap<string, readonly TelemetryRecord[]> = () => new Map(),
): TelemetryReadModel {
	const viewOf = (id: string) =>
		telemetryViewOf(
			id,
			records().map((record) => ({ ...record, ctx: { ...record.ctx, sessionId: id } }) as TelemetryRecord),
			runs(),
		);
	return {
		live: () => {
			const id = sessionId();
			return id === null ? null : viewOf(id);
		},
		open: async (id: string) => viewOf(id),
		subscribe: () => () => {},
	} as unknown as TelemetryReadModel;
}

export const PARITY_SESSION = "parity";
export const PARITY_RUN = "parity-run";

/**
 * The cross-surface parity fixture (#434 §13.2) as journals on disk, where the CLI, the GUI and the live model each
 * read it: the golden P0 calls, a catalog-estimated side call, a newest main call whose output and price went
 * unreported, and a referenced worker run with one priced call and one unpriced. Every provenance a surface must
 * carry through appears at least once.
 */
export async function seedParitySession(stateDir: string): Promise<void> {
	const golden = goldenTelemetryRecords(PARITY_SESSION);
	const last = Math.max(...golden.map((record) => Date.parse(record.t)));
	const at = (minutes: number) => new Date(last + minutes * 60_000).toISOString();
	const side = telemetryCall(PARITY_SESSION, {
		label: "memory",
		usage: { input: 120, output: 30 },
		usd: 0.002,
		pricedBy: "catalog",
		at: at(1),
	});
	const main = telemetryCall(PARITY_SESSION, {
		turnId: "turn-parity",
		usage: { input: 7, output: null, cacheRead: 900 },
		usd: null,
		at: at(3),
	});
	// The newest main call read 900 cached tokens and prefilled 7, so /context has a verdict and its numbers to show.
	const settled = main[1] as Extract<TelemetryRecord, { k: "call.settled" }>;
	const measured = (value: number) => ({ kind: "measured" as const, value, source: "provider" as const });
	main[1] = {
		...settled,
		data: {
			...settled.data,
			cache: {
				...settled.data.cache,
				verdict: "small",
				uncachedPrefillTokens: measured(7),
				rePrefilledTokens: measured(0),
			},
		},
	};
	const ref = makeTelemetryRecord("run.ref", { runId: PARITY_RUN }, settled.ctx, { t: at(2), mono: 0 });
	const worker = [
		...telemetryCall(PARITY_SESSION, { label: "worker", usage: { input: 50, output: 10 }, usd: 0.25, at: at(2) }),
		...telemetryCall(PARITY_SESSION, { label: "worker", usage: { input: 20, output: null }, usd: null, at: at(2) }),
	].map((record) => ({ ...record, ctx: { ...record.ctx, runId: PARITY_RUN } }) as TelemetryRecord);
	const write = async (
		directory: string,
		fileName: "calls.jsonl" | "events.ndjson",
		context: TelemetryRecord["ctx"],
		records: TelemetryRecord[],
	) => {
		const journal = await openCallJournal({
			sessionDirectory: directory,
			fileName,
			context,
			writer: { clioCoderVersion: "test", piVersion: "test" },
		});
		for (const record of records)
			journal.enqueue({
				kind: record.k,
				data: record.data,
				ctx: record.ctx,
				wallMs: Date.parse(record.t),
				mono: record.mono,
				recordId: record.id,
			} as PendingTelemetry);
		await journal.close();
	};
	await write(join(stateDir, "sessions", "parity-workspace", PARITY_SESSION), "calls.jsonl", settled.ctx, [
		...golden,
		...side,
		ref,
		...main,
	]);
	await write(
		join(stateDir, "runs", PARITY_RUN),
		"events.ndjson",
		{ ...settled.ctx, runId: PARITY_RUN, label: "worker" },
		worker,
	);
}

/** The parity fixture's DTOs as the CLI's `--json` and the GUI's routes read them: cold, from the journals. */
export function coldParityDtos(stateDir: string) {
	const source = loadSessionTelemetrySource(stateDir, PARITY_SESSION);
	if (!source) throw new Error("the parity fixture has no session on disk");
	return {
		source,
		session: sessionTelemetry(source),
		costByModel: costReport(source, "model"),
		costByLabel: costReport(source, "label"),
		calls: callsReport(source),
		runs: runsReport(source),
	};
}
