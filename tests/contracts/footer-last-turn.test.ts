import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type AgentWorkFacts,
	activityQuadrant,
	buildMetricStrip,
	type ContextEngineFacts,
	compactSecondaryLine,
	formatLastTurn,
} from "../../src/interactive/footer/widgets.js";
import { INITIAL_STATUS, type TurnSummary } from "../../src/interactive/status/index.js";
import { clioTheme } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);
const strip = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

function makeSummary(overrides: Partial<TurnSummary> = {}): TurnSummary {
	return {
		elapsedMs: 4000,
		modelId: "qwen3-coder",
		targetId: "mini",
		inputTokens: 11,
		outputTokens: 339,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 315,
		toolCount: 2,
		toolErrorCount: 0,
		stopReason: "stop",
		watchdogPeak: 0,
		truncated: false,
		...overrides,
	};
}

const idleContext: ContextEngineFacts = {
	label: null,
	used: null,
	contextWindow: null,
	toolSchemaTokens: null,
	compactionThreshold: null,
	compactionAuto: null,
	clioMd: null,
	memory: null,
	extensions: null,
};

function idleAgent(lastTurn: TurnSummary | null): AgentWorkFacts {
	return { statusText: null, dispatchSummary: null, toolTally: "none · 0✗", dispatchRows: [], lastTurn };
}

describe("footer last-turn metrics", () => {
	it("formats a completed turn elegantly: stop, time, tokens, reasoning, tools", () => {
		const out = strip(formatLastTurn(clioTheme(), makeSummary()));
		strictEqual(out, "✓ 4.0s · ↑11 ↓339 · r315 · 2 tools");
	});

	it("omits the model id (the editor rail already carries it)", () => {
		const out = strip(formatLastTurn(clioTheme(), makeSummary()));
		ok(!out.includes("qwen3-coder"));
		ok(!out.includes("mini"));
	});

	it("marks slow turns, truncation, tool errors, and non-stop outcomes", () => {
		ok(strip(formatLastTurn(clioTheme(), makeSummary({ watchdogPeak: 3 }))).includes("slow"));
		ok(strip(formatLastTurn(clioTheme(), makeSummary({ truncated: true }))).includes("trunc"));
		ok(strip(formatLastTurn(clioTheme(), makeSummary({ toolErrorCount: 1 }))).includes("1✗"));
		ok(strip(formatLastTurn(clioTheme(), makeSummary({ stopReason: "error" }))).includes("✗"));
		ok(strip(formatLastTurn(clioTheme(), makeSummary({ stopReason: "aborted" }))).includes("⊘"));
	});

	it("compact footer shows last-turn metrics when present", () => {
		const withTurn = strip(compactSecondaryLine(idleContext, idleAgent(makeSummary()), 120));
		ok(withTurn.includes("✓ 4.0s"));
		ok(withTurn.includes("↑11 ↓339"));

		const withoutTurn = strip(compactSecondaryLine(idleContext, idleAgent(null), 120));
		ok(!withoutTurn.includes("✓ 4.0s"));
	});

	it("activity quadrant surfaces last-turn metrics below the harness state when idle", () => {
		const joined = strip(activityQuadrant(idleAgent(makeSummary())).join("\n"));
		ok(joined.includes("ACTIVITY"));
		ok(joined.includes("◌ idle"));
		ok(joined.includes("✓ 4.0s"));
		ok(joined.includes("↑11 ↓339"));
	});

	// A turn that spent no reasoning tokens states nothing by printing `r0`, and
	// the footer kept the chip at widths where the fit pass had room for it
	// (issue #57). All three footer sites follow the chat panel's zero rule.
	it("suppresses the reasoning chip at zero everywhere the footer prints it", () => {
		const zero = makeSummary({ reasoningTokens: 0 });
		const turnLine = strip(formatLastTurn(clioTheme(), zero));
		ok(!turnLine.includes("r0"), `formatLastTurn drops the chip at zero, got: ${turnLine}`);

		const quadrant = strip(activityQuadrant(idleAgent(zero)).join("\n"));
		ok(!quadrant.includes("r0"), `the activity quadrant drops it too, got: ${quadrant}`);

		// 117 columns is the width the report observed: wide enough that the fit
		// pass keeps every chip it is handed, so suppression has to be real.
		const metricStrip = strip(buildMetricStrip(clioTheme(), INITIAL_STATUS, null, zero, null, null, null, 117));
		ok(!metricStrip.includes("r0"), `the metric strip drops it too, got: ${metricStrip}`);

		ok(strip(formatLastTurn(clioTheme(), makeSummary())).includes("r315"), "a nonzero turn still shows its chip");
		ok(
			strip(buildMetricStrip(clioTheme(), INITIAL_STATUS, null, makeSummary(), null, null, null, 117)).includes("r315"),
			"the metric strip still shows a nonzero chip",
		);
	});
});
