import type { TelemetryContext } from "./context.js";
import { telemetryContext, withTelemetryContext } from "./context.js";
import { newAttemptId, newCallId } from "./ids.js";
import type { CallSettled, CallStarted, Kind, Payload } from "./schemas.js";

export type PendingTelemetry<K extends Kind = Kind> = K extends Kind
	? {
			kind: K;
			data: Payload<K>;
			ctx: TelemetryContext;
			wallMs: number;
			mono: number;
		}
	: never;

export interface TelemetrySink {
	/** Enqueue only. Ownership of data transfers to the sink; callers must not mutate it (#434). */
	enqueue(record: PendingTelemetry): boolean;
}

const sinks = new Map<string, TelemetrySink>();
let unownedRecords = 0;
let sinkFailures = 0;

export function registerTelemetrySink(sessionId: string, sink: TelemetrySink): () => void {
	if (sinks.has(sessionId)) throw new Error(`telemetry already has an owner for session ${sessionId}`);
	sinks.set(sessionId, sink);
	return () => {
		if (sinks.get(sessionId) === sink) sinks.delete(sessionId);
	};
}

export function telemetryProducerHealth(): { unownedRecords: number; sinkFailures: number } {
	return { unownedRecords, sinkFailures };
}

/** No serialization, filesystem access, or locks may enter this call stack (#434, rule13). */
export function recordTelemetry<K extends Kind>(kind: K, data: Payload<K>, ctx = telemetryContext()): boolean {
	const sink = ctx ? sinks.get(ctx.sessionId) : undefined;
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
	settle(data: Settlement): void;
	/** One successor per settled attempt. A live attempt cannot silently disappear (#434). */
	nextAttempt(): TelemetryCall | null;
}

export function beginCall(
	input: Omit<CallStarted, "callId" | "attemptId" | "attempt">,
	ctx = telemetryContext(),
): TelemetryCall {
	const callId = newCallId();
	const attempt = (number: number): TelemetryCall => {
		const attemptId = newAttemptId();
		const scope = ctx ? { ...ctx, callId, attemptId, label: input.label } : undefined;
		const start = performance.now();
		const starts: Partial<Record<Stage, number>> = {};
		const stages: CallSettled["stages"] = { settle: 0 };
		const metadata: CallStarted = { ...input, callId, attemptId, attempt: number };
		let settled = false;
		let successor: TelemetryCall | undefined;
		recordTelemetry("call.started", metadata, scope);
		return {
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
			settle(data) {
				if (settled) return;
				settled = true;
				stages.settle = performance.now() - start;
				recordTelemetry("call.settled", { ...metadata, ...data, stages }, scope);
			},
			nextAttempt() {
				if (!settled) return null;
				successor ??= attempt(number + 1);
				return successor;
			},
		};
	};
	return attempt(0);
}
