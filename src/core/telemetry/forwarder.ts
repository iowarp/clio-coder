import type { RunOwnerTelemetryContext, WorkerTelemetryContext } from "./context.js";
import { telemetryOwner } from "./context.js";
import type { ClockOrigin, TelemetryRecord } from "./envelope.js";
import { makeTelemetryRecord, readTelemetryRecord } from "./envelope.js";
import type { PendingTelemetry } from "./producer.js";
import { registerRunTelemetrySink } from "./producer.js";

export interface WorkerTelemetryFrame {
	type: "clio_coder_telemetry";
	record: TelemetryRecord;
}

const workerKinds = new Set([
	"call.started",
	"call.settled",
	"run.usage_reported",
	"journal.gap",
	"process.started",
	"process.exited",
	"tool.settled",
	"tool.decided",
	"middleware.fired",
	"auth.refreshed",
]);

/** The parent owns identity and publication; a worker cannot attribute facts to a different run or session (#434). */
export function readWorkerTelemetryRecord(value: unknown, expected: RunOwnerTelemetryContext): TelemetryRecord | null {
	if (
		!value ||
		typeof value !== "object" ||
		!("type" in value) ||
		value.type !== "clio_coder_telemetry" ||
		!("record" in value)
	)
		return null;
	const read = readTelemetryRecord(value.record);
	if (read.kind !== "record") return null;
	const record = read.record;
	if (
		!workerKinds.has(record.k) ||
		!record.origin ||
		record.ctx.agent.role !== "worker" ||
		record.ctx.agent.id !== expected.runId ||
		record.ctx.runId !== expected.runId ||
		record.ctx.sessionId !== expected.sessionId ||
		record.ctx.parentRunId !== expected.parentRunId ||
		record.ctx.batchId !== expected.batchId ||
		record.ctx.turnId !== expected.turnId
	)
		return null;
	return record;
}

export function readWorkerTelemetryFrame(value: unknown, expected: RunOwnerTelemetryContext): PendingTelemetry | null {
	const record = readWorkerTelemetryRecord(value, expected);
	if (!record) return null;
	return {
		kind: record.k,
		data: record.data,
		ctx: record.ctx,
		wallMs: Date.parse(record.t),
		mono: record.mono,
		recordId: record.id,
		origin: record.origin,
	} as PendingTelemetry;
}

/** Workers enqueue on the hot path and serialize only when the event loop drains this bounded queue (#434). */
export function createTelemetryForwarder(
	context: WorkerTelemetryContext,
	origin: ClockOrigin,
	emit: (frame: WorkerTelemetryFrame) => void,
	capacity = 4096,
	registerOwner = true,
) {
	if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1_000_000)
		throw new Error("invalid telemetry forwarder queue capacity");
	const pending: PendingTelemetry[] = [];
	let scheduled: ReturnType<typeof setImmediate> | undefined;
	let closed = false;
	let dropped = 0;
	const send = (record: TelemetryRecord): void => {
		try {
			emit({ type: "clio_coder_telemetry", record: { ...record, origin } });
		} catch {
			// A broken stdout lane is handled by the worker transport, never by repeating a model request (#434).
			dropped += 1;
		}
	};
	const flush = (): void => {
		if (scheduled) clearImmediate(scheduled);
		scheduled = undefined;
		for (const record of pending.splice(0))
			send(
				makeTelemetryRecord(record.kind, record.data, record.ctx, {
					t: new Date(record.wallMs).toISOString(),
					mono: record.mono,
				}),
			);
		if (dropped > 0) {
			const count = dropped;
			dropped = 0;
			send(
				makeTelemetryRecord("journal.gap", { sink: "worker-stdout", reason: "writer-drop", count }, context, {
					t: new Date().toISOString(),
					mono: performance.now(),
				}),
			);
		}
	};
	const enqueue = (record: PendingTelemetry): boolean => {
		if (closed || telemetryOwner(record.ctx) !== telemetryOwner(context)) return false;
		if (!scheduled) scheduled = setImmediate(flush);
		if (pending.length >= capacity) {
			dropped += 1;
			return false;
		}
		pending.push(record);
		return true;
	};
	// In-process ACP queues into the host pump; the run journal already owns the global sink (#434).
	const release = registerOwner ? registerRunTelemetrySink(context.runId, { enqueue }) : () => {};
	return {
		enqueue,
		flush,
		close(): void {
			if (closed) return;
			closed = true;
			release();
			flush();
		},
	};
}
