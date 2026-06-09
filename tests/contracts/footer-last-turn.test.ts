import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type AgentWorkFacts,
	activityQuadrant,
	type ContextEngineFacts,
	compactSecondaryLine,
	formatLastTurn,
} from "../../src/interactive/footer/widgets.js";
import type { TurnSummary } from "../../src/interactive/status/index.js";
import { clioTheme } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);
const strip = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

function makeSummary(overrides: Partial<TurnSummary> = {}): TurnSummary {
	return {
		elapsedMs: 4000,
		modelId: "qwen3-coder",
		endpointId: "mini",
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
});
