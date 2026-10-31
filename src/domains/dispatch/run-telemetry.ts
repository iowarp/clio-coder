import { join } from "node:path";
import { writeDiagnostic } from "../../core/diagnostics.js";
import { resolvePackageRoot } from "../../core/package-root.js";
import type { TelemetryContext, WorkerTelemetryContext } from "../../core/telemetry/context.js";
import { isWorkerTelemetryContext } from "../../core/telemetry/context.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { EventPayload } from "../../core/telemetry/events.js";
import { readWorkerTelemetryFrame } from "../../core/telemetry/forwarder.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import type { StructuralRunFeedBody } from "../../core/telemetry/schemas.js";
import { RUN_FEED_EVENTS, RUN_FEED_OUTCOMES } from "../../core/telemetry/schemas.js";
import type { CallJournal } from "../telemetry/call-journal.js";
import type { RunEventJournalBody } from "./run-event-journal.js";

export interface RunTelemetryJournal {
	context: WorkerTelemetryContext;
	closed: boolean;
	/**
	 * False when the frame is refused. The journal records its own reason: an invalid frame leaves an invalid-record
	 * gap, a refused enqueue the writer's own writer-drop gap, and a closed journal can write nothing (#434).
	 */
	worker(frame: unknown): boolean;
	/** Host settlements for attempts the worker started and never settled (#434). */
	settleCalls(records: readonly TelemetryRecord<"call.settled">[]): void;
	linkSession(context: TelemetryContext): void;
	gap(reason: "invalid-record" | "writer-drop", count?: number): void;
	/** The run's one terminal accountability record, written beside its call facts (#425, #434). */
	settle(data: EventPayload<"run.settled">): void;
	/** A channel failure the host saw, after exit included; a closed journal records nothing (#425). */
	channel(data: EventPayload<"worker.channel_failed">): void;
	feed(body: RunEventJournalBody, capBytes: number): void;
	flush(): Promise<void>;
	close(): Promise<void>;
}

/** Select structural fields; prose and free-text details stay in existing output artifacts (#434). */
function structuralFeed(body: RunEventJournalBody): StructuralRunFeedBody | null {
	const outcome = (value: string) => RUN_FEED_OUTCOMES.find((known) => known === value) ?? "unknown";
	switch (body.kind) {
		case "open":
			return { kind: body.kind, runId: body.runId, agentId: body.agentId };
		case "terminal":
			return { kind: body.kind, outcome: outcome(body.outcome) };
		case "receipt":
			return {
				kind: body.kind,
				outcome: outcome(body.outcome),
				exitCode: body.exitCode,
				...(body.attemptRunId !== undefined ? { attemptRunId: body.attemptRunId } : {}),
			};
		case "journal_truncated":
			return { kind: body.kind, reason: "per-run size cap", droppedFromSeq: body.droppedFromSeq };
		case "event":
			if (body.type === "text" || body.type === "text_delta" || body.type === "thinking_delta") return null;
			return {
				kind: body.kind,
				type: RUN_FEED_EVENTS.find((known) => known === body.type) ?? "unknown",
				...(body.tool !== undefined ? { tool: body.tool } : {}),
				...(body.callId !== undefined ? { callId: body.callId } : {}),
				...(body.outcome !== undefined ? { outcome: body.outcome } : {}),
				...(body.durationMs !== undefined ? { durationMs: body.durationMs } : {}),
			};
	}
}

const journals = new Map<string, RunTelemetryJournal>();

/** Display and call producers share the run's single writer (#434). */
export function runTelemetryJournal(runId: string): RunTelemetryJournal | undefined {
	return journals.get(runId);
}

const opening = new Map<string, Promise<RunTelemetryJournal>>();
/** Every attempt opens a journal before it spawns, so the package versions are read once per process (#434). */
let writerVersions: Promise<{ clioCoderVersion: string; piVersion: string }> | undefined;

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

/**
 * Journal the run.settled a run's host died before writing, from recovery's verdict. Only a journal that exists and
 * holds none is written, under the worker context its own run records carry, so its turn stops reading as running
 * (#425, #434).
 */
export async function settleOrphanedRunJournal(directory: string, facts: EventPayload<"run.settled">): Promise<void> {
	const { openCallJournal, readCallJournal } = await import("../telemetry/call-journal.js");
	const read = await readCallJournal(directory, "events.ndjson");
	if (read.records.some(({ record }) => record.k === "run.settled")) return;
	const context = read.records.map(({ record }) => record.ctx).find(isWorkerTelemetryContext);
	if (!context) return;
	// The run's owner is gone, so this one record gets a writer of its own rather than the run's owned journal.
	const writer = await openCallJournal({
		sessionDirectory: directory,
		fileName: "events.ndjson",
		context,
		writer: await clioWriterVersions(),
	});
	writer.enqueue({ kind: "run.settled", data: facts, ctx: context, wallMs: Date.now(), mono: performance.now() });
	await writer.close();
}

