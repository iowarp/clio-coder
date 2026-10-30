import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import type { BudgetAlertPayload, ConfigChangePayload } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { PendingTelemetry } from "../../src/core/telemetry/producer.js";
import { registerTelemetrySink } from "../../src/core/telemetry/producer.js";
import { validPayload } from "../../src/core/telemetry/schemas.js";
import type { ConfigContract } from "../../src/domains/config/index.js";
import {
	type BudgetBlockView,
	type BudgetSpendPricing,
	budgetBlockSpendText,
	describeBudgetBlock,
	readBudgetBlock,
} from "../../src/domains/scheduling/budget.js";
import { createSchedulingBundle } from "../../src/domains/scheduling/extension.js";

it("a held paid request journals one crossing per ceiling and its hold, with the raise that released it (#424)", async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.safety.limits.sessionCostUsd = 1;
	const listeners: Array<(payload: ConfigChangePayload) => void> = [];
	const config = {
		get: () => settings,
		onChange: (_kind: string, listener: (payload: ConfigChangePayload) => void) => {
			listeners.push(listener);
			return () => {};
		},
	} as unknown as ConfigContract;
	const observability = { sessionCost: () => 1.25 };
	const { contract, extension } = createSchedulingBundle({
		bus: createSafeEventBus(),
		getContract: (<T>(name: string) =>
			(name === "config" ? config : name === "observability" ? observability : undefined) as T | undefined) as never,
	});
	const records: PendingTelemetry[] = [];
	const release = registerTelemetrySink("budget-session", { enqueue: (record) => Boolean(records.push(record)) });
	const telemetry = { sessionId: "budget-session", label: "main" as const, callId: "cal_held", attemptId: "att_held" };
	try {
		await extension.start?.();
		const held = contract.admitPaidRequest?.({ waitForRaise: true, contextTokens: 900, telemetry });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const previous = structuredClone(settings);
		settings.safety.limits.sessionCostUsd = 5;
		const change = {
			diff: { hotReload: ["safety.limits.sessionCostUsd"], nextTurn: [], restartRequired: [] },
			settings,
			previous,
			source: "settings-ui",
		} satisfies ConfigChangePayload;
		for (const listener of listeners) listener(change);
		await held;
		settings.safety.limits.sessionCostUsd = 1;
		await contract.admitPaidRequest?.({ waitForRaise: false, telemetry }).catch(() => undefined);
		const crossings = records.filter((record) => record.kind === "budget.crossing");
		const holds = records.flatMap((record) => (record.kind === "budget.wait" ? [record.data] : []));
		strictEqual(crossings.length, 1, "a crossing is journaled once per ceiling");
		deepStrictEqual(crossings[0]?.data, { level: "over", spendUsd: 1.25, ceilingUsd: 1, contextTokens: 900 });
		strictEqual(crossings[0]?.ctx.callId, "cal_held");
		strictEqual(holds.length, 2);
		const [raised, refused] = holds;
		strictEqual(raised?.outcome, "raised");
		strictEqual(raised?.raisedToUsd, 5);
		strictEqual(raised?.raisedBy, "settings-ui");
		ok((raised?.waitedMs ?? 0) > 0);
		strictEqual(refused?.outcome, "refused");
		ok(records.every((record) => validPayload(record.kind, record.data)));
	} finally {
		release();
		await extension.stop?.();
	}
});

it("a ceiling stop names estimated or partly unpriced spend as it was priced, and an older stop as before (#434 §6.3)", async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.safety.limits.sessionCostUsd = 1;
	const config = { get: () => settings, onChange: () => () => {} } as unknown as ConfigContract;
	const summary = { knownUsd: 1.25, hasEstimated: true, hasUnknown: false, allKnownFree: false, calls: 3 };
	const observability = { sessionCost: () => summary.knownUsd, sessionCostSummary: () => ({ ...summary }) };
	const { contract, extension } = createSchedulingBundle({
		bus: createSafeEventBus(),
		getContract: (<T>(name: string) =>
			(name === "config" ? config : name === "observability" ? observability : undefined) as T | undefined) as never,
	});
	const records: PendingTelemetry[] = [];
	const release = registerTelemetrySink("priced-session", { enqueue: (record) => Boolean(records.push(record)) });
	const telemetry = {
		sessionId: "priced-session",
		label: "main" as const,
		callId: "cal_priced",
		attemptId: "att_priced",
	};
	try {
		await extension.start?.();
		const blocks: BudgetAlertPayload[] = [];
		const stop = (options: { additionalUsd?: number; additionalPricing?: BudgetSpendPricing } = {}) =>
			contract
				.admitPaidRequest?.({ waitForRaise: false, onBlocked: (block) => blocks.push(block), telemetry, ...options })
				.then(
					() => "admitted",
					(error: Error) => error.message,
				);
		ok((await stop())?.includes("session priced spend ~$1.25 est reached the $1.00 ceiling"));
		ok(
			describeBudgetBlock(readBudgetBlock(blocks[0]) as BudgetBlockView).text.startsWith(
				"[budget] Session priced spend ~$1.25 est of $1.00 ceiling exceeded.",
			),
		);
		summary.hasEstimated = false;
		await stop({ additionalUsd: 0.5, additionalPricing: { estimated: false, unpriced: true } });
		deepStrictEqual(blocks[1]?.pricing, { estimated: false, unpriced: true });
		strictEqual(budgetBlockSpendText(readBudgetBlock(blocks[1]) as BudgetBlockView), "$1.75 +? of $1.00 ceiling");
		// A stop recorded before stops carried their pricing still reads as it did.
		const { pricing: _, ...legacy } = blocks[1] as BudgetAlertPayload;
		strictEqual(budgetBlockSpendText(readBudgetBlock(legacy) as BudgetBlockView), "$1.75 of $1.00 ceiling");
		ok(records.every((record) => validPayload(record.kind, record.data)));
	} finally {
		release();
		await extension.stop?.();
	}
});
