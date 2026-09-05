import { extractReasoningTokens } from "../../session/context-accounting.js";
import type { EvalTokenMetricsV4 } from "../schema/artifact.js";

export interface EvalTokenStreamUsage {
	/**
	 * True when the stream carried at least one completed assistant message
	 * with observed token facts. False means this runner observed no token
	 * accounting at all, which is not the same as a run that cost nothing.
	 */
	measured: boolean;
	/** Known token subtotals; missing failed-call coverage is reported separately. */
	tokens: EvalTokenMetricsV4;
	costUsd: number;
	provider: EvalProviderObservation;
}

export interface EvalTokenUsageFold {
	/** Feed a raw stdout chunk; partial trailing lines are held until completed. */
	push(chunk: string): void;
	usage(): EvalTokenStreamUsage;
}

export const UNMEASURED_TOKEN_USAGE: EvalTokenStreamUsage = {
	measured: false,
	tokens: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
	costUsd: 0,
	provider: emptyProviderObservation(),
};

/**
 * Fold provider usage out of a `clio-coder run --json` stream as it arrives.
 *
 * Usage is counted from `message_end` events only. That is the one event
 * carrying a completed message's usage exactly once; `turn_end` republishes
 * the same assistant message and `agent_end` republishes its segment's
 * summary, so counting those too would multiply a run's reported cost. Every
 * reported call counts, including known errored-call spend: a headless turn
 * spans several segments and its cost is their sum. Provider facts and the
 * errored known share are folded here too, from the same events before truncation.
 * Failed all-zero usage is ambiguous (adapters synthesize it), so it cannot
 * establish measured usage. Unknown failed spend is retained as missing coverage,
 * never subtracted from inclusive totals or used to change task pass policy.
 *
 * Folding as the stream arrives is what makes the count trustworthy: the
 * operator-facing stdout artifact keeps only a bounded head and tail, so a
 * verbose run's usage events do not survive in it.
 */
export function createTokenUsageFold(): EvalTokenUsageFold {
	const tokens: EvalTokenMetricsV4 = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 };
	let costUsd = 0;
	let measured = false;
	let pending = "";
	const provider = emptyProviderObservation();

	const consume = (line: string): void => {
		if (line.trim().length === 0) return;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(event)) return;
		observeProviderEvent(provider, event);
		if (event.type !== "message_end" || !isRecord(event.message) || event.message.role !== "assistant") return;
		const usage = readMessageUsage(event.message);
		if (usage === null) return;
		if (Object.keys(usage.tokens).length > 0) {
			measured = true;
			for (const field of TOKEN_FIELDS) tokens[field] += usage.tokens[field] ?? 0;
		}
		costUsd += usage.costUsd ?? 0;
	};

	return {
		push(chunk: string): void {
			pending += chunk;
			for (;;) {
				const newline = pending.indexOf("\n");
				if (newline === -1) break;
				consume(pending.slice(0, newline).replace(/\r$/u, ""));
				pending = pending.slice(newline + 1);
			}
		},
		usage(): EvalTokenStreamUsage {
			if (pending.length > 0) {
				consume(pending.replace(/\r$/u, ""));
				pending = "";
			}
			return { measured, tokens: { ...tokens }, costUsd, provider: structuredClone(provider) };
		},
	};
}

export function addTokenStreamUsage(left: EvalTokenStreamUsage, right: EvalTokenStreamUsage): EvalTokenStreamUsage {
	return {
		measured: left.measured || right.measured,
		tokens: {
			input: left.tokens.input + right.tokens.input,
			output: left.tokens.output + right.tokens.output,
			total: left.tokens.total + right.tokens.total,
			cacheRead: left.tokens.cacheRead + right.tokens.cacheRead,
			cacheWrite: left.tokens.cacheWrite + right.tokens.cacheWrite,
		},
		costUsd: left.costUsd + right.costUsd,
		provider: addProviderObservations(left.provider, right.provider),
	};
}

/**
 * Metric keys for one runner's token accounting. An unmeasured runner emits
 * `tokens.measured: false` and no counts at all, so nothing downstream can
 * read an absence as a zero-cost run.
 */
export function tokenMetricEntries(usage: EvalTokenStreamUsage): Record<string, number | boolean> {
	return {
		...providerMetricEntries(usage.provider),
		"tokens.measured": usage.measured,
		...(usage.measured
			? {
					"tokens.input": usage.tokens.input,
					"tokens.output": usage.tokens.output,
					"tokens.total": usage.tokens.total,
					"tokens.cacheRead": usage.tokens.cacheRead,
					"tokens.cacheWrite": usage.tokens.cacheWrite,
				}
			: {}),
		...(usage.costUsd > 0 ? { "cost.usd": usage.costUsd } : {}),
	};
}

