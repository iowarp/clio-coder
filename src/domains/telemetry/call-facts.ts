import { responseModelIdObservationFromRecord } from "../../core/response-model-id.js";
import type { FailureCause } from "../../core/telemetry/enums.js";
import type { EventPayload } from "../../core/telemetry/events.js";
import type { Fact } from "../../core/telemetry/fact.js";
import type { PricingBasisSource } from "../../core/telemetry/pricing.js";
import { pricedUsd, pricingBasis } from "../../core/telemetry/pricing.js";
import type { CallSettled, CallStarted, CallUsage } from "../../core/telemetry/schemas.js";
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
 * Transport facts Clio observes under option B: Pi keeps the Codex socket, so continuation, reuse and the SSE pin
 * come from Pi's per-session counters, attributed only when no other stream overlapped the call. The connect span and
 * handshake headers stay unknown. A delta frame's bytes are not the payload's, so they stay unknown too (#434).
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
	const continuation = codex.request === "delta" || codex.request === "full" ? codex.request : undefined;
	const bytes = sent && continuation !== "delta" ? amount(raw.clioCoderRequestBytes) : null;
	const cacheKey = sent && typeof raw.clioCoderPromptCacheKey === "string" ? raw.clioCoderPromptCacheKey : undefined;
	return {
		kind: codex.mode === "websocket" || codex.mode === "sse" ? codex.mode : "unknown",
		continuation: continuation ? counted(continuation) : unobserved,
		requestBytes:
			bytes === null || !Number.isInteger(bytes)
				? unobserved
				: { kind: "estimated", value: bytes, method: "payload-json" },
		sessionPinnedToSse: typeof codex.fallbackActive === "boolean" ? counted(codex.fallbackActive) : unobserved,
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

/**
 * Adapter placeholders are not measurements. A usage object is the provider's report once any count in it is
 * positive or the adapter marked it provider-reported; its zeros are then measured zeros (#434). An all-zero
 * object without that mark is the seed pi writes before a response arrives, and every field stays unknown.
 * A response that never reached its end keeps the positive counts its provider reported as a lower bound, and its
 * zeros stay unknown, because they may only mark where the stream stopped. A reported total above its own
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

export function callSettlementFromMessage(
	message: unknown,
	priced: EffectivePricing["pricedBy"] | PricingBasisSource,
	cause?: FailureCause,
	interrupted?: InterruptedUsageEstimate | null,
): Omit<CallSettled, keyof CallStarted | "stages"> {
	const { pricedBy, freeRule } = pricingBasis(priced);
	const raw = record(message);
	const usage = record(raw.usage);
	const failure = record(raw.failure);
	const external = record(usage.clioExternal);
	const neverSent = raw.callInvoked === false || usage.callInvoked === false || failure.invoked === false;
	const reported = normalizeTokenUsage(usage).observed;
	const stop = raw.stopReason;
	const reason = stop === "stop" || stop === "toolUse" || stop === "length" || stop === "aborted" ? stop : "error";
	const terminal = (reason !== "error" && reason !== "aborted") || typeof failure.httpStatus === "number";
	const providerTotal = amount(usage.totalTokens);
	const breakdown = (["input", "output", "cacheRead", "cacheWrite"] as const).reduce(
		(sum, key) => sum + (amount(usage[key]) ?? 0),
		0,
	);
	const breakdownIncomplete = providerTotal !== null && providerTotal > breakdown;
	const totalOnly = breakdownIncomplete && breakdown === 0;
	// An adapter that knows which counts the provider sent lists them (copilot-sdk): a listed count is the
	// provider's measurement, and an unlisted one is unknown whatever placeholder it holds. On a call that never
	// reached its end the lower-bound rule above still applies: a listed positive count is kept, a listed zero
	// may only mark where the stream stopped and stays unknown.
	const reportedFields = Array.isArray(usage.reportedFields)
		? new Set(usage.reportedFields.filter((field): field is string => typeof field === "string"))
		: null;
	const read = (key: keyof CallUsage | "totalTokens"): Fact<number> => {
		const value = amount(usage[key]);
		if (reportedFields !== null && key !== "totalTokens") {
			return reportedFields.has(key) && value !== null && Number.isInteger(value) && (terminal || value > 0)
				? { kind: "measured", value, source: "provider" }
				: unknown;
		}
		if (value === 0 && (!terminal || totalOnly)) return unknown;
		if (
			usage.estimated === true ||
			(usage.clioExternal !== undefined && external.tokenUsage !== "provider-reported") ||
			value === null ||
			!Number.isInteger(value)
		)
			return unknown;
		if (key === "cacheRead" && usage.cacheReadField === "omitted") return unknown;
		if (
			value > 0 ||
			reported ||
			external.tokenUsage === "provider-reported" ||
			(key === "cacheRead" && usage.cacheReadField === "sent")
		) {
			return { kind: "measured", value, source: "provider" };
		}
		return unknown;
	};
	const total = breakdownIncomplete ? read("totalTokens") : undefined;
	const output = read("output");
	const counts: CallUsage = {
		input: read("input"),
		output,
		cacheRead: read("cacheRead"),
		cacheWrite: read("cacheWrite"),
		cacheWrite1h: read("cacheWrite1h"),
		reasoning: reasoningFact(read("reasoning"), raw.content, output),
		...(total?.kind === "measured" ? { total } : {}),
	};
	const observed = Object.values(counts).some((fact) => fact.kind === "measured");
	const failureCode = cause ?? failureCause(failure);
	const cost = record(usage.cost);
	const usd = amount(cost.total);
	let pricing: CallSettled["pricing"] = { usd: unknown, pricedBy: "none" };
	if (neverSent) pricing = { usd: { kind: "absent", reason: "not-applicable" }, pricedBy: "none" };
	else if (pricedBy === "free") pricing = pricedUsd("free", 0, freeRule);
	else if (usd !== null && observed) {
		// Declared target rates price measured tokens as measured, ranked only below a provider's own cost. The Pi
		// catalog rate is a guess at someone else's price list and stays estimated (#434). Pi marks a total the provider
		// billed with totalFromProvider, which OpenRouter reports for every call, on an unpriced target too.
		if (external.cost === "provider-reported" || cost.totalFromProvider === true) pricing = pricedUsd("provider", usd);
		else if (pricedBy !== "none") pricing = pricedUsd(pricedBy, usd);
	} else if (!neverSent && !observed && !(reason === "error" && typeof failure.httpStatus === "number")) {
		// A sent call whose provider reported no usage is charged its request-size estimate on a priced route, so a cost
		// cap still trips; a provider that answered with an error status billed nothing.
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
			// Input is the uncached prefill only beside a measured cache read; a provider that omits its reads reports
			// the whole prompt there (#434).
			uncachedPrefillTokens:
				neverSent || !terminal
					? unobserved
					: counts.cacheRead.kind === "measured"
						? counts.input
						: { kind: "unknown", reason: "provider-omitted" },
			verdict: "unknown",
		},
		...(typeof raw.responseId === "string" ? { responseId: raw.responseId } : {}),
		...copilotBilling(raw.copilotBilling),
		...(interruptedEstimate ? { interruptedEstimate } : {}),
	};
}

/** The seat units a copilot-sdk step reported (`CopilotStepBilling`, src/engine/copilot/stream.ts). */
function copilotBilling(raw: unknown): Pick<CallSettled, "billing"> {
	const billing = record(raw);
	if (Object.keys(billing).length === 0) return {};
	const fact = (value: unknown): Fact<number> =>
		typeof value === "number" && Number.isFinite(value) && value >= 0
			? { kind: "measured", value, source: "provider" }
			: unknown;
	const calls = billing.modelCalls;
	return {
		billing: {
			provider: "github-copilot",
			premiumRequests: fact(billing.premiumRequests),
			nanoAiu: fact(billing.nanoAiu),
			modelCalls:
				typeof calls === "number" && Number.isSafeInteger(calls) && calls >= 0
					? { kind: "measured", value: calls, source: "local-count" }
					: unknown,
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
): EventPayload<"turn.settled"> {
	const reason = (
		typeof stopReason === "string" && STOP_REASONS.has(stopReason) ? stopReason : "error"
	) as EventPayload<"turn.settled">["stopReason"];
	const last = calls.at(-1);
	const stages = last?.stages;
	return {
		stopReason: reason,
		terminal: {
			cause: (reason === "error" || reason === "aborted" ? last?.stop.failure : undefined) ?? fallbackCause ?? null,
			stage: !stages
				? null
				: stages.firstToken !== undefined
					? "firstToken"
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
		},
	};
}
