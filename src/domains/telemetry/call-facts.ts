import { responseModelIdObservationFromRecord } from "../../core/response-model-id.js";
import { wireEffortFact } from "../../core/telemetry/call-effort.js";
import { providerChargeEconomics } from "../../core/telemetry/economy.js";
import type { FailureCause, TurnNoAnswerCause } from "../../core/telemetry/enums.js";
import type { EventPayload } from "../../core/telemetry/events.js";
import type { Fact } from "../../core/telemetry/fact.js";
import type { PricingBasisSource } from "../../core/telemetry/pricing.js";
import { pricedUsd, pricingBasis } from "../../core/telemetry/pricing.js";
import type { CallSettled, CallStarted, CallUsage } from "../../core/telemetry/schemas.js";
import { terminationPhase } from "../../core/termination-phase.js";
import { ceilChars, normalizeTokenUsage } from "../../core/token-split.js";
import type { EffectivePricing } from "../providers/catalog.js";
import { telemetryCommitment } from "./objects.js";

const unknown = { kind: "unknown", reason: "provider-omitted" } as const;
const unobserved = { kind: "unknown", reason: "not-observed" } as const;
const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const amount = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** A requested model is not evidence that the provider served that model (#434). */
export function reportedModelFromMessage(message: unknown): Fact<string> {
	const observation = responseModelIdObservationFromRecord(record(message), "not-observed");
	return observation.state === "reported"
		? { kind: "measured", value: observation.reportedModelId, source: "provider" }
		: { kind: "unknown", reason: observation.state === "not-reported" ? "provider-omitted" : "not-observed" };
}

/**
 * The message fields an adapter stamps on the message it settles that `callSettlementFromMessage` and
 * `reportedModelFromMessage` read: transport, response id, wire effort, Clio's abort reason, seat billing and the
 * served model. Usage, stop reason and failure are not stamps; a caller that rebuilds the message sets them itself.
 */
const SETTLEMENT_STAMPS = [
	"codexTransport",
	"anthropicResponse",
	"copilotSession",
	"copilotContinuation",
	"clioCoderRequestBytes",
	"clioCoderPromptCacheKey",
	"responseId",
	"clioCoderWireEffort",
	"clioCoderAbortReason",
	"copilotBilling",
	"responseModelIdObservation",
	"servedModel",
] as const;

/**
 * The settlement stamps on one message, for a caller that settles from usage it read off that message: the side request
 * admission rebuilds its message, and without these its call reads as an unknown transport, no seat billing and an
 * unobserved model (#434).
 */
export function settlementStamps(message: unknown): Record<string, unknown> {
	const raw = record(message);
	return Object.fromEntries(SETTLEMENT_STAMPS.flatMap((key) => (raw[key] !== undefined ? [[key, raw[key]]] : [])));
}

/**
 * Transport facts Clio counts itself: its Responses socket (`src/engine/apis/responses-websocket.ts`) records each
 * call's sends, reuse and SSE pin, attributed to that call alone, and the copilot-sdk stream records which of its pooled
 * Copilot sessions each call went to. The connect span stays unknown. A delta frame's bytes are not the payload's, so
 * they stay unknown too (#434).
 */
function transportFacts(raw: Record<string, unknown>, sent: boolean): CallSettled["transport"] {
	const codex = record(raw.codexTransport);
	const counters = record(codex.counters);
	const counted = <T>(value: T) => ({ kind: "measured", value, source: "local-count" }) as const;
	const exclusive = codex.attribution === "exclusive" && typeof counters.requests === "number";
	const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);
	const failures = exclusive ? count(counters.websocketFailures) : null;
	const fallbacks = exclusive ? count(counters.sseFallbacks) : null;
	const recovery = record(codex.recovery);
	const pinReasons = ["auth_rejection", "transport_failure", "post_stream_or_unknown_failure"] as const;
	const pinReason = pinReasons.find((reason) => reason === codex.reason);
	const actions = ["cooldown_reset", "auth_reset"] as const;
	const outcomes = ["eligible", "recovered", "failed", "unknown"] as const;
	const action = actions.find((value) => value === recovery.action);
	const outcome = outcomes.find((value) => value === recovery.outcome);
	// An Anthropic request that continued its message thread sent only the new messages, so it is a delta too; the
	// last request of the call is the one the provider answered.
	const threads = record(raw.anthropicResponse).threadRequests;
	const thread = Array.isArray(threads) && threads.length > 0 ? threads[threads.length - 1] : undefined;
	// The copilot-sdk stream names the session its request went to and whether it sent only what that session had not
	// seen (`src/engine/copilot/stream.ts`). The SDK runs its own runtime as Clio's child process; what that runtime
	// does on the wire to GitHub (connection reuse, SSE or WebSocket) it does not report.
	const copilotSession = (["new", "spare", "continued", "resumed"] as const).find(
		(value) => value === raw.copilotSession,
	);
	const copilotRequest = raw.copilotContinuation === "delta" || raw.copilotContinuation === "full";
	const continuation =
		codex.request === "delta" || codex.request === "full"
			? codex.request
			: copilotSession !== undefined && copilotRequest
				? (raw.copilotContinuation as "delta" | "full")
				: thread === undefined
					? undefined
					: thread === "continue"
						? "delta"
						: "full";
	const bytes = sent && continuation !== "delta" ? amount(raw.clioCoderRequestBytes) : null;
	const cacheKey = sent && typeof raw.clioCoderPromptCacheKey === "string" ? raw.clioCoderPromptCacheKey : undefined;
	return {
		kind:
			codex.mode === "websocket" || codex.mode === "sse"
				? codex.mode
				: copilotSession !== undefined
					? "subprocess"
					: "unknown",
		continuation: continuation ? counted(continuation) : unobserved,
		requestBytes:
			bytes === null || !Number.isInteger(bytes)
				? unobserved
				: { kind: "estimated", value: bytes, method: "payload-json" },
		sessionPinnedToSse:
			typeof codex.fallbackActive === "boolean"
				? counted(codex.fallbackActive)
				: copilotSession !== undefined
					? unknown
					: unobserved,
		...(copilotSession !== undefined ? { session: counted(copilotSession), connectionReused: unknown } : {}),
		...(codex.mode === "websocket" && codex.attribution === "exclusive" && counters.requests === 1
			? { connectionReused: counted(counters.connectionsReused === 1 && counters.connectionsCreated === 0) }
			: {}),
		...(failures !== null ? { websocketFailures: counted(failures) } : {}),
		...(fallbacks !== null ? { sseFallbacks: counted(fallbacks) } : {}),
		...(codex.fallbackActive === true && pinReason ? { pinReason } : {}),
		...(action && outcome ? { recovery: { action, outcome } } : {}),
		// The key is a session identifier, so the journal keeps a commitment: equal keys compare, none is stored (#434).
		...(cacheKey ? { promptCacheKey: telemetryCommitment("prompt-cache-key", cacheKey) } : {}),
	};
}