const TOKEN_FIELDS = ["input", "output", "total", "cacheRead", "cacheWrite"] as const;
const STOP_REASONS = ["stop", "toolUse", "length", "error", "aborted", "other"] as const;
const RETRY_PHASES = {
	scheduled: "retryScheduled",
	retrying: "retryStarted",
	cancelled: "retryCancelled",
	exhausted: "retryExhausted",
	recovered: "retryRecovered",
} as const;
type StopReason = (typeof STOP_REASONS)[number];
type RetryPhase = keyof typeof RETRY_PHASES;

interface EvalProviderObservation {
	measured: boolean;
	stops: Record<StopReason, number>;
	retries: Record<RetryPhase, number>;
	errorUsageObservedCalls: number;
	errorUsageUnobservedCalls: number;
	errorUsageIncompleteCalls: number;
	errorCostUnobservedCalls: number;
	errorReasoningUnobservedCalls: number;
	errorReasoningTokens: number | null;
	errorTokens: Partial<EvalTokenMetricsV4>;
	errorCostUsd: number | null;
}

interface MessageUsageObservation {
	reasoningTokens: number | null;
	tokens: Partial<EvalTokenMetricsV4>;
	costUsd: number | null;
	completeTokens: boolean;
}

function emptyProviderObservation(): EvalProviderObservation {
	return {
		measured: false,
		stops: { stop: 0, toolUse: 0, length: 0, error: 0, aborted: 0, other: 0 },
		retries: { scheduled: 0, retrying: 0, cancelled: 0, exhausted: 0, recovered: 0 },
		errorUsageObservedCalls: 0,
		errorUsageUnobservedCalls: 0,
		errorUsageIncompleteCalls: 0,
		errorCostUnobservedCalls: 0,
		errorReasoningUnobservedCalls: 0,
		errorReasoningTokens: null,
		errorTokens: {},
		errorCostUsd: null,
	};
}

/** Same usage interpretation for inclusive totals and their known errored share. */
function readMessageUsage(message: Record<string, unknown>): MessageUsageObservation | null {
	if (!isRecord(message.usage)) return null;
	const usage = message.usage;
	const failed = message.stopReason === "error" || message.stopReason === "aborted";
	const raw: Partial<EvalTokenMetricsV4> = {};
	for (const field of TOKEN_FIELDS) {
		const value = nonNegativeNumber(usage[field === "total" ? "totalTokens" : field]);
		// Failed adapter objects can initialize each absent field to zero even
		// when another field is reported. Keep only attributable positive facts.
		if (value !== null && (!failed || value > 0)) raw[field] = value;
	}
	const cost = isRecord(usage.cost) ? nonNegativeNumber(usage.cost.total) : null;
	// Zero prices are also initialized by adapters without pricing evidence.
	const costUsd = cost !== null && cost > 0 ? cost : null;

	// The compat adapter can synthesize the root reasoningTokens alias from
	// thinking text without marking it estimated. Preserve explicit provider
	// detail through the shared reader, but never promote that ambiguous alias.
	// Normalized zero reasoning can also mean omitted provider detail.
	const reportedReasoning = extractReasoningTokens({ ...usage, reasoningTokens: undefined });
	const reasoningTokens = reportedReasoning !== null && reportedReasoning > 0 ? reportedReasoning : null;
	const tokens = raw;
	if (Object.keys(tokens).length === 0 && costUsd === null && reasoningTokens === null) return null;
	const completeTokens = Object.keys(tokens).length === TOKEN_FIELDS.length;
	if (Object.keys(tokens).length > 0 && !(tokens.total !== undefined && tokens.total > 0)) {
		// This is a known subtotal when fields are missing; coverage stays incomplete.
		tokens.total = (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0);
	}
	return { tokens, costUsd, completeTokens, reasoningTokens };
}

