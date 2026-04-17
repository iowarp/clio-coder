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

interface DispatchCompletedPayload {
	runId: string;
	exitCode: number;
	providerId?: string;
	modelId?: string;
	tokenCount?: number;
	durationMs?: number;
}

export function createObservabilityBundle(context: DomainContext): DomainBundle<ObservabilityContract> {
	const telemetry = createTelemetry();
	const cost = createCostTracker();
	const unsubscribes: Array<() => void> = [];

	const extension: DomainExtension = {
		async start() {
			unsubscribes.push(
				context.bus.on(BusChannels.DispatchCompleted, (raw) => {
					const payload = (raw ?? {}) as DispatchCompletedPayload;
					telemetry.record("counter", "dispatch.completed", 1);
					if (typeof payload.durationMs === "number") {
						telemetry.record("histogram", "dispatch.duration_ms", payload.durationMs);
					}
					if (payload.providerId && payload.modelId && typeof payload.tokenCount === "number") {
						telemetry.record("counter", "tokens.total", payload.tokenCount);
						cost.accumulate(payload.providerId, payload.modelId, payload.tokenCount);
					}
				}),
			);
			unsubscribes.push(
				context.bus.on(BusChannels.DispatchFailed, () => {
					telemetry.record("counter", "dispatch.failed", 1);
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
		costEntries: () => cost.entries(),
		recordTokens(providerId, modelId, tokens) {
			telemetry.record("counter", "tokens.total", tokens);
			cost.accumulate(providerId, modelId, tokens);
		},
	};

	return { extension, contract };
}
