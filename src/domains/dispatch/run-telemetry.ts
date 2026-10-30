import { join } from "node:path";
import { writeDiagnostic } from "../../core/diagnostics.js";
import { resolvePackageRoot } from "../../core/package-root.js";
import type { TelemetryContext, WorkerTelemetryContext } from "../../core/telemetry/context.js";
import { readWorkerTelemetryFrame } from "../../core/telemetry/forwarder.js";
import { recordTelemetry } from "../../core/telemetry/producer.js";
import type { CallJournal } from "../observability/call-journal.js";
import type { RunEventJournalBody } from "./run-event-journal.js";

export interface RunTelemetryJournal {
	context: WorkerTelemetryContext;
	closed: boolean;
	worker(frame: unknown): boolean;
	linkSession(context: TelemetryContext): void;
	gap(reason: "invalid-record" | "writer-drop", count?: number): void;
	feed(body: RunEventJournalBody, capBytes: number): void;
	flush(): Promise<void>;
	close(): Promise<void>;
}

const journals = new Map<string, RunTelemetryJournal>();

/** Display and call producers share the run's single writer (#434). */
export function runTelemetryJournal(runId: string): RunTelemetryJournal | undefined {
	return journals.get(runId);
}

const opening = new Map<string, Promise<RunTelemetryJournal>>();

export function openRunTelemetry(context: WorkerTelemetryContext, directory: string): Promise<RunTelemetryJournal> {
	const pending = opening.get(context.runId);
	if (pending)
		return pending.then((journal) => {
			if (JSON.stringify(journal.context) !== JSON.stringify(context)) throw new Error("run telemetry owner changed");
			return journal;
		});
	const ready = openOwnedRunTelemetry(context, directory).finally(() => opening.delete(context.runId));
	opening.set(context.runId, ready);
	return ready;
}

/** Only dispatch opens owners. Viewers and the display registry never acquire a second writer (#434). */
async function openOwnedRunTelemetry(context: WorkerTelemetryContext, directory: string): Promise<RunTelemetryJournal> {
	const existing = journals.get(context.runId);
	if (existing) {
		if (JSON.stringify(existing.context) !== JSON.stringify(context) || existing.closed)
			throw new Error("run telemetry owner changed or closed");
		return existing;
	}
	const [{ openCallJournal, readCallJournal }, { readFile }] = await Promise.all([
		import("../observability/call-journal.js"),
		import("node:fs/promises"),
	]);
	const pkg = JSON.parse(await readFile(join(resolvePackageRoot(), "package.json"), "utf8")) as {
		version: string;
		dependencies: Record<string, string>;
	};
	const previous = await readCallJournal(directory, "events.ndjson");
	let seq = previous.records.reduce(
		(max, { record }) => (record.k === "run.feed" ? Math.max(max, record.data.seq) : max),
		0,
	);
	const writer: CallJournal = await openCallJournal({
		sessionDirectory: directory,
		fileName: "events.ndjson",
		context,
		writer: { clioVersion: pkg.version, piVersion: pkg.dependencies["@earendil-works/pi-ai"] ?? "unknown" },
	});
	let closing: Promise<void> | undefined;
	let parent: TelemetryContext | undefined;
	const references = new Set<string>();
	let feedClosed = previous.records.some(
		({ record }) => record.k === "run.feed" && record.data.body.kind === "terminal",
	);
	let feedBytes = previous.records.reduce(
		(bytes, { record }) => (record.k === "run.feed" ? bytes + Buffer.byteLength(JSON.stringify(record)) : bytes),
		0,
	);
	let dropping = previous.records.some(
		({ record }) => record.k === "run.feed" && record.data.body.kind === "journal_truncated",
	);
	let reported = false;
	const reportHealth = () => {
		const health = writer.health();
		if (!reported && (health.writeErrors > 0 || health.dropped > 0 || health.invalid > 0)) {
			reported = true;
			writeDiagnostic("[clio-coder:telemetry] run journal coverage is incomplete\n");
		}
	};
	const journal: RunTelemetryJournal = {
		context,
		closed: false,
		linkSession(owner) {
			if (owner.sessionId === null || owner.sessionId !== context.sessionId || owner.runId !== undefined)
				throw new Error("run call reference requires its parent session owner");
			parent = owner;
		},
		worker(frame) {
			const record = readWorkerTelemetryFrame(frame, context);
			if (journal.closed || record === null || !writer.enqueue(record)) return false;
			if (parent && (record.kind === "call.started" || record.kind === "call.settled")) {
				const callId = record.data.callId;
				if (!references.has(callId) && recordTelemetry("call.ref", { runId: context.runId, callId }, parent))
					references.add(callId);
			}
			return true;
		},
		gap(reason, count = 1) {
			if (journal.closed) return;
			writer.enqueue({
				kind: "gap",
				data: { sink: "worker-ndjson", reason, count },
				ctx: context,
				wallMs: Date.now(),
				mono: performance.now(),
			});
		},
		feed(body, capBytes) {
			if (journal.closed || feedClosed) return;
			if (body.kind === "event" && (dropping || feedBytes >= capBytes)) {
				if (!dropping) {
					dropping = true;
					journal.feed({ kind: "journal_truncated", reason: "per-run size cap", droppedFromSeq: seq + 1 }, capBytes);
				}
				return;
			}
			feedBytes += Buffer.byteLength(JSON.stringify(body));
			writer.enqueue({
				kind: "run.feed",
				data: { seq: ++seq, body: { ...body } },
				ctx: context,
				wallMs: Date.now(),
				mono: performance.now(),
			});
			if (body.kind === "terminal") feedClosed = true;
		},
		async flush() {
			await writer.flush();
			reportHealth();
		},
		close() {
			if (closing) return closing;
			journal.closed = true;
			closing = writer
				.close()
				.then(reportHealth)
				.catch(() => {
					writeDiagnostic("[clio-coder:telemetry] run journal close failed; recorded coverage may be incomplete\n");
				});
			return closing;
		},
	};
	journals.set(context.runId, journal);
	// Closed tombstones suppress late display events; older files are also recognized by the legacy writer (#434).
	for (const [id, owned] of journals) {
		if (journals.size <= 256) break;
		if (owned.closed) journals.delete(id);
	}
	return journal;
}