/** Map existing structured causes; prose is never a telemetry classifier (#434). */
function failureCause(failure: Record<string, unknown>): FailureCause | undefined {
	switch (failure.errorClass) {
		case "budget_wait":
			return "budget_wait_aborted";
		case "auth":
		case "auth_rejected":
			return "auth_rejected";
		case "auth_refresh_failed":
			return "auth_refresh_failed";
		case "rate_limit":
		case "rate_limited":
			return "rate_limited";
		case "usage_limit":
		case "usage_limit_reached":
			return "usage_limit_reached";
		case "context_overflow":
			return "context_overflow";
		case "aborted":
			return undefined;
		// A harness stop persists its own cause as its class (bt-26 N2a).
		case "operator_cancel":
		case "route_moved":
		case "triage_stop":
		case "autonomy_stop":
		case "job_clock":
		case "repetition":
		case "shutdown":
		case "parent_cancel":
		case "loop_guard":
		case "oversized_tool_result":
		// A compaction summary's stall watchdog (CLI-P9).
		case "stall_first_token":
		case "stall_mid_stream":
			return failure.stage === "harness" ? failure.errorClass : undefined;
	}
	const status = amount(failure.httpStatus);
	if (status === 401 || status === 403) return "auth_rejected";
	if (status === 429) return "rate_limited";
	if (status !== null && status >= 500) return "provider_5xx";
	if (status !== null && status >= 400) return "provider_4xx";
	if (failure.stage === "admission") return "admission_refused";
	if (failure.stage === "transport") return failure.invoked === false ? "transport_connect" : "transport_dropped";
	return failure.errorClass === "internal" ? "internal" : undefined;
}

