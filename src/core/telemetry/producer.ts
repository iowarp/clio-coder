import { captureAdmits, STANDARD_CAPTURE } from "./capture.js";
import type { TelemetryContext } from "./context.js";
import { telemetryContext, telemetryOwner, withTelemetryContext } from "./context.js";
import type { FailureCause } from "./enums.js";
import type { ClockOrigin } from "./envelope.js";
import type { EventName, JournalEventName, JournalPayload } from "./events.js";
import { isJournalEvent, journalDefinition } from "./events.js";
import type { JournalEmissionTiming } from "./hub.js";
import { attachJournalRoute, EARLY_JOURNAL_LIMIT, telemetryHub } from "./hub.js";
import { newAttemptId, newCallId } from "./ids.js";
import type { CallSettled, CallStarted } from "./schemas.js";
import { DELTA_GAP_BOUNDS_MS } from "./schemas.js";

export type PendingTelemetry<K extends JournalEventName = JournalEventName> = K extends JournalEventName
	? {
			kind: K;
			data: JournalPayload<K>;
			ctx: TelemetryContext;
			wallMs: number;
			mono: number;
			/** Preserved when an already-enveloped worker record crosses into the host writer (#434). */
			recordId?: string;
			origin?: ClockOrigin;
			/** Research content the writer stores in `objects/` and cites as the record's `content` (#434). */
			preimage?: unknown;
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
	admits?(kind: JournalEventName): boolean;
	/** Fold overflow before process ownership into the process journal's opening gap (#434). */
	recordOpeningDrops?(count: number): void;
}

/**
 * Reopens a session writer its idle close shut, for a session-scoped record whose context names that session. It
 * never chooses an owner: a record whose context names no session has none to reopen (#434).
 */
export type TelemetryReopener = (record: PendingTelemetry) => boolean;

const sinks = new Map<string, TelemetrySink>();
/** Owns records whose context names neither a session nor a run; the writer stamps its own context on them (#434). */
let processOwner: { context: TelemetryContext; sink: TelemetrySink } | undefined;
const earlyProcessRecords: Array<{
	name: JournalEventName;
	data: unknown;
	preimage: unknown;
	timing: JournalEmissionTiming;
}> = [];
let earlyProcessDrops = 0;
let reopener: TelemetryReopener | null = null;
const liveAttempts = new Map<string, TelemetryCall>();
let unownedRecords = 0;
let sinkFailures = 0;

export function registerTelemetrySink(sessionId: string, sink: TelemetrySink): () => void {
	return registerSink(`session:${sessionId}`, sink);
}

export function registerRunTelemetrySink(runId: string, sink: TelemetrySink): () => void {
	return registerSink(`run:${runId}`, sink);
}

/** Explicit process contexts, including recovery, reach the process journal's sole writer (#434). */
export function registerProcessJournalSink(processId: string, sink: TelemetrySink): () => void {
	return registerSink(`process:${processId}`, sink);
}

export function registerProcessTelemetrySink(context: TelemetryContext, sink: TelemetrySink): () => void {
	if (processOwner) throw new Error("telemetry already has a process owner");
	const owner = { context, sink };
	processOwner = owner;
	if (earlyProcessDrops > 0) {
		if (sink.recordOpeningDrops) sink.recordOpeningDrops(earlyProcessDrops);
		else
			enqueueTelemetry(
				"journal.gap",
				{ sink: "journal.jsonl", reason: "writer-drop", count: earlyProcessDrops },
				undefined,
				context,
			);
		earlyProcessDrops = 0;
	}
	for (const record of earlyProcessRecords.splice(0))
		enqueueTelemetry(record.name, record.data, record.preimage, context, record.timing);
	return () => {
		if (processOwner === owner) processOwner = undefined;
	};
}

/** The process scope's context, so a call made with no session or run is still a call of this process (#434). */
export function processTelemetryContext(): TelemetryContext | undefined {
	return processOwner?.context;
}

/** A process context reaches only this process's own journal; any other owner resolves through its registered sink. */
function sinkFor(ctx: TelemetryContext): TelemetrySink | undefined {
	if ("processId" in ctx) {
		const owner = processOwner;
		return owner && "processId" in owner.context && owner.context.processId === ctx.processId ? owner.sink : undefined;
	}
	return sinks.get(telemetryOwner(ctx));
}

