import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { compactContextWindowLabel, compactSecondaryLine } from "../../src/interactive/footer/widgets.js";
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