/** The cause a Clio stream bound wrote on the message it ended, so a call it cut off names who stopped it (cf1h-D3). */
export function abortReasonCause(message: unknown): FailureCause | undefined {
	switch (record(message).clioCoderAbortReason) {
		case "tool_argument_generation":
			return "generation_guard";
		case "worker_turn_timeout":
			return "turn_timeout";
		case "worker_output_cap_exhausted":
			return "output_cap";
	}
	return undefined;
}

/**
 * Adapter placeholders are not measurements. A usage object is the provider's report once any count in it is
 * positive or the adapter marked it provider-reported; its zeros are then measured zeros (#434). An all-zero
 * object without that mark is the seed pi writes before a response arrives, and every field stays unknown.
 * A response that never reached its end, aborted or errored even with a status, keeps the positive counts its
 * provider reported as a lower bound, and its zeros stay unknown, because they may only mark where the stream stopped. A reported total above its own
 * breakdown is kept beside it. A settled breakdown keeps its measured zeros even then, because Gemini's total also
 * counts tool-use prompt tokens that Pi maps to no field; only a breakdown with no count at all, the legacy
 * total-only row, leaves its zeros unknown.
 */
/** What a sent call that reported no usage cost, estimated from its prompt side and the text it streamed. */
export interface InterruptedUsageEstimate {
	input: number;
	output: number;
	/** The estimate priced at the route's declared or catalog rates, when it has any. */
	usd?: number;
}

/** A side call cut off once shutdown began is the harness's stop, as a main call's is (bt-26 N2c, N2e). */
export function sideCallShutdownCause(message: unknown): "shutdown" | undefined {
	return record(message).stopReason === "aborted" && terminationPhase() !== "idle" ? "shutdown" : undefined;
}

/**
 * Declared per-million target rates priced against the settled counts of a call whose runtime computed no cost of its
 * own. A count with a non-zero rate that is not measured cannot be priced, so the amount is unknown, never a zero
 * (#434). A declared cache-write rate bills 1h writes at twice the input rate, as Pi's calculateCost does; an omitted
 * one is the documented $0 for every write.
 */
function targetRatesUsd(counts: CallUsage, rates: NonNullable<EffectivePricing["rates"]>): number | null {
	let perMillion = 0;
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const rate = rates[key] ?? 0;
		if (rate === 0) continue;
		const fact = counts[key];
		if (fact.kind !== "measured") return null;
		perMillion += fact.value * rate;
	}
	const writeRate = rates.cacheWrite ?? 0;
	const longWrite = counts.cacheWrite1h.kind === "measured" ? counts.cacheWrite1h.value : 0;
	if (writeRate > 0 && longWrite > 0) perMillion += longWrite * (rates.input * 2 - writeRate);
	return perMillion / 1_000_000;
}

