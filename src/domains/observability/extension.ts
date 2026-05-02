/**
 * Observability domain wire-up. Listens to dispatch + safety bus channels and
 * folds payloads into telemetry/cost trackers. Emits nothing; other domains
 * read the snapshot through the contract.
 */

import { BusChannels } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { ObservabilityContract } from "./contract.js";
import { createCostTracker } from "./cost.js";
import { aggregateMetrics } from "./metrics.js";
import { createTelemetry } from "./telemetry.js";

interface DispatchCostPayload {
	runId: string;
	exitCode: number;
	endpointId?: string;
	wireModelId?: string;
	tokenCount?: number;
	reasoningTokenCount?: number;
	costUsd?: number;
	durationMs?: number;
}

function recordDispatchCost(
	telemetry: ReturnType<typeof createTelemetry>,
	cost: ReturnType<typeof createCostTracker>,
	payload: DispatchCostPayload,
): void {
	if (!payload.endpointId || !payload.wireModelId || typeof payload.tokenCount !== "number") {
		return;
	}
	telemetry.record("counter", "tokens.total", payload.tokenCount);
	// Dispatch bus payloads carry a total token count plus optional reasoning
	// detail, so sessionTokens() leaves input/output at zero for dispatch runs.
	// Chat-loop runs pass the full Usage breakdown through recordTokens().
	cost.accumulate(payload.endpointId, payload.wireModelId, payload.tokenCount, payload.costUsd, {
		reasoningTokens: payload.reasoningTokenCount ?? 0,
		totalTokens: payload.tokenCount,
	});
}

export function createObservabilityBundle(context: DomainContext): DomainBundle<ObservabilityContract> {
	const telemetry = createTelemetry();
	const cost = createCostTracker();
	const unsubscribes: Array<() => void> = [];

	const extension: DomainExtension = {
		async start() {
			unsubscribes.push(
				context.bus.on(BusChannels.DispatchCompleted, (raw) => {
					const payload = (raw ?? {}) as DispatchCostPayload;
					telemetry.record("counter", "dispatch.completed", 1);
					if (typeof payload.durationMs === "number") {
						telemetry.record("histogram", "dispatch.duration_ms", payload.durationMs);
					}
					recordDispatchCost(telemetry, cost, payload);
				}),
			);
			unsubscribes.push(
				context.bus.on(BusChannels.DispatchFailed, (raw) => {
					const payload = (raw ?? {}) as DispatchCostPayload;
					telemetry.record("counter", "dispatch.failed", 1);
					if (typeof payload.durationMs === "number") {
						telemetry.record("histogram", "dispatch.duration_ms", payload.durationMs);
					}
					recordDispatchCost(telemetry, cost, payload);
				}),
			);
			unsubscribes.push(
				context.bus.on(BusChannels.SafetyClassified, () => {
					telemetry.record("counter", "safety.classified", 1);
				}),
			);
		},
		async stop() {
			for (const off of unsubscribes) off();
			unsubscribes.length = 0;
		},
	};

	const contract: ObservabilityContract = {
		telemetry: () => telemetry.snapshot(),
		metrics: () => aggregateMetrics(telemetry.snapshot()),
		sessionCost: () => cost.sessionTotal(),
		sessionTokens: () => cost.sessionTokens(),
		costEntries: () => cost.entries(),
		recordTokens(providerId, modelId, tokens, costUsd, breakdown) {
			telemetry.record("counter", "tokens.total", tokens);
			cost.accumulate(providerId, modelId, tokens, costUsd, breakdown);
		},
	};

	return { extension, contract };
}
