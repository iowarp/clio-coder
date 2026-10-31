import { join } from "node:path";
import { writeDiagnostic } from "../../core/diagnostics.js";
import { resolvePackageRoot } from "../../core/package-root.js";
import { StateFileLockTimeoutError } from "../../core/state-file-lock.js";
import type { RunOwnerTelemetryContext, TelemetryContext } from "../../core/telemetry/context.js";
import { isRunOwnerTelemetryContext } from "../../core/telemetry/context.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { EventPayload } from "../../core/telemetry/events.js";
import { readWorkerTelemetryFrame } from "../../core/telemetry/forwarder.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import type { StructuralRunFeedBody } from "../../core/telemetry/schemas.js";
import { RUN_FEED_EVENTS, RUN_FEED_OUTCOMES } from "../../core/telemetry/schemas.js";
import { clioStateDir } from "../../core/xdg.js";
import type { RunAssessmentContext } from "../evidence/assessment.js";
import type { CallJournal } from "../telemetry/call-journal.js";
import type { RunEventJournalBody } from "./run-event-journal.js";
import type { RunSettlement } from "./run-settlement.js";
import { runSettledRecord } from "./run-settlement.js";

export interface RunTelemetryJournal {
	context: RunOwnerTelemetryContext;
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
	/**
	 * The run's one terminal accountability record, written beside its call facts once its result object is stored, so
	 * the seal covers both (#425, #434). Resolves once the record is durable; a close waits for it too.
	 */
	settle(settlement: RunSettlement): Promise<void>;
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
		case "result":
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

export function openRunTelemetry(context: RunOwnerTelemetryContext, directory: string): Promise<RunTelemetryJournal> {
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
 * Journal the run.settled a run's host died before writing, from recovery's verdict, and seal the run. Only a journal
 * that exists is written, under the owner context its own run records carry, so its turn stops reading as running
 * (#425, #434). A run whose host died after run.settled but before its seal keeps that settlement and gets the seal.
 */
export function settleOrphanedRunJournal(directory: string, settlement: RunSettlement): Promise<void> {
	return completeRunJournal(directory, settlement);
}

/**
 * Seal a terminal run whose journal holds run.settled but no seal after it: its host died between the settlement and
 * the seal. A journal without run.settled is left alone, and so is one whose writer another live process holds,
 * since that owner seals it itself (#434).
 */
export function sealSettledRunJournal(directory: string): Promise<void> {
	return completeRunJournal(directory, null);
}

async function completeRunJournal(directory: string, settlement: RunSettlement | null): Promise<void> {
	const { openCallJournal, readCallJournal } = await import("../telemetry/call-journal.js");
	const { telemetryBundlePath } = await import("../telemetry/paths.js");
	const { existsSync } = await import("node:fs");
	const read = await readCallJournal(directory);
	const settled = read.records.some(({ record }) => record.k === "run.settled");
	if (settled && read.records.at(-1)?.record.k === "run.sealed" && existsSync(telemetryBundlePath(directory))) return;
	if (!settled && settlement === null) return;
	const context = read.records.map(({ record }) => record.ctx).find(isRunOwnerTelemetryContext);
	if (!context) return;
	// The run's owner is gone, so this one record gets a writer of its own rather than the run's owned journal.
	let writer: CallJournal;
	try {
		writer = await openCallJournal({ directory, context, writer: await clioWriterVersions() });
	} catch (error) {
		if (settlement === null && error instanceof StateFileLockTimeoutError) return;
		throw error;
	}
	if (!settled && settlement) {
		try {
			const result = await writer.storeObject("run-result", settlement.result);
			writer.enqueue({
				kind: "run.settled",
				data: runSettledRecord(settlement, result),
				ctx: context,
				wallMs: Date.now(),
				mono: performance.now(),
			});
		} catch (error) {
			// No result object, no settlement: the scope stays unsealed rather than citing content that is not on disk.
			await writer.close();
			throw error;
		}
	}
	// A host that died after run.settled left no assessment; recovery assesses what the journal holds (#434).
	if (!read.records.some(({ record }) => record.k === "evidence.assessed"))
		await journalAssessment(writer, directory, context, settlement?.assessment ?? null);
	// The recovered terminal is the run's terminal, so it seals the run scope (#434).
	await sealAndClose(writer);
}

/**
 * Journal the run's assessment after its run.settled and before its seal, so the seal covers it (#434). Best effort:
 * a run whose assessment cannot be built or stored still seals, and readers see it as not assessed.
 */
async function journalAssessment(
	writer: CallJournal,
	directory: string,
	context: RunOwnerTelemetryContext,
	assessment: RunAssessmentContext | null,
): Promise<void> {
	try {
		await writer.flush();
		const [{ readCallJournal }, { gatherRunAssessment }] = await Promise.all([
			import("../telemetry/call-journal.js"),
			import("../evidence/index.js"),
		]);
		const records = (await readCallJournal(directory)).records.map(({ record }) => record);
		const assessed = await gatherRunAssessment(clioStateDir(), context.runId, records, assessment);
		if (assessed === null) return;
		const text = await writer.storeObject("evidence-findings", assessed.text);
		if (!telemetryHub().emit("evidence.assessed", { runId: context.runId, ...assessed.data, text }, context))
			throw new Error("assessment record refused");
	} catch {
		writeDiagnostic("[clio-coder:telemetry] run assessment could not be journaled; the run seals without one\n");
	}
}

/** Seal a run scope at its terminal and close its writer; a seal that did not land rejects after the close (#434). */
async function sealAndClose(writer: CallJournal): Promise<void> {
	if (!(await writer.sealAndClose())) throw new Error("run telemetry seal did not land");
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

export interface FleetRootTelemetry {
	readonly context: TelemetryContext;
	flush(): Promise<void>;
	close(): Promise<void>;
}

const fleetRoots = new Map<string, TelemetryContext>();

/**
 * The fleet root's own run journal, open while its loop runs. Gate decisions, code steps and the routing of every
 * step land here, since the root is the run that asked for them (#434).
 */
export async function openFleetRootTelemetry(
	rootId: string,
	sessionId: string | null,
	directory: string,
): Promise<FleetRootTelemetry> {
	if (fleetRoots.has(rootId)) throw new Error(`fleet root ${rootId} already owns its journal`);
	const { openCallJournal } = await import("../telemetry/call-journal.js");
	// The fleet root is the coordinator driving its steps; its own records act for it (#434).
	const agent = { role: "coordinator", id: rootId } as const;
	const context: TelemetryContext =
		sessionId === null ? { sessionId: null, runId: rootId, agent } : { sessionId, runId: rootId, agent };
	const writer = await openCallJournal({ directory, context, writer: await clioWriterVersions() });
	fleetRoots.set(rootId, context);
	let closing: Promise<void> | undefined;
	return {
		context,
		async flush() {
			await writer.flush();
			const health = writer.health();
			if (health.writeErrors > 0 || health.invalid > 0 || health.dropped > 0 || health.filtered > 0)
				throw new Error(`fleet root ${rootId} telemetry journal did not persist its accountability records`);
		},
		close() {
			if (closing) return closing;
			fleetRoots.delete(rootId);
			// The root's loop ending is its terminal, so it seals the root's run scope (#434).
			// A seal that did not land is reported and rejects the close; the caller decides what that fails (#434).
			closing = sealAndClose(writer).catch((error: unknown) => {
				writeDiagnostic("[clio-coder:telemetry] fleet root journal close failed; recorded coverage may be incomplete\n");
				throw error;
			});
			return closing;
		},
	};
}

/** The open fleet root that owns an assignment, so a step's routing lands in the root that asked for it (#434). */
export function fleetRootTelemetryContext(rootId: string | undefined): TelemetryContext | undefined {
	return rootId === undefined ? undefined : fleetRoots.get(rootId);
}

/** Only dispatch opens owners. Viewers and the display registry never acquire a second writer (#434). */
async function openOwnedRunTelemetry(
	context: RunOwnerTelemetryContext,
	directory: string,
): Promise<RunTelemetryJournal> {
	const existing = journals.get(context.runId);
	if (existing) {
		if (JSON.stringify(existing.context) !== JSON.stringify(context) || existing.closed)
			throw new Error("run telemetry owner changed or closed");
		return existing;
	}
	const { openCallJournal, readCallJournal } = await import("../telemetry/call-journal.js");
	const versions = await clioWriterVersions();
	const previous = await readCallJournal(directory);
	let seq = previous.records.reduce(
		(max, { record }) => (record.k === "run.feed_appended" ? Math.max(max, record.data.seq) : max),
		0,
	);
	const writer: CallJournal = await openCallJournal({
		directory,
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
	let settling: Promise<void> = Promise.resolve();
	let durableSettle: Promise<void> = Promise.resolve();
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
		settle(settlement) {
			if (journal.closed) return Promise.reject(new Error("run telemetry journal is closed"));
			if (settled) return durableSettle;
			settled = true;
			const wallMs = Date.now();
			const mono = performance.now();
			const before = writer.health();
			// The caller publishes the run as finished only once this resolves, so every way the record can fail to
			// land rejects: a stored result object, the enqueue, and the write itself (#434).
			const durable = (async () => {
				const result = await writer.storeObject("run-result", settlement.result);
				if (
					!writer.enqueue({ kind: "run.settled", data: runSettledRecord(settlement, result), ctx: context, wallMs, mono })
				)
					throw new Error("run.settled could not be enqueued");
				await writer.flush();
				const after = writer.health();
				if (after.writeErrors > before.writeErrors || after.invalid > before.invalid)
					throw new Error("run.settled was not persisted");
				// The assessment is best-effort: a run whose assessment fails still seals, without one.
				await journalAssessment(writer, directory, context, settlement.assessment ?? null);
				await writer.flush();
			})().catch((error: unknown) => {
				// A settlement that did not land leaves the scope unsealed; a later settle may try again.
				settled = false;
				writeDiagnostic("[clio-coder:telemetry] run settlement could not be persisted; the run stays unsealed\n");
				throw error;
			});
			// Flush and close wait for the attempt whatever its result; only settling callers see the failure.
			durableSettle = durable;
			settling = durable.catch(() => undefined);
			return durable;
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
			await settling;
			await writer.flush();
			reportHealth();
		},
		close() {
			if (closing) return closing;
			journal.closed = true;
			// A run seals once at its terminal; a writer that closes before run.settled leaves the scope unsealed (#434).
			const diagnose = () =>
				writeDiagnostic("[clio-coder:telemetry] run journal close failed; recorded coverage may be incomplete\n");
			closing = settling.then(() =>
				settled
					? sealAndClose(writer).then(reportHealth, (error: unknown) => {
							reportHealth();
							diagnose();
							// The terminal seal's failure reaches the run's closer instead of passing as success (#434).
							throw error;
						})
					: writer.close().then(reportHealth, () => {
							// An unsettled run has no terminal to seal; a failed close stays a diagnostic.
							reportHealth();
							diagnose();
						}),
			);
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
