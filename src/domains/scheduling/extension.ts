/**
 * Scheduling domain wire-up. Seeds budget + concurrency state from settings and
 * checks priced spend before paid model requests and dispatches. Interactive
 * callers wait for an operator ceiling increase; headless callers reject.
 */

import { performance } from "node:perf_hooks";
import type { ClioSettings } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { EventPayload } from "../../core/telemetry/events.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import type { BudgetAlertPayload, ConfigChangePayload, ConfigChangeSource } from "../../core/telemetry/live-events.js";
import type { ConfigContract } from "../config/contract.js";
import type { SessionSpend, TelemetryContract } from "../telemetry/contract.js";
import {
	type BudgetSpendPricing,
	combineBudgetPricing,
	createBudgetState,
	type RunCostCap,
	SessionCostCeilingError,
	sessionCeilingReached,
} from "./budget.js";
import { createFleetRegistry, LOCAL_NODE_ID } from "./cluster.js";
import type { SchedulingContract } from "./contract.js";
import {
	createLocalCapacitySampler,
	type LocalCapacitySamplerOptions,
	resolveGlobalConcurrency,
} from "./local-capacity.js";

/** Priced spend so far and how it was priced (#434 §6.3). */
interface Spend {
	usd: number;
	pricing: BudgetSpendPricing;
}

const NOTHING_SPENT: SessionSpend = { usd: 0, estimated: false, unpriced: false, ref: null };

export interface SchedulingBundleOptions {
	/** Host sampling seams for `fleet.concurrency: auto`; tests inject facts and a clock. */
	localCapacity?: Omit<LocalCapacitySamplerOptions, "activeLocalWorkers">;
	/**
	 * The session's effective settings view. Session overrides such as the
	 * ceiling `clio-coder run --max-cost-usd` sets live there, not in the
	 * config snapshot, so the plan baseline and budget alerts read it.
	 */
	getSettings?: () => Readonly<ClioSettings> | undefined;
}

