import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import {
	compactContextWindowLabel,
	compactSecondaryLine,
	sessionQuadrant,
	zipColumns,
} from "../../src/interactive/footer/widgets.js";
import { clioTheme } from "../../src/interactive/theme/index.js";

const agent = { lastTurn: null } as never;

function facts(contextWindow: number | null) {
	return {
		used: 12_000,
		contextWindow,
		toolSchemaTokens: 2_000,
		breakdown: undefined,
		ledger: null,
	} as never;
}

describe("compact footer names the live context window", () => {
	it("renders the window after the percent at ordinary widths", () => {
		const line = compactSecondaryLine(facts(262_144), agent, 120, clioTheme());
		ok(line.includes("of"), line);
		ok(line.includes("262.1k"), line);
	});

	it("labels a one-million-token window as 1M", () => {
		strictEqual(compactContextWindowLabel(facts(1_048_576), 120), "1M");
	});

	it("drops the window when it is unknown or the row is narrow", () => {
		strictEqual(compactContextWindowLabel(facts(null), 120), null);
		strictEqual(compactContextWindowLabel(facts(262_144), 60), null);
		ok(!compactSecondaryLine(facts(262_144), agent, 60, clioTheme()).includes("of "));
	});
});

it("expanded dashboard wraps long model identities rather than discarding them", () => {
	const target = `blade · dynamo/${"long-model-".repeat(10)}FINAL_MODEL`;
	for (const width of [28, 44, 72]) {
		const rows = zipColumns(
			sessionQuadrant({ target } as never),
			["CONTEXT", "used 17.9k / 262.1k"],
			width,
			width,
			" │ ",
		);
		const plain = rows.map(stripTerminalSequences).join("\n");
		ok(plain.includes("FINAL_MODEL"), plain);
		ok(!plain.includes("…"), plain);
		ok(rows.every((row) => visibleWidth(row) <= width * 2 + 3));
	}
});
