import { responseModelIdObservationFromRecord } from "../../core/response-model-id.js";
import type { FailureCause } from "../../core/telemetry/enums.js";
import type { Fact } from "../../core/telemetry/fact.js";
import type { CallSettled, CallStarted, CallUsage, Payload } from "../../core/telemetry/schemas.js";
import { normalizeTokenUsage } from "../../core/token-split.js";
import type { CostProvenance } from "../providers/types/cost-provenance.js";

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
	const continuation = codex.request === "delta" || codex.request === "full" ? codex.request : undefined;
	const bytes = sent && continuation !== "delta" ? amount(raw.clioCoderRequestBytes) : null;
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
 * breakdown leaves the breakdown's zeros unknown too, and the total is kept beside it.
 */
export function callSettlementFromMessage(
	message: unknown,
	costProvenance: CostProvenance,
	cause?: FailureCause,
): Omit<CallSettled, keyof CallStarted | "stages"> {
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
	const read = (key: keyof CallUsage | "totalTokens"): Fact<number> => {
		const value = amount(usage[key]);
		if (value === 0 && (!terminal || breakdownIncomplete)) return unknown;
		if (
			usage.estimated === true ||
			(usage.clioExternal !== undefined && external.tokenUsage !== "provider-reported") ||
			value === null ||
			!Number.isInteger(value)
		)
			return unknown;
		if (key === "cacheRead" && usage.cacheReadReported === false) return unknown;
		if (
			value > 0 ||
			reported ||
			external.tokenUsage === "provider-reported" ||
			(key === "cacheRead" && usage.cacheReadReported === true)
		) {
			return { kind: "measured", value, source: "provider" };
		}
		return unknown;
	};
	const total = breakdownIncomplete ? read("totalTokens") : undefined;
	const counts: CallUsage = {
		input: read("input"),
		output: read("output"),
		cacheRead: read("cacheRead"),
		cacheWrite: read("cacheWrite"),
		cacheWrite1h: read("cacheWrite1h"),
		reasoning: read("reasoning"),
		...(total?.kind === "measured" ? { total } : {}),
	};
	const observed = Object.values(counts).some((fact) => fact.kind === "measured");
	const failureCode = cause ?? failureCause(failure);
	const usd = amount(record(usage.cost).total);
	let pricing: CallSettled["pricing"] = { usd: unknown, pricedBy: "none" };
	if (neverSent) pricing = { usd: { kind: "absent", reason: "not-applicable" }, pricedBy: "none" };
	else if (costProvenance === "known_free")
		pricing = { usd: { kind: "measured", value: 0, source: "local-count" }, pricedBy: "free" };
	else if (usd !== null && observed) {
		if (external.cost === "provider-reported")
			pricing = { usd: { kind: "measured", value: usd, source: "provider" }, pricedBy: "provider" };
		// Declared target rates price measured tokens exactly as 0.6.5 did: known, ranked only below a provider's own
		// cost. The Pi catalog rate is a guess at someone else's price list and stays estimated (#434).
		else if (costProvenance === "known")
			pricing = { usd: { kind: "measured", value: usd, source: "local-count" }, pricedBy: "target-rates" };
		else if (costProvenance === "estimated")
			pricing = { usd: { kind: "estimated", value: usd, method: "catalog" }, pricedBy: "catalog" };
	}
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
			uncachedPrefillTokens: neverSent || !terminal ? unobserved : counts.input,
			verdict: "unknown",
		},
		...(typeof raw.responseId === "string" ? { responseId: raw.responseId } : {}),
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
): Payload<"turn.settled"> {
	const reason = (
		typeof stopReason === "string" && STOP_REASONS.has(stopReason) ? stopReason : "error"
	) as Payload<"turn.settled">["stopReason"];
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
