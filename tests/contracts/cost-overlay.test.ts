import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { type CostRow, formatCostOverlayBodyLines } from "../../src/interactive/cost-overlay.js";
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
		usd: 1.5,
		...overrides,
	};
}

describe("cost overlay", () => {
	it("renders the summary as key-value rows in the design-system grammar", () => {
		const lines = formatCostOverlayBodyLines(1.5, 8_000, [row()], 80);
		const body = strip(lines.join("\n"));
		for (const key of [
			"turns",
			"requests",
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
		const lines = formatCostOverlayBodyLines(1.5, 8_000, [row()], 80);
		const expectedHeading = theme.style("accent", "openai · gpt-5", { bold: true });
		ok(lines.includes(expectedHeading), "the per-model heading is a bold accent provider · model line");
	});

	it("draws the summary/detail divider in the frame token", () => {
		const lines = formatCostOverlayBodyLines(1.5, 8_000, [row()], 80);
		const dividerLine = lines.find((line) => strip(line).includes("─"));
		ok(dividerLine, "a horizontal divider separates the summary from the per-model blocks");
		ok(dividerLine?.includes(theme.fgSequence("frame")), "the divider carries the frame token");
	});

	it("routes money through the shared cents formatter, never four decimals at or above a cent", () => {
		const body = strip(formatCostOverlayBodyLines(0.42, 8_000, [row({ usd: 0.42 })], 80).join("\n"));
		ok(body.includes("$0.42"), `cost should read cents, got: ${body}`);
		ok(!body.includes("$0.4200"), "the four-decimal form must be impossible at or above a cent");
	});

	it("widens sub-cent costs to four decimals rather than rounding to a misleading $0.00", () => {
		const body = strip(formatCostOverlayBodyLines(0.004, 8_000, [row({ usd: 0.004 })], 80).join("\n"));
		ok(body.includes("$0.0040"), `a sub-cent cost should read four decimals, got: ${body}`);
		ok(!/cost\s+\$0\.00\b/.test(body), "a sub-cent cost must not round down to $0.00");
	});

	it("marks a zero-cost model block as local", () => {
		const body = strip(formatCostOverlayBodyLines(0, 5_000, [row({ usd: 0 })], 80).join("\n"));
		ok(body.includes("$0.00 local"), `a zero-cost row reads as local, got: ${body}`);
	});

	it("styles the empty state instead of leaving it bare", () => {
		const lines = formatCostOverlayBodyLines(0, 0, [], 80);
		const emptyLine = lines.find((line) => strip(line).includes("no token usage recorded"));
		ok(emptyLine?.includes(ESC), "the empty-state line carries a token");
	});

	it("leaves no completely unstyled line in the overlay body", () => {
		const lines = formatCostOverlayBodyLines(
			1.5,
			8_000,
			[row(), row({ providerId: "anthropic", modelId: "claude-sonnet-5", usd: 0 })],
			80,
		);
		for (const line of lines) {
			if (strip(line).trim().length === 0) continue;
			ok(line.includes(ESC), `every content line carries at least one token, bare line: ${JSON.stringify(line)}`);
		}
	});
});
