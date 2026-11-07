import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTelemetryRecord } from "../../../../src/core/telemetry/envelope.js";
import { encodeTelemetryLine } from "../../../../src/core/telemetry/segment.js";
import { noteQuotaRead } from "../../../../src/domains/quota/observed.js";
import { openCallJournal } from "../../../../src/domains/telemetry/call-journal.js";
import { createLiveTelemetryModel } from "../../../../src/domains/telemetry/telemetry-live.js";
import {
	coldParityDtos,
	goldenSessionJournal,
	goldenTelemetryRecords,
	seedParitySession,
} from "../../../../tests/harness/telemetry-view.js";

type PendingTelemetry = Parameters<Awaited<ReturnType<typeof openCallJournal>>["enqueue"]>[0];
type Kind = PendingTelemetry["kind"];

export { dtoLies, quantitiesOf, telemetryLies } from "../../../../tests/harness/telemetry-lies.js";
export {
	coldParityDtos,
	PARITY_SESSION,
	parityUsageFrame,
	seedParitySession,
} from "../../../../tests/harness/telemetry-view.js";

/**
 * The golden P0 session on disk under `sessionId`, where the read model's cold loader finds it: its journal under the
 * telemetry root and a store directory holding an empty ledger, as the session store keeps one. Returns the session id
 * the routes take.
 */
export function seedGoldenSession(
	state: string,
	sessionId = "golden-p0",
	options: { context?: ContextReading } = {},
): string {
	const directory = join(state, "telemetry", "sessions", sessionId);
	mkdirSync(directory, { recursive: true });
	const journal = goldenSessionJournal(sessionId);
	writeFileSync(
		join(directory, "journal.jsonl"),
		options.context ? Buffer.concat([journal, encodeTelemetryLine(contextRecord(sessionId, options.context))]) : journal,
	);
	const store = join(state, "sessions", "golden-workspace", sessionId);
	mkdirSync(store, { recursive: true });
	writeFileSync(join(store, "current.jsonl"), "");
	return sessionId;
}

/** The window figures a context ledger reports, as the CLI journals them after a turn's provider usage settles. */
export interface ContextReading {
	window: number;
	used: number;
	reserve: number;
	free: number;
	system: number;
	messages: number;
}

/** The context snapshot after the golden calls, reconciled against provider usage as a settled turn's is. */
function contextRecord(sessionId: string, reading: ContextReading) {
	const last = goldenTelemetryRecords(sessionId).at(-1);
	if (!last) throw new Error("golden journal has no records");
	return makeTelemetryRecord(
		"context.snapshotted",
		{
			snapshotId: `snap-${sessionId}`,
			providerId: "fixture",
			runtimeId: "fixture",
			modelId: "fixture-model",
			splits: {},
			categories: {
				system: reading.system,
				tools: 0,
				agents: 0,
				skills: 0,
				memory: 0,
				project: 0,
				messages: reading.messages,
				reserve: reading.reserve,
				free: reading.free,
				streaming: 0,
			},
			window: { desired: reading.window, effective: reading.window, source: "catalog" },
			source: "reconciled",
			estimatedTokens: reading.used,
			reconciledTokens: reading.used,
		},
		last.ctx,
		{ t: new Date(Date.parse(last.t) + 60_000).toISOString(), mono: last.mono + 60_000 },
	);
}

/**
 * A worker run journal: its segment header, then `records` under the run's context. With none, a run the read model
 * knows with no calls to fold.
 */
export async function seedRunJournal(
	state: string,
	runId: string,
	records: ReadonlyArray<{ kind: Kind; data: unknown; at: string; ctx?: Record<string, string> }> = [],
): Promise<string> {
	const context = { sessionId: null, runId, agent: { role: "worker", id: runId } } as const;
	const journal = await openCallJournal({
		directory: join(state, "telemetry", "runs", runId),
		context,
		writer: { clioCoderVersion: "test", piVersion: "test" },
	});
	for (const record of records)
		journal.enqueue({
			kind: record.kind,
			data: record.data,
			ctx: { ...context, ...record.ctx },
			wallMs: Date.parse(record.at),
			mono: Date.parse(record.at),
		} as PendingTelemetry);
	await journal.close();
	return runId;
}

/**
 * The DTOs a real CLI's `_clio-coder/telemetry/{session,cost,quota}` answer with, produced here by the read model
 * from the parity fixture and one observed plan reading, then written to `path` for the fixture child to serve. The
 * child is plain node and cannot load the read model itself; the usage route's contract is these DTOs, so the fixture
 * serves exactly what the producer makes rather than hand-written look-alikes.
 */
export async function writeFixtureTelemetry(path: string, scratch: string): Promise<void> {
	await seedParitySession(scratch);
	const dtos = coldParityDtos(scratch);
	const now = Date.now();
	noteQuotaRead(
		{
			providerId: "fixture-plan",
			displayName: "Fixture plan",
			status: "ok",
			plan: "Team",
			windows: [
				{ key: "five-hour", label: "5h", usedPct: 71.4, resetsAt: new Date(now + 3 * 3_600_000).toISOString() },
				{ key: "weekly", label: "Weekly", usedPct: 12, resetsAt: null },
			],
			fetchedAt: new Date(now).toISOString(),
		},
		3_600_000,
		now,
	);
	const model = createLiveTelemetryModel({ stateDir: () => scratch });
	try {
		const quota = model.quota("fixture-plan");
		writeFileSync(path, JSON.stringify({ session: dtos.session, cost: dtos.costByModel, quota }));
	} finally {
		model.stop();
	}
}

export { fixtureEnvelope, fixtureReceiptDraft } from "../../../../tests/harness/receipt.js";
export { writeSettledRun } from "../../../../tests/harness/settled-run.js";
