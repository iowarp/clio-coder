import type { FailureCause } from "../../core/telemetry/enums.js";
import type { Fact } from "../../core/telemetry/fact.js";
import type { CallSettled, CallStarted, CallUsage } from "../../core/telemetry/schemas.js";
import type { CostProvenance } from "../providers/types/cost-provenance.js";

const unknown = { kind: "unknown", reason: "provider-omitted" } as const;
const unobserved = { kind: "unknown", reason: "not-observed" } as const;
const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const amount = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

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

/** Adapter placeholders are not measurements. Only an explicit report or a positive count proves a field (#434). */
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
	const read = (key: keyof CallUsage): Fact<number> => {
		const value = amount(usage[key]);
		if (usage.estimated === true || value === null || !Number.isInteger(value)) return unknown;
		if (key === "cacheRead" && usage.cacheReadReported === false) return unknown;
		if (
			value > 0 ||
			external.tokenUsage === "provider-reported" ||
			(key === "cacheRead" && usage.cacheReadReported === true)
		) {
			return { kind: "measured", value, source: "provider" };
		}
		return unknown;
	};
	const counts: CallUsage = {
		input: read("input"),
		output: read("output"),
		cacheRead: read("cacheRead"),
		cacheWrite: read("cacheWrite"),
		cacheWrite1h: read("cacheWrite1h"),
		reasoning: read("reasoning"),
	};
	const observed = Object.values(counts).some((fact) => fact.kind === "measured");
	const stop = raw.stopReason;
	const reason = stop === "stop" || stop === "toolUse" || stop === "length" || stop === "aborted" ? stop : "error";
	const failureCode = cause ?? failureCause(failure);
	const terminal = (reason !== "error" && reason !== "aborted") || typeof failure.httpStatus === "number";
	const usd = amount(record(usage.cost).total);
	let pricing: CallSettled["pricing"] = { usd: unknown, pricedBy: "none" };
	if (neverSent) pricing = { usd: { kind: "absent", reason: "not-applicable" }, pricedBy: "none" };
	else if (costProvenance === "known_free")
		pricing = { usd: { kind: "measured", value: 0, source: "local-count" }, pricedBy: "free" };
	else if (usd !== null && observed && terminal) {
		if (external.cost === "provider-reported")
			pricing = { usd: { kind: "measured", value: usd, source: "provider" }, pricedBy: "provider" };
		else if (costProvenance === "known" || costProvenance === "estimated") {
			const method = costProvenance === "known" ? "target-rates" : "catalog";
			pricing = { usd: { kind: "estimated", value: usd, method }, pricedBy: method };
		}
	}
	return {
		disposition: neverSent ? "never_sent" : !terminal ? "sent_unsettled" : observed ? "settled" : "settled_no_usage",
		stop: { reason, ...((reason === "aborted" || reason === "error") && failureCode ? { failure: failureCode } : {}) },
		usage: neverSent
			? null
			: terminal
				? counts
				: {
						input: unknown,
						output: unknown,
						cacheRead: unknown,
						cacheWrite: unknown,
						cacheWrite1h: unknown,
						reasoning: unknown,
					},
		pricing,
		transport: { kind: "unknown", continuation: unobserved, requestBytes: unobserved, sessionPinnedToSse: unobserved },
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