export function createSchedulingBundle(
	context: DomainContext,
	options: SchedulingBundleOptions = {},
): DomainBundle<SchedulingContract> {
	const maybeConfig = context.getContract<ConfigContract>("config");
	if (!maybeConfig) throw new Error("scheduling domain requires 'config' contract");
	const config: ConfigContract = maybeConfig;
	const telemetry = context.getContract<TelemetryContract>("telemetry");

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

	let runCap: RunCostCap | null = null;
	// The latest settings change to the session ceiling, so a hold it releases can say who raised it (#424).
	let ceilingChange: { ceilingUsd: number; source: ConfigChangeSource; at: number } | undefined;
	// Sessions and ceilings whose crossing is journaled; a crossing is one per ceiling value, not one per held call.
	const crossings = new Set<string>();

	function syncBudget(): void {
		const nextCeiling = (options.getSettings?.() ?? config.get()).safety.limits.sessionCostUsd;
		if (nextCeiling === budget.ceilingUsd) return;
		budget = createBudgetState(nextCeiling);
	}

	const spendOf = (spend: SessionSpend): Spend => ({
		usd: spend.usd,
		pricing: { estimated: spend.estimated, unpriced: spend.unpriced },
	});
	/** The session's priced spend so far and how it was priced, from the read model's live session fold (#434). */
	function spendNow(): Spend {
		return spendOf(telemetry?.sessionSpend() ?? NOTHING_SPENT);
	}
	/** Admission's read: every queued settlement written and the live fold seeded first, so the gate never lags. */
	async function settledSpend(): Promise<Spend> {
		return spendOf((await telemetry?.settledSessionSpend()) ?? NOTHING_SPENT);
	}

	function evaluate(): { verdict: ReturnType<typeof budget.checkCeiling>; spend: Spend } {
		syncBudget();
		const spend = spendNow();
		return { verdict: budget.checkCeiling(spend.usd), spend };
	}

	const extension: DomainExtension = {
		async start() {
			const noteCeilingChange = ({ diff, settings, source }: ConfigChangePayload): void => {
				if (!diff.hotReload.includes("safety.limits.sessionCostUsd")) return;
				ceilingChange = {
					ceilingUsd: settings.safety.limits.sessionCostUsd,
					source,
					at: performance.now(),
				};
			};
			// A raise saved to settings, or one made for this session alone, can release a hold (#424, #434).
			unsubscribes.push(
				config.onChange("hotReload", noteCeilingChange),
				context.bus.subscribe("config.session_changed", noteCeilingChange),
			);
			unsubscribes.push(
				context.bus.subscribe("run.enqueued", () => {
					syncBudget();
					if (budget.ceilingUsd <= 0) return;
					const { verdict, spend } = evaluate();
					if (verdict !== "under") {
						context.bus.emit("budget.alerted", {
							level: verdict,
							currentUsd: spend.usd,
							ceilingUsd: budget.ceilingUsd,
							pricing: spend.pricing,
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
			const { verdict, spend } = evaluate();
			return { verdict, currentUsd: spend.usd, ceilingUsd: budget.ceilingUsd, pricing: spend.pricing };
		},
		admitPaidRequest: async ({
			waitForRaise,
			additionalUsd = 0,
			additionalPricing,
			getCeilingUsd,
			contextTokens,
			onBlocked,
			telemetry,
			signal,
		}) => {
			let held: { block: BudgetAlertPayload; since: number } | undefined;
			// The hold is journaled once, when it ends, for the call it held (#424).
			const recordHold = (outcome: EventPayload<"budget.held">["outcome"], ceilingUsd?: number): void => {
				if (!telemetry || !held) return;
				const { block, since } = held;
				const raised = outcome === "raised" && ceilingUsd !== undefined;
				const by = raised && ceilingChange?.ceilingUsd === ceilingUsd && ceilingChange.at >= since ? ceilingChange : null;
				telemetryHub().emit(
					"budget.held",
					{
						level: block.level,
						spendUsd: block.currentUsd,
						...(block.projectedUsd !== undefined ? { projectedUsd: block.projectedUsd } : {}),
						ceilingUsd: block.ceilingUsd,
						...(block.contextTokens !== undefined ? { contextTokens: block.contextTokens } : {}),
						outcome,
						waitedMs: Math.max(0, performance.now() - since),
						// A raise no settings change accounts for keeps no raisedBy rather than a placeholder source (#434, C3).
						...(raised ? { raisedToUsd: ceilingUsd, ...(by ? { raisedBy: by.source } : {}) } : {}),
					},
					telemetry,
				);
			};
			for (;;) {
				syncBudget();
				const ceilingUsd = getCeilingUsd?.() ?? budget.ceilingUsd;
				// No ceiling compares nothing, so an uncapped session's calls pay for no flush and no seed.
				const spent = ceilingUsd > 0 ? await settledSpend() : null;
				const spend = (spent?.usd ?? 0) + additionalUsd;
				if (!sessionCeilingReached(spend, ceilingUsd)) {
					if (held)
						recordHold(ceilingUsd <= 0 ? "removed" : ceilingUsd > held.block.ceilingUsd ? "raised" : "cleared", ceilingUsd);
					return;
				}
				if (signal?.aborted) {
					recordHold("aborted");
					throw signal.reason ?? new Error("budget wait aborted");
				}
				if (!held) {
					const pricing = combineBudgetPricing(spent?.pricing, additionalUsd > 0 ? additionalPricing : undefined);
					const block: BudgetAlertPayload = {
						level: spend > ceilingUsd ? "over" : "at",
						currentUsd: spent?.usd ?? 0,
						...(additionalUsd > 0 ? { projectedUsd: additionalUsd } : {}),
						ceilingUsd,
						...(contextTokens !== undefined ? { contextTokens } : {}),
						...(pricing ? { pricing } : {}),
					};
					held = { block, since: performance.now() };
					onBlocked?.(block);
					context.bus.emit("budget.alerted", block);
					const crossing = JSON.stringify([telemetry?.sessionId, ceilingUsd]);
					if (telemetry && !crossings.has(crossing)) {
						const { currentUsd: spendUsd, pricing: _pricing, ...rest } = block;
						if (telemetryHub().emit("budget.crossed", { ...rest, spendUsd }, telemetry)) crossings.add(crossing);
					}
				}
				if (!waitForRaise) {
					recordHold("refused");
					throw new SessionCostCeilingError(spend, ceilingUsd, runCap ?? undefined, contextTokens, held.block.pricing);
				}
				try {
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
				} catch (error) {
					recordHold("aborted");
					throw error;
				}
			}
		},
		setRunCostCap: (cap) => {
			runCap = cap;
		},
		runCostCap: () => runCap,
		maxWorkers: () => resolveGlobalConcurrency(config.get().fleet.concurrency),
		localCapacity: () => localCapacity.resolve(config.get().fleet.concurrency),
		fleet,
	};

	return { extension, contract };
}
