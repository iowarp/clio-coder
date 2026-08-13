/**
 * Three surfaces, one session, three different claims about what it had spent.
 *
 * Before any turn the footer read `out default · $0.00` while `/cost` on the
 * same session read `no token usage recorded for this session`. After one real
 * turn `/cost` read `cost unknown` and the footer had dropped its money field
 * entirely, at the exact moment the field acquired a value.
 *
 * One rule covers all of it: never print a number nothing measured. Before any
 * usage there is no cost field on either surface; once there is usage both say
 * the same words, whether that is an amount or `cost unknown`.
 */
import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	aggregateCostAmounts,
	costAggregateForAmount,
	costWasMeasured,
	emptyCostAggregate,
	formatCostAggregate,
	type UsageBreakdown,
} from "../../src/domains/observability/index.js";
import { formatCostOverlayBodyLines } from "../../src/interactive/cost-overlay.js";
import { buildMetricStrip } from "../../src/interactive/footer/widgets.js";
import type { AgentStatus, TurnSummary } from "../../src/interactive/status/index.js";
import { clioTheme } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);
const strip = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
const theme = clioTheme();

const IDLE: AgentStatus = {
	phase: "idle",
	since: 0,
	lastMeaningfulAt: 0,
	watchdogTier: 0,
	watchdogPeak: 0,
	localRuntime: false,
};

const LAST_TURN: TurnSummary = {
	elapsedMs: 13_000,
	modelId: "Nemo-3.5-Lightning",
	targetId: "dynamo",
	inputTokens: 14_073,
	outputTokens: 198,
	cacheReadTokens: 10_404,
	cacheWriteTokens: 0,
	reasoningTokens: 0,
	toolCount: 1,
	toolErrorCount: 0,
	stopReason: "stop",
	watchdogPeak: 0,
	truncated: false,
};

const SESSION_TOKENS: UsageBreakdown = {
	input: 14_073,
	output: 198,
	totalTokens: 24_675,
	cacheRead: 10_404,
	cacheWrite: 0,
	reasoningTokens: 0,
};

/** The footer's compact strip, as an 80-column terminal renders it. */
function footerStrip(cost: Parameters<typeof buildMetricStrip>[5], turn: TurnSummary | null): string {
	return strip(buildMetricStrip(theme, IDLE, null, turn, SESSION_TOKENS, cost, undefined, 80, 6));
}

/** The `/cost` overlay body, as the modal renders it. */
function overlayBody(cost: Parameters<typeof formatCostOverlayBodyLines>[0], rows: number): string {
	const entries = Array.from({ length: rows }, () => ({
		providerId: "dynamo",
		modelId: "Nemo-3.5-Lightning",
		runs: 1,
		tokens: 24_675,
		input: 14_073,
		output: 198,
		cacheRead: 10_404,
		cacheWrite: 0,
		reasoningTokens: 0,
		apiCalls: 2,
		cost,
	}));
	return strip(formatCostOverlayBodyLines(cost, 24_675, entries, 80).join("\n"));
}

describe("contracts/cost truth across the footer and /cost", () => {
	it("separates nothing measured from a measured zero", () => {
		strictEqual(costWasMeasured(emptyCostAggregate()), false);
		strictEqual(formatCostAggregate(emptyCostAggregate()), null, "an unpriced session has no cost text at all");

		// A call that was genuinely free is a measurement, and it reads as one.
		const free = aggregateCostAmounts([{ usd: 0, provenance: "known_free" }]);
		strictEqual(costWasMeasured(free), true);
		strictEqual(formatCostAggregate(free), "$0.00 local");
	});

	it("shows no cost field on either surface before the first priced call", () => {
		const footer = footerStrip(emptyCostAggregate(), null);
		ok(!footer.includes("$"), `the footer must not invent a number: "${footer}"`);
		ok(!footer.includes("cost"), `nor a cost label with nothing behind it: "${footer}"`);

		const overlay = overlayBody(emptyCostAggregate(), 0);
		ok(!/^cost\b/mu.test(overlay), `the overlay drops its cost row too: "${overlay}"`);
		ok(!overlay.includes("$0.00"), `and prints no zero: "${overlay}"`);
		ok(overlay.includes("no token usage recorded for this session"), `it already says this: "${overlay}"`);
	});

	it("says cost unknown in the same words on both surfaces once usage exists", () => {
		const unknown = costAggregateForAmount(0, "unknown");

		const footer = footerStrip(unknown, LAST_TURN);
		ok(footer.includes("cost unknown"), `the footer says it, and keeps saying it at 80 columns: "${footer}"`);

		const overlay = overlayBody(unknown, 1);
		ok(overlay.includes("cost unknown"), `the overlay says the same thing: "${overlay}"`);
	});

	it("shows the number on both surfaces when it is known", () => {
		const known = costAggregateForAmount(0.42, "known");
		ok(footerStrip(known, LAST_TURN).includes("$0.42"));
		ok(overlayBody(known, 1).includes("$0.42"));
	});
});
