import { hostname } from "node:os";
import { processBirthToken } from "../core/process-identity.js";
import type { Fact } from "../core/telemetry/fact.js";
import { createTelemetryForwarder } from "../core/telemetry/forwarder.js";
import { telemetryHub } from "../core/telemetry/hub.js";
import { newAttemptId, newCallId } from "../core/telemetry/ids.js";
import type { CallUsage, RunUsage } from "../core/telemetry/schemas.js";
import { calculatePricingCostUsd } from "../domains/providers/catalog.js";
import { callSettlementFromMessage, reportedModelFromMessage } from "../domains/telemetry/call-facts.js";
import type { WorkerEventEmit, WorkerRunHandle, WorkerRunInput } from "./worker-runtime.js";

const unknown = { kind: "unknown", reason: "provider-omitted" } as const;
const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const fields = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning"] as const;

export interface ExternalUsageObservation {
	usage: Record<string, unknown>;
	coverage: RunUsage["coverage"];
	costEstimateMethod?: "peer-report";
	stopReason?: "stop" | "toolUse" | "length";
	/** Normalized fallback rows may contain placeholders; only positive verified fields survive (#434). */
	normalized?: boolean;
}
const observations = new WeakMap<object, ExternalUsageObservation>();

/** Keep raw field presence in process memory; the existing message and SDK payload stay unchanged (#434). */
export function bindExternalUsage<T extends object>(message: T, observation: ExternalUsageObservation): T {
	observations.set(message, observation);
	return message;
}

export function externalUsageFacts(
	observation: ExternalUsageObservation,
): Pick<
	RunUsage,
	| "usage"
	| "totalTokens"
	| "apiCalls"
	| "missingTokenCalls"
	| "pricing"
	| "coverage"
	| "pricingCoverage"
	| "callCountCoverage"
> {
	const raw = observation.usage;
	const external = record(raw.clioExternal);
	const tokensVerified =
		raw.estimated !== true && (raw.clioExternal === undefined || external.tokenUsage === "provider-reported");
	const read = (value: unknown, integer = true): Fact<number> =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value))
			? { kind: "measured", value, source: "provider" }
			: unknown;
	const token = (key: string): Fact<number> =>
		!tokensVerified || (observation.normalized && raw[key] === 0) ? unknown : read(raw[key]);
	const usage = Object.fromEntries(fields.map((key) => [key, token(key)])) as CallUsage;
	const cost = record(raw.cost).total ?? raw.costUsd;
	const usd =
		raw.costProvenance === "unknown" ||
		external.cost === "missing" ||
		external.cost === "unverified" ||
		(observation.normalized && cost === 0)
			? unknown
			: read(cost, false);
	// Declared target rates read as known (#434); a peer's own total or a catalog rate stays an estimate.
	const declaredRates =
		usd.kind === "measured" &&
		raw.costProvenance === "known" &&
		external.cost !== "provider-reported" &&
		observation.costEstimateMethod === undefined;
	const estimatedUsd =
		usd.kind === "measured" &&
		!declaredRates &&
		(raw.costProvenance === "estimated" || raw.costProvenance === "known") &&
		external.cost !== "provider-reported"
			? {
					kind: "estimated" as const,
					value: usd.value,
					method:
						observation.costEstimateMethod ??
						(raw.costProvenance === "known" ? ("target-rates" as const) : ("catalog" as const)),
				}
			: usd.kind === "measured" && declaredRates
				? { kind: "measured" as const, value: usd.value, source: "local-count" as const }
				: usd;
	return {
		usage,
		totalTokens: token("totalTokens"),
		apiCalls: read(raw.apiCalls),
		missingTokenCalls: read(raw.missingTokenCalls),
		pricing: {
			usd: estimatedUsd,
			pricedBy:
				estimatedUsd.kind === "estimated"
					? observation.costEstimateMethod === "peer-report"
						? "provider"
						: raw.costProvenance === "known"
							? "target-rates"
							: "catalog"
					: estimatedUsd.kind === "measured"
						? declaredRates
							? "target-rates"
							: "provider"
						: "none",
		},
		coverage: observation.coverage,
		pricingCoverage: estimatedUsd.kind === "unknown" ? "unknown" : "complete",
		callCountCoverage:
			typeof raw.unknownCallCoverageRuns === "number" && raw.unknownCallCoverageRuns > 0 ? "partial" : "complete",
	};
}

function externalTarget(input: WorkerRunInput) {
	return {
		targetId: input.target.id,
		runtimeId: input.runtime.id,
		api: input.runtime.id,
		requestedModel: input.wireModelId,
		reportedModel: { kind: "unknown", reason: "not-observed" } as const,
	};
}

