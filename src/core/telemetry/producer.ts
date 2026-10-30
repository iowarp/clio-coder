import { captureAdmits, STANDARD_CAPTURE } from "./capture.js";
import type { TelemetryContext } from "./context.js";
import { telemetryContext, telemetryOwner, withTelemetryContext } from "./context.js";
import type { FailureCause } from "./enums.js";
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
	/** Whether the owner's current mode captures this kind. A sink without it captures standard kinds only (#434). */
	admits?(kind: Kind): boolean;
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

function sinkAdmits(sink: TelemetrySink, kind: Kind): boolean {
	return sink.admits ? sink.admits(kind) : captureAdmits(STANDARD_CAPTURE, kind);
}

/** No serialization, filesystem access, or locks may enter this call stack (#434, rule13). */
export function recordTelemetry<K extends Kind>(kind: K, data: Payload<K>, ctx = telemetryContext()): boolean {
	const sink = ctx ? sinks.get(telemetryOwner(ctx)) : undefined;
	if (!ctx || !sink) {
		unownedRecords += 1;
		return false;
	}
	try {
		// Not capturing a kind the mode excludes is policy, not a drop: it is neither a gap nor a failure (#434, R10).
		if (!sinkAdmits(sink, kind)) return false;
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
/** A provider HTTP response as the engine seam saw it. Headers never reach the journal except through an allowlist. */
export interface ObservedResponse {
	status: number;
	headers: Readonly<Record<string, string>>;
}
export interface TelemetryCall {
	readonly callId: string;
	readonly attemptId: string;
	readonly attempt: number;
	withContext<T>(fn: () => T): T;
	stage(stage: Stage, phase: "start" | "end", facts?: StageFacts): void;
	mark(mark: "firstByte" | "firstToken"): void;
	/**
	 * Feed a provider HTTP response. The first 2xx response opens the stream and marks firstByte; the last one stays
	 * on the attempt, in memory only, for the quota reading and research capture to read (#434).
	 */
	observeResponse?(response: ObservedResponse): void;
	/** The last 2xx response this attempt observed. */
	lastResponse?(): ObservedResponse | undefined;
	/** The first settlement returns the enqueued facts for read-only live projections (#434). */
	settle(data: Settlement, reportedModel?: CallStarted["target"]["reportedModel"]): CallSettled | undefined;
	/**
	 * Settle an attempt its owner moves past without a message, so no call.started stays open (#434, R9). It was
	 * never sent unless its send stage began; nothing else about it was observed.
	 */
	abandon(cause: FailureCause): CallSettled | undefined;
	/** One successor per settled attempt. A live attempt cannot silently disappear (#434). */
	nextAttempt(request?: Partial<Pick<CallStarted, "roundKind" | "toolChoice">>): TelemetryCall | null;
}

function abandonedSettlement(sent: boolean, cause: FailureCause): Settlement {
	const unobserved = { kind: "unknown", reason: "not-observed" } as const;
	const notApplicable = { kind: "absent", reason: "not-applicable" } as const;
	return {
		disposition: sent ? "sent_unsettled" : "never_sent",
		stop: { reason: cause === "operator_cancel" || cause === "parent_cancel" ? "aborted" : "error", failure: cause },
		usage: sent
			? {
					input: unobserved,
					output: unobserved,
					cacheRead: unobserved,
					cacheWrite: unobserved,
					cacheWrite1h: unobserved,
					reasoning: unobserved,
				}
			: null,
		pricing: { usd: sent ? unobserved : notApplicable, pricedBy: "none" },
		transport: { kind: "unknown", continuation: unobserved, requestBytes: unobserved, sessionPinnedToSse: unobserved },
		cache: {
			firstDivergentSection: sent ? unobserved : notApplicable,
			expectedColdReasons: [],
			rePrefilledTokens: sent ? unobserved : notApplicable,
			uncachedPrefillTokens: unobserved,
			verdict: "unknown",
		},
	};
}

/**
 * A message alone cannot show a request left Clio. An attempt whose own stages show it never reached the send, and
 * whose settlement carries no provider evidence, was never sent, whatever an aborted message suggests (#434).
 */
function unsentByStages(data: Settlement): Settlement {
	const notApplicable = { kind: "absent", reason: "not-applicable" } as const;
	return {
		...data,
		disposition: "never_sent",
		usage: null,
		pricing: { usd: notApplicable, pricedBy: "none" },
		cache: {
			...data.cache,
			firstDivergentSection: notApplicable,
			rePrefilledTokens: notApplicable,
			...(data.cache.bill ? { bill: { usd: notApplicable, pricedBy: "none" } } : {}),
		},
	};
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
		// Entering its own context is how a side call's request reaches the engine seam that marks its send (#434).
		let entered = false;
		let successor: TelemetryCall | undefined;
		let response: ObservedResponse | undefined;
		recordTelemetry("call.started", metadata, scope);
		const handle: TelemetryCall = {
			callId,
			attemptId,
			attempt: number,
			withContext: (fn) => {
				entered = true;
				return scope ? withTelemetryContext(scope, fn) : fn();
			},
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
			observeResponse(observed) {
				if (settled || observed.status < 200 || observed.status >= 300) return;
				handle.mark("firstByte");
				response = { status: observed.status, headers: { ...observed.headers } };
			},
			lastResponse: () => response,
			settle(data, reportedModel) {
				if (settled) return;
				settled = true;
				liveAttempts.delete(attemptId);
				stages.settle = performance.now() - start;
				// Only an attempt whose path marks its send can show it never got there; System One's cannot yet.
				const tracked =
					entered || starts.transform !== undefined || starts.auth !== undefined || starts.admission !== undefined;
				const evidence =
					data.responseId !== undefined ||
					reportedModel?.kind === "measured" ||
					Object.values(data.usage ?? {}).some((fact) => fact.kind === "measured");
				const settlement =
					tracked && starts.send === undefined && data.disposition === "sent_unsettled" && !evidence
						? unsentByStages(data)
						: data;
				const facts: CallSettled = {
					...metadata,
					...settlement,
					target: { ...metadata.target, reportedModel: reportedModel ?? metadata.target.reportedModel },
					stages,
				};
				recordTelemetry("call.settled", facts, scope);
				return facts;
			},
			abandon(cause) {
				return handle.settle(abandonedSettlement(starts.send !== undefined, cause));
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