function registerSink(owner: string, sink: TelemetrySink): () => void {
	if (sinks.has(owner)) throw new Error(`telemetry already has an owner for ${owner}`);
	sinks.set(owner, sink);
	return () => {
		if (sinks.get(owner) === sink) sinks.delete(owner);
	};
}

/** One telemetry domain runs per process; a later registration replaces an earlier one until either is released. */
export function registerTelemetryReopener(next: TelemetryReopener): () => void {
	reopener = next;
	return () => {
		if (reopener === next) reopener = null;
	};
}

export function telemetryProducerHealth(): { unownedRecords: number; sinkFailures: number } {
	return { unownedRecords, sinkFailures };
}

function sinkAdmits(sink: TelemetrySink, kind: JournalEventName): boolean {
	return sink.admits ? sink.admits(kind) : captureAdmits(STANDARD_CAPTURE, kind);
}

/**
 * Whether a record of this kind would be captured under ctx now, so a producer can skip assembling research data
 * the mode drops (#434). It answers for this moment only: the record itself is still filtered when it is enqueued.
 */
export function telemetryCaptures(kind: JournalEventName, ctx = telemetryContext()): boolean {
	// A process fact is captured under the process journal's mode whatever context asks (#434).
	const sink = ctx && journalDefinition(kind).scope !== "process" ? sinkFor(ctx) : processOwner?.sink;
	if (!sink) return false;
	try {
		return sinkAdmits(sink, kind);
	} catch {
		return false;
	}
}

function enqueueInto(sink: TelemetrySink, record: PendingTelemetry): boolean {
	try {
		// Not capturing an event the mode excludes is policy, not a drop: it is neither a gap nor a failure (#434, R10).
		if (!sinkAdmits(sink, record.kind)) return false;
		return sink.enqueue(record);
	} catch {
		// Accounting cannot turn a completed call into a retry (#434).
		sinkFailures += 1;
		return false;
	}
}

/** No serialization, filesystem access, or locks may enter this call stack (#434, rule13). */
function enqueueTelemetry(
	name: EventName,
	data: unknown,
	preimage: unknown,
	given: TelemetryContext | undefined,
	timing?: JournalEmissionTiming,
): boolean {
	if (!isJournalEvent(name)) {
		// The bus trace is a registry feature: a live event is journaled by name where research mode keeps it (#434).
		traceLiveEvent(name, given);
		return false;
	}
	const definition = journalDefinition(name);
	if (definition.scope === "process") {
		given = processOwner?.context;
		if (!given) {
			// Domains may load before telemetry; preserve their process facts and count every overflow (#434).
			if (earlyProcessRecords.length < EARLY_JOURNAL_LIMIT)
				earlyProcessRecords.push({
					name,
					data,
					preimage,
					timing: timing ?? { wallMs: Date.now(), mono: performance.now() },
				});
			else earlyProcessDrops += 1;
			return false;
		}
	}
	// A session fact names its session at its seam; one emitted without a context is a gap, never the process's (#434).
	const ctx = given ?? (definition.scope === "session" ? undefined : processOwner?.context);
	const sink = given ? (definition.scope === "process" ? processOwner?.sink : sinkFor(given)) : processOwner?.sink;
	const reopens =
		definition.scope === "session" &&
		typeof ctx?.sessionId === "string" &&
		ctx.runId === undefined &&
		preimage === undefined;
	if (!ctx || (!sink && !reopens)) {
		unownedRecords += 1;
		return false;
	}
	try {
		if (sink && !sinkAdmits(sink, name)) return false;
		// A projection keeps only a rich live payload's structural facts; it runs only for a record a sink will take (#434).
		if (definition.project) data = definition.project(data as never);
	} catch {
		sinkFailures += 1;
		return false;
	}
	// Two literals keep the standard path at its single allocation (#434, §14).
	const wallMs = timing?.wallMs ?? Date.now();
	const mono = timing?.mono ?? performance.now();
	const record = (
		preimage === undefined ? { kind: name, data, ctx, wallMs, mono } : { kind: name, data, ctx, wallMs, mono, preimage }
	) as PendingTelemetry;
	if (sink) return enqueueInto(sink, record);
	// The named session's writer closed idle; the telemetry domain reopens it for this record (#434).
	if (reopener?.(record)) return false;
	unownedRecords += 1;
	return false;
}

/**
 * Enqueue a record the reopener opened a writer for, stamped and projected when it was emitted. Its owner is looked
 * up now; a writer that failed to open leaves it unowned (#434).
 */
