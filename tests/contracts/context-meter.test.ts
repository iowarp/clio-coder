import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { buildContextLedger } from "../../src/domains/session/context-ledger.js";
import { visibleWidth } from "../../src/engine/tui.js";
import {
	CONTEXT_CATEGORY_TOKEN,
	contextCategoryGlyph,
	contextCategorySwatch,
	renderContextMeterBar,
	renderContextMeterGrid,
} from "../../src/interactive/context-meter.js";
import { expandedWideColumnWidths } from "../../src/interactive/footer/dashboard.js";
import { type ContextEngineFacts, contextQuadrant } from "../../src/interactive/footer/widgets.js";
import { clioTheme, formatContextPercent } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);
const strip = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

/** A ledger whose meter carries content, a real autocompact reserve, and free space. */
function ledgerWithReserve() {
	return buildContextLedger({
		provider: "mock",
		model: "model-a",
		contextWindow: 1000,
		messageTokens: 850,
		pendingTokens: 1,
		streamingTokens: 1,
		compactionAuto: true,
		compactionThreshold: 0.9,
	});
}

describe("context meter reserve glyph", () => {
	const theme = clioTheme();

	it("assigns filled, reserve, and free three distinct glyphs", () => {
		const filled = contextCategoryGlyph("messages");
		const reserve = contextCategoryGlyph("reserve");
		const free = contextCategoryGlyph("free");
		ok(filled !== reserve, "reserve must not reuse the filled glyph");
		ok(free !== reserve, "reserve must not reuse the free glyph");
		strictEqual(reserve, "▒");
	});

	it("renders reserve cells after free at the far end of the bar", () => {
		const ledger = ledgerWithReserve();
		ok(ledger.reserveTokens > 0, "fixture must produce a reserve");
		strictEqual(ledger.meter.map((group) => group.category).join(","), "messages,pending,streaming,free,reserve");
		const bar = strip(renderContextMeterBar(ledger, 20, theme));
		ok(/^▰+▱+▒+$/.test(bar), `bar should read filled, then free, then reserve, got "${bar}"`);
	});

	it("borrows overlay cells from free space while keeping reserve last", () => {
		const ledger = buildContextLedger({
			provider: "mock",
			model: "model-a",
			contextWindow: 1000,
			messageTokens: 500,
			pendingTokens: 1,
			streamingTokens: 1,
			compactionAuto: true,
			compactionThreshold: 0.9,
		});
		const grid = renderContextMeterGrid(ledger, 10, 1, theme).map(strip).join("");
		strictEqual(grid, "▰▰▰▰▰▰▰▱▱▒");
	});

	it("keeps legend swatches aligned with the meter glyphs", () => {
		strictEqual(CONTEXT_CATEGORY_TOKEN.reserve, "frame");
		strictEqual(CONTEXT_CATEGORY_TOKEN.free, "frame");
		strictEqual(strip(contextCategorySwatch("messages", theme)), "▰");
		strictEqual(strip(contextCategorySwatch("reserve", theme)), "▒");
		strictEqual(strip(contextCategorySwatch("free", theme)), "▱");
	});

	it("wraps the quadrant legend by whole chips instead of clipping categories", () => {
		const ledger = buildContextLedger({
			provider: "mock",
			model: "model-a",
			contextWindow: 262_144,
			systemPromptTokens: 6_500,
			toolSchemaTokens: 11_500,
			agentsTokens: 1_800,
			skillsTokens: 900,
			memoryTokens: 400,
			projectTokens: 1_200,
			messageTokens: 41_000,
			pendingTokens: 120,
			compactionAuto: true,
			compactionThreshold: 0.85,
		});
		const facts: ContextEngineFacts = {
			label: null,
			used: ledger.usedTokens,
			contextWindow: ledger.contextWindow,
			toolSchemaTokens: 11_500,
			compactionThreshold: 0.85,
			compactionAuto: true,
			clioMd: null,
			memory: null,
			extensions: null,
			ledger,
		};
		const width = 40;
		const rows = contextQuadrant(facts, { width }).map(strip);
		const legendRows = rows.filter((row) => row.includes("▒ rsv") || row.includes("▰ sys") || row.includes("▱ free"));
		ok(legendRows.length >= 2, `a ten-category legend needs more than one 40-cell row, got ${legendRows.length}`);
		const joined = legendRows.join(" ");
		for (const label of ["sys", "tools", "agt", "skl", "mem", "proj", "chat", "input", "rsv", "free"]) {
			ok(
				joined.includes(` ${label}`) || joined.startsWith(`▰ ${label}`),
				`legend should keep "${label}", got "${joined}"`,
			);
		}
		for (const row of legendRows) {
			ok(!row.includes("…"), `legend rows wrap, never clip: "${row}"`);
			ok(visibleWidth(row) <= width, `legend row exceeds ${width}: "${row}"`);
		}
	});
});

describe("context percent grammar", () => {
	it("formats a measured percent with one decimal", () => {
		strictEqual(formatContextPercent(43.52), "43.5%");
		strictEqual(formatContextPercent(0), "0.0%");
		strictEqual(formatContextPercent(100), "100.0%");
	});

	it("renders the unified ?% placeholder for every unknown", () => {
		strictEqual(formatContextPercent(null), "?%");
		strictEqual(formatContextPercent(undefined), "?%");
		strictEqual(formatContextPercent(Number.NaN), "?%");
	});
});

describe("ultrawide dashboard column shares", () => {
	const SEPS = 9; // three " │ " separators

	it("keeps the base allocation when there is no surplus", () => {
		strictEqual(expandedWideColumnWidths(120, SEPS).join(","), "32,31,27,21");
	});

	it("always fills the available width exactly", () => {
		for (const width of [120, 140, 160, 200, 240, 320]) {
			const widths = expandedWideColumnWidths(width, SEPS);
			strictEqual(
				widths.reduce((sum, item) => sum + item, 0),
				width - SEPS,
				`columns at ${width} should sum to the available width`,
			);
		}
	});

	it("keeps urgent sections strongest while sharing surplus", () => {
		const [activity, context, session, workspace] = expandedWideColumnWidths(200, SEPS);
		strictEqual(activity, 54);
		strictEqual(context, 53);
		strictEqual(session, 44);
		strictEqual(workspace, 40);
		ok(activity >= context && context >= session, "column widths follow the footer's urgency order");
	});

	it("spills into ACTIVITY only after every other cap is reached", () => {
		const [activity, context, session, workspace] = expandedWideColumnWidths(240, SEPS);
		strictEqual(context, 56);
		strictEqual(session, 44);
		strictEqual(workspace, 40);
		strictEqual(activity, 240 - SEPS - 140);
	});
});