function clioWriterVersions(): Promise<{ clioCoderVersion: string; piVersion: string }> {
	writerVersions ??= import("node:fs/promises").then(async ({ readFile }) => {
		const pkg = JSON.parse(await readFile(join(resolvePackageRoot(), "package.json"), "utf8")) as {
			version: string;
			dependencies: Record<string, string>;
		};
		return { clioCoderVersion: pkg.version, piVersion: pkg.dependencies["@earendil-works/pi-ai"] ?? "unknown" };
	});
	return writerVersions;
}

/** Only dispatch opens owners. Viewers and the display registry never acquire a second writer (#434). */
async function openOwnedRunTelemetry(context: WorkerTelemetryContext, directory: string): Promise<RunTelemetryJournal> {
	const existing = journals.get(context.runId);
	if (existing) {
		if (JSON.stringify(existing.context) !== JSON.stringify(context) || existing.closed)
			throw new Error("run telemetry owner changed or closed");
		return existing;
	}
	const { openCallJournal, readCallJournal } = await import("../telemetry/call-journal.js");
	const versions = await clioWriterVersions();
	const previous = await readCallJournal(directory, "events.ndjson");
	let seq = previous.records.reduce(
		(max, { record }) => (record.k === "run.feed_appended" ? Math.max(max, record.data.seq) : max),
		0,
	);
	const writer: CallJournal = await openCallJournal({
		sessionDirectory: directory,
		fileName: "events.ndjson",
		context,
		writer: versions,
	});
	let closing: Promise<void> | undefined;
	let parent: TelemetryContext | undefined;
	const references = new Set<string>();
	let feedClosed = previous.records.some(
		({ record }) => record.k === "run.feed_appended" && record.data.body.kind === "terminal",
	);
	let feedBytes = previous.records.reduce(
		(bytes, { record }) => (record.k === "run.feed_appended" ? bytes + Buffer.byteLength(JSON.stringify(record)) : bytes),
		0,
	);
	let dropping = previous.records.some(
		({ record }) => record.k === "run.feed_appended" && record.data.body.kind === "journal_truncated",
	);
	let reported = false;
	let settled = previous.records.some(({ record }) => record.k === "run.settled");
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
			if (journal.closed) return false;
			const record = readWorkerTelemetryFrame(frame, context);
			if (record === null) {
				journal.gap("invalid-record");
				return false;
			}
			if (!writer.enqueue(record)) return false;
			if (parent && (record.kind === "call.started" || record.kind === "call.settled")) {
				const callId = record.data.callId;
				if (!references.has(callId) && telemetryHub().emit("call.linked", { runId: context.runId, callId }, parent))
					references.add(callId);
			}
			if (
				parent &&
				record.kind === "run.usage_reported" &&
				!references.has(context.runId) &&
				telemetryHub().emit("run.linked", { runId: context.runId }, parent)
			)
				references.add(context.runId);
			return true;
		},
		settleCalls(records) {
			if (journal.closed) return;
			for (const record of records)
				writer.enqueue({
					kind: record.k,
					data: record.data,
					ctx: record.ctx,
					wallMs: Date.parse(record.t),
					mono: record.mono,
					recordId: record.id,
				});
		},
		gap(reason, count = 1) {
			if (journal.closed) return;
			writer.enqueue({
				kind: "journal.gap",
				data: { sink: "worker-ndjson", reason, count },
				ctx: context,
				wallMs: Date.now(),
				mono: performance.now(),
			});
		},
		settle(data) {
			if (journal.closed || settled) return;
			settled = true;
			writer.enqueue({ kind: "run.settled", data, ctx: context, wallMs: Date.now(), mono: performance.now() });
		},
		channel(data) {
			if (journal.closed) return;
			writer.enqueue({ kind: "worker.channel_failed", data, ctx: context, wallMs: Date.now(), mono: performance.now() });
		},
		feed(body, capBytes) {
			if (journal.closed || feedClosed) return;
			const structural = structuralFeed(body);
			if (structural === null) return;
			if (body.kind === "event" && (dropping || feedBytes >= capBytes)) {
				if (!dropping) {
					dropping = true;
					journal.feed({ kind: "journal_truncated", reason: "per-run size cap", droppedFromSeq: seq + 1 }, capBytes);
				}
				return;
			}
			// A conservative bound keeps serialization off the producer stack (#434).
			feedBytes +=
				256 +
				Object.values(structural).reduce<number>(
					(sum, value) => sum + (typeof value === "string" ? Buffer.byteLength(value) * 6 : 16),
					0,
				);
			writer.enqueue({
				kind: "run.feed_appended",
				data: { seq: ++seq, body: structural },
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