export function callSettlementFromMessage(
	message: unknown,
	priced: EffectivePricing["pricedBy"] | (PricingBasisSource & { rates?: EffectivePricing["rates"] }),
	cause?: FailureCause,
	interrupted?: InterruptedUsageEstimate | null,
): Omit<CallSettled, keyof CallStarted | "stages"> {
	const { pricedBy, freeRule } = pricingBasis(priced);
	const rates = typeof priced === "string" ? null : (priced.rates ?? null);
	const raw = record(message);
	const usage = record(raw.usage);
	const failure = record(raw.failure);
	const external = record(usage.clioExternal);
	const neverSent = raw.callInvoked === false || usage.callInvoked === false || failure.invoked === false;
	const reported = normalizeTokenUsage(usage).observed;
	// A response refused for the model it was served by (row 384) still settled as the provider ended it.
	const stop = typeof raw.settledStopReason === "string" ? raw.settledStopReason : raw.stopReason;
	const reason = stop === "stop" || stop === "toolUse" || stop === "length" || stop === "aborted" ? stop : "error";
	const terminal = (reason !== "error" && reason !== "aborted") || typeof failure.httpStatus === "number";
	// Only a response that ran to its end can measure an unlisted zero; an aborted or errored one, even one that
	// carried a status, may have stopped before its provider reported that count.
	const completed = reason !== "error" && reason !== "aborted";
	const providerTotal = amount(usage.totalTokens);
	const breakdown = (["input", "output", "cacheRead", "cacheWrite"] as const).reduce(
		(sum, key) => sum + (amount(usage[key]) ?? 0),
		0,
	);
	const breakdownIncomplete = providerTotal !== null && providerTotal > breakdown;
	const totalOnly = breakdownIncomplete && breakdown === 0;
	// An adapter that knows which counts the provider sent lists them (copilot-sdk): a listed count is the
	// provider's measurement, and an unlisted one, the total included, is unknown whatever placeholder it holds. On a
	// call that never reached its end the lower-bound rule above still applies: a listed positive count is kept, a
	// listed zero may only mark where the stream stopped and stays unknown.
	const reportedFields = Array.isArray(usage.reportedFields)
		? new Set(usage.reportedFields.filter((field): field is string => typeof field === "string"))
		: null;
	const read = (key: keyof CallUsage | "totalTokens"): Fact<number> => {
		const value = amount(usage[key]);
		if (reportedFields !== null) {
			return reportedFields.has(key) && value !== null && Number.isInteger(value) && (terminal || value > 0)
				? { kind: "measured", value, source: "provider" }
				: unknown;
		}
		if (value === 0 && (!completed || totalOnly)) return unknown;
		if (
			usage.estimated === true ||
			(usage.clioExternal !== undefined && external.tokenUsage !== "provider-reported") ||
			value === null ||
			!Number.isInteger(value)
		)
			return unknown;
		if (key === "cacheRead" && usage.cacheReadField === "omitted") return unknown;
		// An inclusive prompt count less an omitted write count may still hold writes, so its fresh part is unknown too.
		if ((key === "cacheWrite" || key === "input") && usage.cacheWriteField === "omitted") return unknown;
		if (
			value > 0 ||
			reported ||
			external.tokenUsage === "provider-reported" ||
			(key === "cacheRead" && usage.cacheReadField === "sent") ||
			(key === "cacheWrite" && usage.cacheWriteField === "sent")
		) {
			return { kind: "measured", value, source: "provider" };
		}
		return unknown;
	};
	const output = read("output");
	const breakdownFacts = {
		input: read("input"),
		output,
		cacheRead: read("cacheRead"),
		cacheWrite: read("cacheWrite"),
	};
	// The provider's total stands beside a breakdown it exceeds or one with an unknown part, so the call's size stays
	// known when its split is not.
	const total =
		breakdownIncomplete || Object.values(breakdownFacts).some((fact) => fact.kind !== "measured")
			? read("totalTokens")
			: undefined;
	const counts: CallUsage = {
		...breakdownFacts,
		cacheWrite1h: read("cacheWrite1h"),
		reasoning: reasoningFact(read("reasoning"), raw.content, output),
		...(total?.kind === "measured" ? { total } : {}),
	};
	const observed = Object.values(counts).some((fact) => fact.kind === "measured");
	// A bound Clio stopped the call with outranks the transport failure its own abort produced (cf1h-D3).
	const failureCode =
		cause ??
		(failure.stage === "harness" ? failureCause(failure) : undefined) ??
		abortReasonCause(raw) ??
		failureCause(failure);
	const cost = record(usage.cost);
	const usd = amount(cost.total);
	const providerCost = usd !== null && (external.cost === "provider-reported" || cost.totalFromProvider === true);
	const servedModels = record(raw.copilotBilling).servedModels;
	const mixedModels = Array.isArray(servedModels) && new Set(servedModels).size > 1;
	let pricing: CallSettled["pricing"] = { usd: unknown, pricedBy: "none" };
	if (neverSent) pricing = { usd: { kind: "absent", reason: "not-applicable" }, pricedBy: "none" };
	else if (pricedBy === "free") pricing = pricedUsd("free", 0, freeRule);
	// A step whose calls different models served is priced by none of their rates, nor its total by one tier.
	else if (mixedModels && !providerCost) pricing = { usd: unknown, pricedBy: "none" };
	else if (observed && pricedBy === "target-rates" && !providerCost && (usd === null || cost.totalUncomputed === true)) {
		// A runtime that computed no cost (copilot-sdk marks its seeded zero totalUncomputed) is priced from its settled
		// counts at the declared rates, so a settlement handed no rates leaves the amount unknown (#434). A runtime that
		// computed its total from those rates keeps it below.
		const ratedUsd = rates === null ? null : targetRatesUsd(counts, rates);
		if (ratedUsd !== null) pricing = pricedUsd("target-rates", ratedUsd);
	} else if (usd !== null && observed) {
		// Declared target rates price measured tokens as measured, ranked only below a provider's own cost. The Pi
		// catalog rate is a guess at someone else's price list and stays estimated (#434). Pi marks a total the provider
		// billed with totalFromProvider, which OpenRouter reports for every call, on an unpriced target too.
		if (providerCost) pricing = pricedUsd("provider", usd);
		else if (pricedBy !== "none") pricing = pricedUsd(pricedBy, usd);
	} else if (
		!neverSent &&
		!observed &&
		!(reason === "error" && (typeof failure.httpStatus === "number" || !((interrupted?.output ?? 0) > 0)))
	) {
		// A sent call whose provider reported no usage is charged its request-size estimate on a priced route, so a cost
		// cap still trips; a provider that answered with an error status billed nothing, and neither did an errored call
		// that streamed no output, such as a refused connection, DNS failure or proxy refusal.
		const estimatedUsd = amount(interrupted?.usd);
		if (estimatedUsd !== null && (pricedBy === "target-rates" || pricedBy === "catalog"))
			pricing = { usd: { kind: "estimated", value: estimatedUsd, method: "prompt-side-only" }, pricedBy };
	}
	// The estimate an interrupted call gets when the provider reported nothing; the journal keeps it beside the
	// measured usage, never inside it, so a resumed transcript reads as the live one did (#430, #434).
	const estimated = (value: number | undefined, method: "prompt-side-only" | "chars/4") => {
		const tokens = amount(value);
		return tokens !== null && Number.isInteger(tokens) ? { kind: "estimated" as const, value: tokens, method } : null;
	};
	const interruptedInput = estimated(interrupted?.input, "prompt-side-only");
	const interruptedOutput = estimated(interrupted?.output, "chars/4");
	const interruptedEstimate =
		!neverSent && !terminal && !observed && interruptedInput && interruptedOutput
			? { input: interruptedInput, output: interruptedOutput }
			: undefined;
	return {
		disposition: neverSent ? "never_sent" : !terminal ? "sent_unsettled" : observed ? "settled" : "settled_no_usage",
		stop: { reason, ...((reason === "aborted" || reason === "error") && failureCode ? { failure: failureCode } : {}) },
		usage: neverSent ? null : counts,
		pricing,
		transport: transportFacts(raw, !neverSent),
		cache: {
			firstDivergentSection: unobserved,
			expectedColdReasons: [],
			rePrefilledTokens: unobserved,
			// Beside a measured cache read, the write bucket is prefilled too. It already includes the 1h subset.
			// A provider that omits its reads may report the whole prompt as input (#434).
			uncachedPrefillTokens:
				neverSent || !terminal
					? unobserved
					: counts.cacheRead.kind === "measured"
						? counts.input.kind === "measured" && counts.cacheWrite.kind === "measured"
							? { ...counts.input, value: counts.input.value + counts.cacheWrite.value }
							: counts.input
						: { kind: "unknown", reason: "provider-omitted" },
			verdict: "unknown",
		},
		...(typeof raw.responseId === "string" ? { responseId: raw.responseId } : {}),
		...(neverSent ? {} : wireEffortFact(raw)),
		...(usd !== null && providerCost && !neverSent
			? {
					economics: providerChargeEconomics({
						currency: "USD",
						amount: { kind: "measured", value: usd, source: "provider" },
						...(pricedBy === "free" && usd > 0 ? { discrepancy: "free-route" as const } : {}),
					}),
				}
			: {}),
		...copilotBilling(raw.copilotBilling, pricedBy === "free"),
		...(interruptedEstimate ? { interruptedEstimate } : {}),
	};
}