export function enqueueReopenedTelemetry(record: PendingTelemetry): boolean {
	const sink = sinks.get(telemetryOwner(record.ctx));
	if (sink) return enqueueInto(sink, record);
	unownedRecords += 1;
	return false;
}

function traceLiveEvent(name: EventName, given: TelemetryContext | undefined): void {
	const ctx = given ?? processOwner?.context;
	const sink = given ? sinkFor(given) : processOwner?.sink;
	if (!ctx || !sink) return;
	try {
		if (!sinkAdmits(sink, "bus.traced")) return;
		sink.enqueue({ kind: "bus.traced", data: { event: name }, ctx, wallMs: Date.now(), mono: performance.now() });
	} catch {
		// A trace never changes the event it traces (#434).
		sinkFailures += 1;
	}
}

attachJournalRoute({
	journal: (name, data, preimage, ctx, timing) =>
		enqueueTelemetry(name, data, preimage, ctx ?? telemetryContext(), timing),
	dropped(name, count) {
		if (!isJournalEvent(name)) return;
		if (journalDefinition(name).scope === "process") earlyProcessDrops += count;
		else unownedRecords += count;
	},
});

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
	 * One generated delta. Present only under research delta capture, so a stream that has no histogram to feed never
	 * inspects its deltas: the attempt records the gaps as call.timing_captured after it settles (#428, #434).
	 */
	delta?(): void;
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

/** Also how a host settles an attempt whose process died before settling it (#434). */
export function abandonedSettlement(sent: boolean, cause: FailureCause): Settlement {
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
 * whose settlement carries no provider evidence, was never sent, whatever an aborted message suggests (#434). It
 * keeps no interrupted-call estimate either: never-sent is not spent (R2, L2). Nor does it keep expected cold
 * reasons, which describe the next request the provider sees; the caller carries them to it.
 */
function unsentByStages(data: Settlement): Settlement {
	const notApplicable = { kind: "absent", reason: "not-applicable" } as const;
	const { interruptedEstimate: _spent, ...unsent } = data;
	return {
		...unsent,
		disposition: "never_sent",
		usage: null,
		pricing: { usd: notApplicable, pricedBy: "none" },
		cache: {
			...data.cache,
			firstDivergentSection: notApplicable,
			expectedColdReasons: [],
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

/**
 * A call made with no session or run context is the process's own call: it carries the process context with its call
 * and attempt ids, so the process journal holds it whole instead of refusing it as an invalid record (#434).
 */
export function beginCall(
	input: Omit<CallStarted, "callId" | "attemptId" | "attempt">,
	given = telemetryContext(),
): TelemetryCall {
	const ctx = given ?? processOwner?.context;
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
		const gaps = scope && telemetryCaptures("call.timing_captured", scope) ? newGapHistogram() : undefined;
		telemetryHub().emit("call.started", metadata, scope);
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
				// Only an attempt whose path marks its send can show it never got there; one that entered its own context
				// or staged its preparation has such a path (#429, #434).
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
				telemetryHub().emit("call.settled", facts, scope);
				const timing = gaps?.payload();
				if (timing) telemetryHub().emit("call.timing_captured", timing, scope);
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
		if (gaps)
			handle.delta = () => {
				if (!settled) gaps.tick(performance.now());
			};
		liveAttempts.set(attemptId, handle);
		return handle;
	};
	return attempt(0);
}

const round = (ms: number) => Math.round(ms * 1000) / 1000;

function newGapHistogram() {
	const gapCounts = new Array<number>(DELTA_GAP_BOUNDS_MS.length + 1).fill(0);
	let deltas = 0;
	let first = 0;
	let last = 0;
	let maxGapMs = 0;
	return {
		tick(now: number): void {
			if (deltas === 0) first = now;
			else {
				const gap = now - last;
				let bucket = 0;
				while (bucket < DELTA_GAP_BOUNDS_MS.length && gap > (DELTA_GAP_BOUNDS_MS[bucket] ?? 0)) bucket += 1;
				gapCounts[bucket] = (gapCounts[bucket] ?? 0) + 1;
				if (gap > maxGapMs) maxGapMs = gap;
			}
			last = now;
			deltas += 1;
		},
		payload(): JournalPayload<"call.timing_captured"> | undefined {
			return deltas === 0 ? undefined : { deltas, gapCounts, maxGapMs: round(maxGapMs), spanMs: round(last - first) };
		},
	};
}