function observeProviderEvent(provider: EvalProviderObservation, event: Record<string, unknown>): void {
	if (event.type === "retry_status" && isRecord(event.status)) {
		const phase = event.status.phase;
		if (typeof phase === "string" && Object.hasOwn(RETRY_PHASES, phase)) {
			provider.measured = true;
			provider.retries[phase as RetryPhase] += 1;
		}
		// Waiting frames are countdown ticks, not attempts. Attempt numbers may
		// restart in another chain, so neither frames nor attempts are deduplicated.
		return;
	}
	if (event.type !== "message_end" || !isRecord(event.message) || event.message.role !== "assistant") return;
	const reason = event.message.stopReason;
	if (typeof reason !== "string" || reason.length === 0 || reason === "pending") return;
	provider.measured = true;
	const stop = STOP_REASONS.includes(reason as StopReason) ? (reason as StopReason) : "other";
	provider.stops[stop] += 1;
	if (reason !== "error") return;
	const usage = readMessageUsage(event.message);
	if (usage === null) provider.errorUsageUnobservedCalls += 1;
	else {
		provider.errorUsageObservedCalls += 1;
		for (const field of TOKEN_FIELDS) {
			const value = usage.tokens[field];
			if (value !== undefined) provider.errorTokens[field] = (provider.errorTokens[field] ?? 0) + value;
		}
	}
	if (usage?.completeTokens !== true) provider.errorUsageIncompleteCalls += 1;
	if (usage?.costUsd === undefined || usage.costUsd === null) provider.errorCostUnobservedCalls += 1;
	else provider.errorCostUsd = (provider.errorCostUsd ?? 0) + usage.costUsd;
	if (usage?.reasoningTokens === undefined || usage.reasoningTokens === null)
		provider.errorReasoningUnobservedCalls += 1;
	else provider.errorReasoningTokens = (provider.errorReasoningTokens ?? 0) + usage.reasoningTokens;
}

function addProviderObservations(
	left: EvalProviderObservation,
	right: EvalProviderObservation,
): EvalProviderObservation {
	const result = emptyProviderObservation();
	result.measured = left.measured || right.measured;
	for (const reason of STOP_REASONS) result.stops[reason] = left.stops[reason] + right.stops[reason];
	for (const phase of Object.keys(RETRY_PHASES) as RetryPhase[])
		result.retries[phase] = left.retries[phase] + right.retries[phase];
	result.errorUsageObservedCalls = left.errorUsageObservedCalls + right.errorUsageObservedCalls;
	result.errorUsageUnobservedCalls = left.errorUsageUnobservedCalls + right.errorUsageUnobservedCalls;
	result.errorUsageIncompleteCalls = left.errorUsageIncompleteCalls + right.errorUsageIncompleteCalls;
	result.errorCostUnobservedCalls = left.errorCostUnobservedCalls + right.errorCostUnobservedCalls;
	result.errorReasoningUnobservedCalls = left.errorReasoningUnobservedCalls + right.errorReasoningUnobservedCalls;
	if (left.errorReasoningTokens !== null || right.errorReasoningTokens !== null)
		result.errorReasoningTokens = (left.errorReasoningTokens ?? 0) + (right.errorReasoningTokens ?? 0);
	for (const field of TOKEN_FIELDS) {
		if (left.errorTokens[field] !== undefined || right.errorTokens[field] !== undefined) {
			result.errorTokens[field] = (left.errorTokens[field] ?? 0) + (right.errorTokens[field] ?? 0);
		}
	}
	if (left.errorCostUsd !== null || right.errorCostUsd !== null)
		result.errorCostUsd = (left.errorCostUsd ?? 0) + (right.errorCostUsd ?? 0);
	return result;
}

/** Provider observations are independent of task success and receipt billing. */
function providerMetricEntries(provider: EvalProviderObservation): Record<string, number | boolean> {
	if (!provider.measured) return { "provider.measured": false };
	const metrics: Record<string, number | boolean> = { "provider.measured": true };
	for (const reason of STOP_REASONS) metrics[`provider.stopReason.${reason}`] = provider.stops[reason];
	for (const phase of Object.keys(RETRY_PHASES) as RetryPhase[])
		metrics[`provider.${RETRY_PHASES[phase]}`] = provider.retries[phase];
	if (provider.stops.error === 0) return metrics;
	metrics["provider.errorUsageObservedCalls"] = provider.errorUsageObservedCalls;
	metrics["provider.errorUsageUnobservedCalls"] = provider.errorUsageUnobservedCalls;
	metrics["provider.errorUsageIncompleteCalls"] = provider.errorUsageIncompleteCalls;
	metrics["provider.errorCostUnobservedCalls"] = provider.errorCostUnobservedCalls;
	metrics["provider.errorReasoningUnobservedCalls"] = provider.errorReasoningUnobservedCalls;
	if (provider.errorReasoningTokens !== null) metrics["provider.errorReasoningTokens"] = provider.errorReasoningTokens;
	for (const field of TOKEN_FIELDS) {
		const value = provider.errorTokens[field];
		if (value !== undefined) metrics[`provider.errorTokens.${field}`] = value;
	}
	if (provider.errorCostUsd !== null) metrics["provider.errorCostUsd"] = provider.errorCostUsd;
	return metrics;
}

function nonNegativeNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