/** The seat units a copilot-sdk step reported (`CopilotStepBilling`, src/engine/copilot/stream.ts). */
function copilotBilling(raw: unknown, freeRoute: boolean): Pick<CallSettled, "billing"> {
	const billing = record(raw);
	if (Object.keys(billing).length === 0) return {};
	const fact = (value: unknown): Fact<number> =>
		typeof value === "number" && Number.isFinite(value) && value >= 0
			? { kind: "measured", value, source: "provider" }
			: unknown;
	const calls = billing.modelCalls;
	const premiumRequests = fact(billing.premiumRequests);
	const nanoAiu = fact(billing.nanoAiu);
	const debited = [premiumRequests, nanoAiu].some((unit) => unit.kind === "measured" && unit.value > 0);
	return {
		billing: {
			provider: "github-copilot",
			premiumRequests,
			nanoAiu,
			modelCalls:
				typeof calls === "number" && Number.isSafeInteger(calls) && calls >= 0
					? { kind: "measured", value: calls, source: "local-count" }
					: unknown,
			// The seat debited a call on a route declared free; both facts stand (R1).
			...(freeRoute && debited ? { discrepancy: "free-route" as const } : {}),
		},
	};
}

/**
 * A provider that reports no reasoning count still streamed the thinking it shows, so that text is estimated at
 * chars/4, never above the output the provider measured, since reasoning is part of it. A measured count, zero
 * included, is the provider's word and stands (#434).
 */
