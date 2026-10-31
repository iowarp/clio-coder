import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openCallJournal } from "../../../../src/domains/telemetry/call-journal.js";

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
 * The golden P0 ledger as a session on disk, where the read model's cold loader finds it: a ledger written before
 * the call journal, which the loader imports with derived ids. Returns the session id the routes take.
 */
export function seedGoldenSession(state: string, sessionId = "golden-p0"): string {
	const ledger = readFileSync(
		fileURLToPath(new URL("../../../../tests/fixtures/telemetry/golden/p0/current.jsonl", import.meta.url)),
	);
	const directory = join(state, "sessions", "golden-workspace", sessionId);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "current.jsonl"), ledger);
	return sessionId;
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
	const context = { sessionId: null, runId, label: "worker" } as const;
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
