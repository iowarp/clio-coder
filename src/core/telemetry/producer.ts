import type { TelemetryContext } from "./context.js";
import { telemetryContext, telemetryOwner, withTelemetryContext } from "./context.js";
import type { ClockOrigin } from "./envelope.js";
import { newAttemptId, newCallId } from "./ids.js";
import type { CallSettled, CallStarted, Kind, Payload } from "./schemas.js";

export type PendingTelemetry<K extends Kind = Kind> = K extends Kind
	? {
			kind: K;
			data: Payload<K>;
			ctx: TelemetryContext;
			wallMs: number;
			mono: number;
			/** Preserved when an already-enveloped worker record crosses into the host writer (#434). */
			recordId?: string;
			origin?: ClockOrigin;
		}
	: never;

/** Erased engine callback; raw provider messages cross only into the host's fact adapter (#434). */
export interface CallMessageObserver {
	startAttempt(): void;
	settle(message: unknown): void;
	withContext<T>(work: () => T): T;
}

export interface TelemetrySink {
	/** Enqueue only. Ownership of data transfers to the sink; callers must not mutate it (#434). */
	enqueue(record: PendingTelemetry): boolean;
}

const sinks = new Map<string, TelemetrySink>();
const liveAttempts = new Map<string, TelemetryCall>();
let unownedRecords = 0;
let sinkFailures = 0;

export function registerTelemetrySink(sessionId: string, sink: TelemetrySink): () => void {
	return registerSink(`session:${sessionId}`, sink);
}

export function registerRunTelemetrySink(runId: string, sink: TelemetrySink): () => void {
	return registerSink(`run:${runId}`, sink);
}

function registerSink(owner: string, sink: TelemetrySink): () => void {
	if (sinks.has(owner)) throw new Error(`telemetry already has an owner for ${owner}`);
	sinks.set(owner, sink);
	return () => {
		if (sinks.get(owner) === sink) sinks.delete(owner);
	};
}

export function telemetryProducerHealth(): { unownedRecords: number; sinkFailures: number } {
	return { unownedRecords, sinkFailures };
}

/** No serialization, filesystem access, or locks may enter this call stack (#434, rule13). */
export function recordTelemetry<K extends Kind>(kind: K, data: Payload<K>, ctx = telemetryContext()): boolean {
	const sink = ctx ? sinks.get(telemetryOwner(ctx)) : undefined;
	if (!ctx || !sink) {
		unownedRecords += 1;
		return false;
	}
	try {
		return sink.enqueue({ kind, data, ctx, wallMs: Date.now(), mono: performance.now() } as PendingTelemetry);
	} catch {
		// Accounting cannot turn a completed call into a retry (#434).
		sinkFailures += 1;
		return false;
	}
}

type Stage = "admission" | "auth" | "transform" | "connect" | "send";
type StageFacts = { waitedOn?: "budget" | "capacity" | "steering"; refreshed?: boolean; reused?: boolean };
type Settlement = Omit<CallSettled, keyof CallStarted | "stages">;
export interface TelemetryCall {
	readonly callId: string;
	readonly attemptId: string;
	readonly attempt: number;
	withContext<T>(fn: () => T): T;
	stage(stage: Stage, phase: "start" | "end", facts?: StageFacts): void;
	mark(mark: "firstByte" | "firstToken"): void;
	/** The first settlement returns the enqueued facts for read-only live projections (#434). */
	settle(data: Settlement, reportedModel?: CallStarted["target"]["reportedModel"]): CallSettled | undefined;
	/** One successor per settled attempt. A live attempt cannot silently disappear (#434). */
	nextAttempt(request?: Partial<Pick<CallStarted, "roundKind" | "toolChoice">>): TelemetryCall | null;
}

/** The unsettled attempt this async context belongs to, so a shared engine seam can time it (#434). */
export function telemetryCallInContext(): TelemetryCall | undefined {
	const attemptId = telemetryContext()?.attemptId;
	return attemptId === undefined ? undefined : liveAttempts.get(attemptId);
}

export function beginCall(
	input: Omit<CallStarted, "callId" | "attemptId" | "attempt">,
	ctx = telemetryContext(),
): TelemetryCall {
	const callId = newCallId();
	const attempt = (number: number, request?: Partial<Pick<CallStarted, "roundKind" | "toolChoice">>): TelemetryCall => {
		const attemptId = newAttemptId();
		const scope = ctx ? { ...ctx, callId, attemptId, label: input.label } : undefined;
		const start = performance.now();
		const starts: Partial<Record<Stage, number>> = {};
		const stages: CallSettled["stages"] = { settle: 0 };
		const metadata: CallStarted = { ...input, ...request, callId, attemptId, attempt: number };
		let settled = false;
		let successor: TelemetryCall | undefined;
		recordTelemetry("call.started", metadata, scope);
		const handle: TelemetryCall = {
			callId,
			attemptId,
			attempt: number,
			withContext: (fn) => (scope ? withTelemetryContext(scope, fn) : fn()),
			stage(name, phase, facts = {}) {
				if (settled) return;
				const elapsed = performance.now() - start;
				if (phase === "start") starts[name] ??= elapsed;
				else if (starts[name] !== undefined && stages[name] === undefined) {
					const span = { start: starts[name], end: elapsed };
					if (name === "admission") stages.admission = { ...span, ...(facts.waitedOn ? { waitedOn: facts.waitedOn } : {}) };
					else if (name === "auth")
						stages.auth = { ...span, ...(facts.refreshed === undefined ? {} : { refreshed: facts.refreshed }) };
					else if (name === "connect")
						stages.connect = { ...span, ...(facts.reused === undefined ? {} : { reused: facts.reused }) };
					else stages[name] = span;
				}
			},
			mark(name) {
				if (!settled) stages[name] ??= performance.now() - start;
			},
			settle(data, reportedModel) {
				if (settled) return;
				settled = true;
				liveAttempts.delete(attemptId);
				stages.settle = performance.now() - start;
				const facts: CallSettled = {
					...metadata,
					...data,
					target: { ...metadata.target, reportedModel: reportedModel ?? metadata.target.reportedModel },
					stages,
				};
				recordTelemetry("call.settled", facts, scope);
				return facts;
			},
			nextAttempt(request) {
				if (!settled) return null;
				successor ??= attempt(number + 1, request);
				return successor;
			},
		};
		liveAttempts.set(attemptId, handle);
		return handle;
	};
	return attempt(0);
}
