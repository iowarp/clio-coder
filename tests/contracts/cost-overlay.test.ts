import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { costAggregateForAmount } from "../../src/domains/observability/index.js";
import { aggregateCostEntries, type CostRow, formatCostOverlayBodyLines } from "../../src/interactive/cost-overlay.js";
import { clioTheme } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);
const strip = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
const theme = clioTheme();

function row(overrides: Partial<CostRow> = {}): CostRow {
	return {
		providerId: "openai",
		modelId: "gpt-5",
		runs: 3,
		tokens: 5_000,
		input: 3_000,
		output: 1_500,
		cacheRead: 400,
		cacheWrite: 100,
		reasoningTokens: 200,
		apiCalls: 4,
		cost: costAggregateForAmount(1.5, "known"),
		...overrides,
	};
}

describe("cost overlay", () => {
	it("renders the summary as key-value rows in the design-system grammar", () => {
		const lines = formatCostOverlayBodyLines(costAggregateForAmount(1.5, "known"), 8_000, [row()], 80);
		const body = strip(lines.join("\n"));
		for (const key of [
			"turns",
			"model calls",
			"cost",
			"input",
			"output",
			"reasoning",
			"cache read",
			"cache write",
			"processed",
		]) {
			ok(body.includes(key), `summary should carry the "${key}" key, got: ${body}`);
		}
		ok(/cost\s+\$1\.50/.test(body), `summary cost should read as money, got: ${body}`);
		ok(/processed\s+8,000 tokens/.test(body), `processed total should read grouped tokens, got: ${body}`);
	});

	it("renders the provider · model heading in bold accent", () => {
		const lines = formatCostOverlayBodyLines(costAggregateForAmount(1.5, "known"), 8_000, [row()], 80);
		const expectedHeading = theme.style("accent", "openai · gpt-5", { bold: true });
		ok(lines.includes(expectedHeading), "the per-model heading is a bold accent provider · model line");
	});

	it("draws the summary/detail divider in the frame token", () => {
		const lines = formatCostOverlayBodyLines(costAggregateForAmount(1.5, "known"), 8_000, [row()], 80);
		const dividerLine = lines.find((line) => strip(line).includes("─"));
		ok(dividerLine, "a horizontal divider separates the summary from the per-model blocks");
		ok(dividerLine?.includes(theme.fgSequence("frame")), "the divider carries the frame token");
	});

	it("routes money through the shared cents formatter, never four decimals at or above a cent", () => {
		const cost = costAggregateForAmount(0.42, "known");
		const body = strip(formatCostOverlayBodyLines(cost, 8_000, [row({ cost })], 80).join("\n"));
		ok(body.includes("$0.42"), `cost should read cents, got: ${body}`);
		ok(!body.includes("$0.4200"), "the four-decimal form must be impossible at or above a cent");
	});

	it("widens sub-cent costs to four decimals rather than rounding to a misleading $0.00", () => {
		const cost = costAggregateForAmount(0.004, "known");
		const body = strip(formatCostOverlayBodyLines(cost, 8_000, [row({ cost })], 80).join("\n"));
		ok(body.includes("$0.0040"), `a sub-cent cost should read four decimals, got: ${body}`);
		ok(!/cost\s+\$0\.00\b/.test(body), "a sub-cent cost must not round down to $0.00");
	});

	it("marks a zero-cost model block as local", () => {
		const cost = costAggregateForAmount(0, "known_free");
		const body = strip(formatCostOverlayBodyLines(cost, 5_000, [row({ cost })], 80).join("\n"));
		ok(body.includes("$0.00 local"), `a zero-cost row reads as local, got: ${body}`);
	});

	it("renders estimated, mixed, and unknown costs without calling them local", () => {
		const estimated = costAggregateForAmount(0.42, "estimated");
		const unknown = costAggregateForAmount(0, "unknown");
		const mixed = { ...estimated, hasUnknown: true };
		const body = strip(
			formatCostOverlayBodyLines(
				mixed,
				8_000,
				[row({ cost: estimated }), row({ modelId: "unknown", cost: unknown })],
				80,
			).join("\n"),
		);
		ok(body.includes("~$0.42 est"), body);
		ok(body.includes("$0.42 +?"), body);
		ok(body.includes("cost unknown"), body);
		ok(!body.includes("$0.00 local"), body);
	});

	it("preserves provenance while grouping repeated provider-model entries", () => {
		const base = {
			providerId: "openai",
			modelId: "gpt-5",
			tokens: 10,
			input: 6,
			output: 4,
			cacheRead: 0,
			cacheWrite: 0,
			reasoningTokens: 0,
		};
		const rows = aggregateCostEntries([
			{ ...base, usd: 0.42, provenance: "known" },
			{ ...base, usd: 0, provenance: "unknown" },
		]);
		strictEqual(rows.length, 1);
		strictEqual(rows[0]?.runs, 2);
		strictEqual(rows[0]?.cost.knownUsd, 0.42);
		strictEqual(rows[0]?.cost.hasUnknown, true);
	});

	it("aligns primary values in a tight column and hangs the cache-read annotation dim after the number", () => {
		const lines = formatCostOverlayBodyLines(
			costAggregateForAmount(1.5, "known"),
			8_000,
			[row({ cacheRead: 20_000, apiCalls: 7 })],
			80,
		);
		const body = lines.map(strip);
		const endOf = (label: string, value: string): number => {
			const line = body.find((candidate) => candidate.startsWith(label)) ?? "";
			ok(line.includes(value), `the "${label}" row should carry "${value}", got: ${line}`);
			return line.indexOf(value) + value.length;
		};
		const cacheReadEnd = endOf("cache read", "20,000");
		strictEqual(endOf("cost", "$1.50"), cacheReadEnd, "the aligned column is computed over primary values only");
		strictEqual(endOf("turns", "3"), cacheReadEnd, "every primary value shares the tight column");
		const costLine = body.find((candidate) => candidate.startsWith("cost")) ?? "";
		strictEqual(costLine.length, cacheReadEnd, "no row is dragged right to make room for the annotation");
		const cacheReadLine = lines.find((line) => strip(line).includes("avg/call")) ?? "";
		ok(
			cacheReadLine.includes(theme.fg("dim", "(avg/call 2,857)")),
			`the annotation reads dim after the number, got: ${cacheReadLine}`,
		);
	});

	it("styles the empty state instead of leaving it bare", () => {
		const lines = formatCostOverlayBodyLines(costAggregateForAmount(0, "unknown"), 0, [], 80);
		const emptyLine = lines.find((line) => strip(line).includes("no token usage recorded"));
		ok(emptyLine?.includes(ESC), "the empty-state line carries a token");
	});

	it("leaves no completely unstyled line in the overlay body", () => {
		const lines = formatCostOverlayBodyLines(
			costAggregateForAmount(1.5, "known"),
			8_000,
			[row(), row({ providerId: "anthropic", modelId: "claude-sonnet-5", cost: costAggregateForAmount(0, "known_free") })],
			80,
		);
		for (const line of lines) {
			if (strip(line).trim().length === 0) continue;
			ok(line.includes(ESC), `every content line carries at least one token, bare line: ${JSON.stringify(line)}`);
		}
	});
});