function reasoningFact(reported: Fact<number>, content: unknown, output: Fact<number>): Fact<number> {
	if (reported.kind === "measured") return reported;
	const chars = (Array.isArray(content) ? content : [])
		.map(record)
		.reduce(
			(sum, block) => sum + (block.type === "thinking" && typeof block.thinking === "string" ? block.thinking.length : 0),
			0,
		);
	if (chars === 0) return reported;
	const estimate = ceilChars(chars);
	return {
		kind: "estimated",
		value: output.kind === "measured" ? Math.min(estimate, output.value) : estimate,
		method: "chars/4",
	};
}

const STOP_REASONS = new Set(["stop", "toolUse", "length", "error", "aborted"]);

/**
 * A turn's terminal facts come from its own calls, never from prose (#430, #434). `fallbackCause` is a cause the
 * host knows structurally, such as an operator cancel that landed while no call was failing.
 */
export function turnSettlementFromCalls(
	stopReason: unknown,
	calls: readonly CallSettled[],
	retries: number,
	fallbackCause?: FailureCause,
	noAnswer?: TurnNoAnswerCause,
	bareFinishRefusals = 0,
): EventPayload<"turn.settled"> {
	const reason = (
		typeof stopReason === "string" && STOP_REASONS.has(stopReason) ? stopReason : "error"
	) as EventPayload<"turn.settled">["stopReason"];
	const last = calls.at(-1);
	const stages = last?.stages;
	const cause = (reason === "error" || reason === "aborted" ? last?.stop.failure : undefined) ?? fallbackCause ?? null;
	// A stop that landed after the final call ended, at its tool boundary, struck no stage of that call (bt-26 N2f).
	// The loop guard stops only from a tool, so a call it refused before sending was refused at that boundary (C-10).
	const betweenCalls =
		cause !== null &&
		last !== undefined &&
		((last.stop.reason !== "aborted" && last.stop.reason !== "error") ||
			(last.disposition === "never_sent" && last.stop.failure === "loop_guard"));
	return {
		stopReason: reason,
		terminal: {
			cause,
			// A call that streamed thinking or text reached past its first token, so it settles as streaming (bt-26 N2a).
			stage:
				!stages || betweenCalls
					? null
					: stages.firstToken !== undefined
						? "streaming"
						: stages.send
							? "send"
							: stages.admission
								? "admission"
								: stages.auth
									? "auth"
									: stages.transform
										? "transform"
										: null,
			retries: Math.max(0, Math.trunc(retries)),
			callIds: [...new Set(calls.map((call) => call.callId))],
			// Only a turn that stopped normally can answer nothing; a stop with its own cause is read by that cause.
			...(noAnswer !== undefined && reason === "stop" && cause === null ? { noAnswer } : {}),
		},
		...(bareFinishRefusals > 0 ? { bareFinishRefusals: Math.trunc(bareFinishRefusals) } : {}),
	};
}
