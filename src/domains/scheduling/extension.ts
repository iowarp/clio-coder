/**
 * Scheduling domain wire-up. Seeds budget + concurrency state from settings and
 * listens to dispatch.enqueued so it can fire informational budget.alert events
 * when an enqueue would cross the ceiling. v0.1 does not reject enqueues; the
 * alert is the hook the TUI renders.
 */

import { BusChannels } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { ConfigContract } from "../config/contract.js";
import type { ObservabilityContract } from "../observability/contract.js";
import { createBudgetState } from "./budget.js";
import { listNodes } from "./cluster.js";
import { createConcurrencyGate } from "./concurrency.js";
import type { SchedulingContract } from "./contract.js";

const DEFAULT_MAX_WORKERS = 4;

function resolveMaxWorkers(concurrency: "auto" | number): number {
	if (concurrency === "auto") return DEFAULT_MAX_WORKERS;
	return Math.max(1, concurrency);
}

export function createSchedulingBundle(context: DomainContext): DomainBundle<SchedulingContract> {
	const maybeConfig = context.getContract<ConfigContract>("config");
	if (!maybeConfig) throw new Error("scheduling domain requires 'config' contract");
	const config: ConfigContract = maybeConfig;
	const observability = context.getContract<ObservabilityContract>("observability");

	const settings = config.get();
	const budget = createBudgetState(settings.budget.sessionCeilingUsd);
	const gate = createConcurrencyGate(resolveMaxWorkers(settings.budget.concurrency));
	const unsubscribes: Array<() => void> = [];

	function evaluate(): { verdict: ReturnType<typeof budget.checkCeiling>; currentUsd: number } {
		const currentUsd = observability?.sessionCost() ?? 0;
		return { verdict: budget.checkCeiling(currentUsd), currentUsd };
	}

	const extension: DomainExtension = {
		async start() {
			unsubscribes.push(
				context.bus.on(BusChannels.DispatchEnqueued, () => {
					const { verdict, currentUsd } = evaluate();
					if (verdict !== "under") {
						context.bus.emit(BusChannels.BudgetAlert, {
							level: verdict,
							currentUsd,
							ceilingUsd: budget.ceilingUsd,
						});
					}
				}),
			);
		},
		async stop() {
			for (const off of unsubscribes) off();
			unsubscribes.length = 0;
		},
	};

	const contract: SchedulingContract = {
		ceilingUsd: () => budget.ceilingUsd,
		checkCeiling: (current) => budget.checkCeiling(current),
		raiseCeiling: (next) => budget.raise(next),
		preflight: () => {
			const { verdict, currentUsd } = evaluate();
			return { verdict, currentUsd, ceilingUsd: budget.ceilingUsd };
		},
		activeWorkers: () => gate.activeWorkers(),
		tryAcquireWorker: () => gate.tryAcquire(),
		releaseWorker: () => gate.release(),
		listNodes: () => listNodes(),
	};

	return { extension, contract };
}
