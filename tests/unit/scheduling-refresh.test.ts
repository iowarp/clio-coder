import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { ConfigContract } from "../../src/domains/config/contract.js";
import type { ObservabilityContract } from "../../src/domains/observability/contract.js";
import { createSchedulingBundle } from "../../src/domains/scheduling/extension.js";

function stubObservability(sessionCost: () => number): ObservabilityContract {
	return {
		telemetry: () => ({ counters: {}, histograms: {} }),
		metrics: () => ({
			dispatchesCompleted: 0,
			dispatchesFailed: 0,
			safetyClassifications: 0,
			totalTokens: 0,
			histograms: {},
		}),
		sessionCost,
		sessionTokens: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, totalTokens: 0 }),
		costEntries: () => [],
		recordTokens: () => {},
	};
}

function stubContext(
	config: ConfigContract,
	observability: ObservabilityContract,
): DomainContext & { bus: ReturnType<typeof createSafeEventBus> } {
	const bus = createSafeEventBus();
	const getContract = ((name: string) => {
		if (name === "config") return config;
		if (name === "observability") return observability;
		return undefined;
	}) as DomainContext["getContract"];
	return {
		bus,
		getContract,
	};
}

describe("scheduling ceiling refresh", () => {
	it("preflight reflects the latest budget.sessionCeilingUsd from config", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.budget.sessionCeilingUsd = 5;
		const currentUsd = 4;
		const config: ConfigContract = {
			get: () => settings,
			onChange: () => () => {},
		};
		const context = stubContext(
			config,
			stubObservability(() => currentUsd),
		);
		const bundle = createSchedulingBundle(context);
		await bundle.extension.start();

		try {
			strictEqual(bundle.contract.ceilingUsd(), 5);
			deepStrictEqual(bundle.contract.preflight(), {
				verdict: "under",
				currentUsd: 4,
				ceilingUsd: 5,
			});

			settings.budget.sessionCeilingUsd = 1;

			strictEqual(bundle.contract.ceilingUsd(), 1);
			deepStrictEqual(bundle.contract.preflight(), {
				verdict: "over",
				currentUsd: 4,
				ceilingUsd: 1,
			});
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("dispatch budget alerts use the refreshed ceiling after config changes", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.budget.sessionCeilingUsd = 5;
		const config: ConfigContract = {
			get: () => settings,
			onChange: () => () => {},
		};
		const context = stubContext(
			config,
			stubObservability(() => 4),
		);
		const alerts: unknown[] = [];
		context.bus.on(BusChannels.BudgetAlert, (payload) => {
			alerts.push(payload);
		});
		const bundle = createSchedulingBundle(context);
		await bundle.extension.start();

		try {
			context.bus.emit(BusChannels.DispatchEnqueued, {});
			strictEqual(alerts.length, 0);

			settings.budget.sessionCeilingUsd = 1;
			context.bus.emit(BusChannels.DispatchEnqueued, {});

			strictEqual(alerts.length, 1);
			deepStrictEqual(alerts[0], {
				level: "over",
				currentUsd: 4,
				ceilingUsd: 1,
			});
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
