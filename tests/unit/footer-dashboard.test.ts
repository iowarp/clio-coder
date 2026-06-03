import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "../../src/engine/tui.js";
import type { DispatchBoardRow } from "../../src/interactive/dispatch-board.js";
import {
	type FooterDashboardRenderState,
	renderFooterDashboardLines,
	renderFooterStatusLines,
} from "../../src/interactive/footer/dashboard.js";
import { formatToolTally } from "../../src/interactive/footer/widgets.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

function row(overrides: Partial<DispatchBoardRow> = {}): DispatchBoardRow {
	return {
		runId: "run-1",
		agentId: "worker:test",
		runtimeKind: "http",
		runtimeId: "openai",
		endpointId: "mini",
		wireModelId: "qwen",
		status: "running",
		elapsedMs: 1800,
		tokenCount: 12_300,
		costUsd: 0.02,
		...overrides,
	};
}

function state(overrides: Partial<FooterDashboardRenderState> = {}): FooterDashboardRenderState {
	return {
		mode: "advise",
		cwd: "/repo",
		branch: "main",
		targetLabel: "mini·qwen",
		thinkingLabel: "high",
		context: "ctx 12%",
		tokens: "tok ↑1k ↓2k Σ3k",
		statusText: null,
		toolTally: "Read 7 · Bash 3 · 0✗",
		dispatchRows: [],
		version: "0.2.0",
		...overrides,
	};
}

function assertWidthSafe(lines: readonly string[], width: number): void {
	for (const line of lines) ok(visibleWidth(line) <= width, `line too wide: ${visibleWidth(line)} ${line}`);
}

describe("footer dashboard", () => {
	it("formats tool tally counts by frequency and includes errors", () => {
		strictEqual(formatToolTally({ tools: { Bash: 3, Read: 7, Edit: 2 }, errors: 1 }), "Read 7 · Bash 3 · Edit 2 · 1✗");
		strictEqual(formatToolTally({ tools: {}, errors: 0 }), "no tools · 0✗");
	});

	it("excludes dispatch from the tool tally", () => {
		const tally = formatToolTally({ tools: { Read: 7, dispatch: 3 }, errors: 0 });
		strictEqual(tally.includes("dispatch"), false);
		strictEqual(tally, "Read 7 · 0✗");
	});

	it("renders the one-line identity footer", () => {
		const lines = renderFooterDashboardLines(state(), 96);
		strictEqual(lines.length, 1);
		const text = stripAnsi(lines.join("\n"));
		ok(text.includes("clio"), text);
		ok(text.includes("mini·qwen"), text);
		ok(text.includes("think high"), text);
		ok(text.includes("ctx 12%"), text);
		ok(text.includes("v0.2.0"), text);
		assertWidthSafe(lines, 96);
	});

	it("renders status overlay cognitive-loop rows within width", () => {
		const lines = renderFooterStatusLines(state({ statusText: "writing response · 4.2s" }), 92);
		const text = stripAnsi(lines.join("\n"));
		ok(text.includes("PERCEIVE"), text);
		ok(text.includes("REASON"), text);
		ok(text.includes("ACT"), text);
		ok(text.includes("REMEMBER"), text);
		ok(text.includes("Read 7"), text);
		assertWidthSafe(lines, 92);
	});

	it("renders dispatch separator and worker rows in the status overlay", () => {
		const lines = renderFooterStatusLines(state({ dispatchRows: [row()] }), 110);
		const text = stripAnsi(lines.join("\n"));
		ok(text.includes("dispatch"), text);
		ok(text.includes("worker:test"), text);
		ok(text.includes("mini/qwen"), text);
		ok(text.includes("12.3k"), text);
		assertWidthSafe(lines, 110);
	});
});
