/**
 * Scheduling domain wire-up. Seeds budget + concurrency state from settings and
 * checks priced spend before paid model requests and dispatches. Interactive
 * callers wait for an operator ceiling increase; headless callers reject.
 */

import { type BudgetAlertPayload, BusChannels } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { ConfigContract } from "../config/contract.js";
import type { ObservabilityContract } from "../observability/contract.js";
import { createBudgetState, SessionCostCeilingError } from "./budget.js";
import { createFleetRegistry, LOCAL_NODE_ID } from "./cluster.js";
import type { SchedulingContract } from "./contract.js";
import {
	createLocalCapacitySampler,
	type LocalCapacitySamplerOptions,
	resolveGlobalConcurrency,
} from "./local-capacity.js";

export interface SchedulingBundleOptions {
	/** Host sampling seams for `fleet.concurrency: auto`; tests inject facts and a clock. */
	localCapacity?: Omit<LocalCapacitySamplerOptions, "activeLocalWorkers">;
}

export function createSchedulingBundle(
	context: DomainContext,
	options: SchedulingBundleOptions = {},
): DomainBundle<SchedulingContract> {
	const maybeConfig = context.getContract<ConfigContract>("config");
	if (!maybeConfig) throw new Error("scheduling domain requires 'config' contract");
	const config: ConfigContract = maybeConfig;
	const observability = context.getContract<ObservabilityContract>("observability");

	const settings = config.get();
	let budget = createBudgetState(settings.safety.limits.sessionCostUsd);
	const localCapacity = createLocalCapacitySampler({
		...options.localCapacity,
		activeLocalWorkers: () => fleet.activeWorkers(LOCAL_NODE_ID),
	});
	const fleet = createFleetRegistry(() => config.get().fleet?.nodes ?? [], {
		localCapacity: () => localCapacity.resolve(config.get().fleet.concurrency),
	});
	const unsubscribes: Array<() => void> = [];

	function syncBudget(): void {
		const nextCeiling = config.get().safety.limits.sessionCostUsd;
		if (nextCeiling === budget.ceilingUsd) return;
		budget = createBudgetState(nextCeiling);
	}

	function evaluate(): { verdict: ReturnType<typeof budget.checkCeiling>; currentUsd: number } {
		syncBudget();
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
						} satisfies BudgetAlertPayload);
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
		ceilingUsd: () => {
			syncBudget();
			return budget.ceilingUsd;
		},
		preflight: () => {
			const { verdict, currentUsd } = evaluate();
			return { verdict, currentUsd, ceilingUsd: budget.ceilingUsd };
		},
		admitPaidRequest: async ({ waitForRaise, additionalUsd = 0, getCeilingUsd, signal }) => {
			let alerted = false;
			for (;;) {
				const { currentUsd } = evaluate();
				const spend = currentUsd + additionalUsd;
				const ceilingUsd = getCeilingUsd?.() ?? budget.ceilingUsd;
				if (spend < ceilingUsd) return;
				if (!waitForRaise) throw new SessionCostCeilingError(spend, ceilingUsd);
				if (signal?.aborted) throw signal.reason ?? new Error("budget wait aborted");
				if (!alerted) {
					alerted = true;
					context.bus.emit(BusChannels.BudgetAlert, {
						level: spend > ceilingUsd ? "over" : "at",
						currentUsd: spend,
						ceilingUsd,
					} satisfies BudgetAlertPayload);
				}
				await new Promise<void>((resolve, reject) => {
					const onAbort = (): void => {
						clearTimeout(timer);
						reject(signal?.reason ?? new Error("budget wait aborted"));
					};
					const timer = setTimeout(() => {
						signal?.removeEventListener("abort", onAbort);
						resolve();
					}, 250);
					signal?.addEventListener("abort", onAbort, { once: true });
				});
			}
		},
		maxWorkers: () => resolveGlobalConcurrency(config.get().fleet.concurrency),
		localCapacity: () => localCapacity.resolve(config.get().fleet.concurrency),
		fleet,
	};

	return { extension, contract };
}