function priceExternalUsage(input: WorkerRunInput, facts: ReturnType<typeof externalUsageFacts>) {
	if (facts.pricing.usd.kind !== "unknown" || !input.target.pricing) return facts;
	const rates = input.target.pricing;
	if (
		rates === "free" ||
		[rates.input, rates.output, rates.cacheRead ?? 0, rates.cacheWrite ?? 0].every((rate) => rate === 0)
	)
		return {
			...facts,
			pricingCoverage: "complete" as const,
			pricing: {
				usd: { kind: "measured" as const, value: 0, source: "local-count" as const },
				pricedBy: "free" as const,
			},
		};
	const keys = ["input", "output", "cacheRead", "cacheWrite"] as const;
	if (keys.some((key) => (rates[key] ?? 0) !== 0 && facts.usage[key].kind !== "measured")) return facts;
	const counts = Object.fromEntries(
		keys.map((key) => [key, facts.usage[key].kind === "measured" ? facts.usage[key].value : 0]),
	) as Record<(typeof keys)[number], number>;
	return {
		...facts,
		pricingCoverage: "complete" as const,
		pricing: {
			usd: {
				kind: "measured" as const,
				value: calculatePricingCostUsd(
					{ input: rates.input, output: rates.output, cacheRead: rates.cacheRead ?? 0, cacheWrite: rates.cacheWrite ?? 0 },
					counts,
				),
				source: "local-count" as const,
			},
			pricedBy: "target-rates" as const,
		},
	};
}

/** A peer's incremental report describes a disjoint scope, without asserting an API invocation (#434). */
export function recordExternalUsagePart(
	input: WorkerRunInput,
	partId: string,
	observation: ExternalUsageObservation,
): void {
	if (!input.telemetryContext) return;
	telemetryHub().emit(
		"run.usage_reported",
		{
			...priceExternalUsage(input, externalUsageFacts(observation)),
			source: "external-cli",
			scope: "run",
			partId,
			revision: 0,
			target: externalTarget(input),
		},
		input.telemetryContext,
	);
}

/** The engine observes external summaries without pretending each summary is one provider request (#434). */
export function observeExternalWorkerRun(
	input: WorkerRunInput,
	emit: WorkerEventEmit,
	start: (emit: WorkerEventEmit) => WorkerRunHandle,
	aggregateMessages = true,
): WorkerRunHandle {
	const context = input.telemetryContext;
	if (!context) return start(emit);
	const forwarder = createTelemetryForwarder(
		context,
		{ host: hostname(), pid: process.pid, birthToken: processBirthToken(), monoEpochWallMs: performance.timeOrigin },
		emit,
	);
	const target = externalTarget(input);

	let revision = 0;
	const calls = new Set<string>();
	telemetryHub().emit("process.started", {}, context);
	forwarder.flush();
	try {
		const handle = start((event) => {
			if (event.type === "clio_coder_model_call") {
				const payload = event.payload;
				const observed = observations.get(payload);
				const identity = payload.responseId ?? String(payload.callIndex);
				if (observed && !calls.has(identity)) {
					calls.add(identity);
					const facts = priceExternalUsage(input, externalUsageFacts(observed));
					const callId = newCallId();
					const attemptId = newAttemptId();
					const settlement = callSettlementFromMessage(
						{ stopReason: "stop", usage: { ...observed.usage, clioExternal: { tokenUsage: "provider-reported" } } },
						"none",
					);
					telemetryHub().emit(
						"call.settled",
						{
							...settlement,
							disposition:
								observed.coverage === "complete"
									? Object.values(facts.usage).some((fact) => fact.kind === "measured")
										? "settled"
										: "settled_no_usage"
									: "sent_unsettled",
							stop: { reason: observed.stopReason ?? "unknown" },
							usage:
								observed.coverage === "complete"
									? facts.usage
									: (Object.fromEntries(fields.map((field) => [field, unknown])) as CallUsage),
							pricing: facts.pricing,
							callId,
							attemptId,
							attempt: 0,
							target: { ...target, reportedModel: reportedModelFromMessage(payload) },
							roundKind: "unknown",
							toolChoice: "unknown",
							stages: { settle: null },
						},
						{ ...context, callId, attemptId },
					);
				}
			} else if (aggregateMessages && event.type === "message_end" && event.message.role === "assistant") {
				const message = event.message;
				const bound = observations.get(message);
				const facts = priceExternalUsage(
					input,
					externalUsageFacts(bound ?? { usage: record(message.usage), coverage: "unknown", normalized: true }),
				);
				telemetryHub().emit(
					"run.usage_reported",
					{
						...facts,
						source: input.runtime.id === "claude-sdk" ? "claude-sdk" : "external-cli",
						scope: "run",
						revision: revision++,
						target,
					},
					context,
				);
			}
			emit(event);
		});
		return { ...handle, promise: handle.promise.finally(() => forwarder.close()) };
	} catch (error) {
		forwarder.close();
		throw error;
	}
}
