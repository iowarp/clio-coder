import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "../../src/engine/tui.js";
import type { DispatchBoardRow } from "../../src/interactive/dispatch-board.js";
import {
	type FooterDashboardRenderState,
	renderFooterCompactLines,
	renderFooterDashboardLines,
	renderFooterStatusLines,
} from "../../src/interactive/footer/dashboard.js";
import { formatToolTally } from "../../src/interactive/footer/widgets.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
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

type DeepPartial = {
	workspace?: Partial<FooterDashboardRenderState["workspace"]>;
	session?: Partial<FooterDashboardRenderState["session"]>;
	context?: Partial<FooterDashboardRenderState["context"]>;
	agent?: Partial<FooterDashboardRenderState["agent"]>;
	notices?: FooterDashboardRenderState["notices"];
};

function state(overrides: DeepPartial = {}): FooterDashboardRenderState {
	const base: FooterDashboardRenderState = {
		workspace: {
			cwd: "~/iowarp/clio-coder",
			branch: "main",
			dirty: true,
			projectType: "typescript",
			remote: "https://github.com/akougkas/clio-coder.git",
		},
		session: {
			name: "demo session",
			id: "abc12345",
			mode: "advise",
			version: "0.2.0",
			turns: 4,
			tokens: "↑1k ↓2k Σ3k",
			cost: "cost $0.05",
		},
		context: {
			label: "ctx 12%",
			used: 31_000,
			contextWindow: 262_000,
			compactionThreshold: 0.8,
			compactionAuto: true,
			clioMd: "CLIO.md ok",
			memory: "mem 3",
			extensions: { active: 1, installed: 2 },
		},
		agent: {
			statusText: null,
			dispatchSummary: null,
			toolTally: "Read 7 · Bash 3 · 0✗",
			dispatchRows: [],
		},
		notices: [],
	};
	return {
		workspace: { ...base.workspace, ...overrides.workspace },
		session: { ...base.session, ...overrides.session },
		context: { ...base.context, ...overrides.context },
		agent: { ...base.agent, ...overrides.agent },
		notices: overrides.notices ?? base.notices,
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

	it("renders a compact two-line footer with workspace+resources, free of model/mode/thinking", () => {
		const lines = renderFooterDashboardLines(state(), 96, "compact");
		strictEqual(lines.length, 2);
		const text = stripAnsi(lines.join("\n"));
		ok(text.includes("~/iowarp/clio-coder"), text);
		ok(text.includes("git main"), text);
		ok(text.includes("Σ3k"), text);
		ok(text.includes("$0.05"), text);
		ok(text.includes("ctx 12%"), text);
		ok(text.includes("run idle"), text);
		ok(text.includes("Read 7"), text);
		// The editor rail owns model identity; the footer must not repeat it.
		ok(!text.includes("think"), text);
		ok(!/\badvise\b/.test(text), `compact footer must not carry the mode: ${text}`);
		assertWidthSafe(lines, 96);
	});

	it("renders the active run verb in the compact footer instead of idle", () => {
		const lines = renderFooterDashboardLines(state({ agent: { statusText: "writing response · 4.2s" } }), 96, "compact");
		const text = stripAnsi(lines.join("\n"));
		ok(text.includes("writing response"), text);
		ok(!text.includes("run idle"), text);
	});

	it("shows the branch exactly once across the compact footer", () => {
		const text = stripAnsi(renderFooterDashboardLines(state(), 96, "compact").join("\n"));
		strictEqual(occurrences(text, "main"), 1, text);
	});

	it("disambiguates a branch that looks like a version with a git label", () => {
		const text = stripAnsi(
			renderFooterDashboardLines(state({ workspace: { branch: "v0.2.0" } }), 96, "compact").join("\n"),
		);
		ok(!text.includes("v0.2.0 v0.2.0"), text);
		ok(text.includes("git v0.2.0"), text);
		strictEqual(occurrences(text, "v0.2.0"), 1, text);
	});

	it("keeps the named compact renderer aligned with the default dashboard mode", () => {
		const direct = renderFooterCompactLines(state(), 88).map(stripAnsi);
		const defaulted = renderFooterDashboardLines(state(), 88).map(stripAnsi);
		strictEqual(defaulted.join("\n"), direct.join("\n"));
	});

	it("renders a 2×2 quadrant dashboard on a wide terminal", () => {
		const lines = renderFooterDashboardLines(
			state({ agent: { statusText: "writing response · 4.2s" } }),
			130,
			"expanded",
		);
		const text = stripAnsi(lines.join("\n"));
		ok(text.includes("CLIO DASHBOARD"), text);
		for (const quadrant of ["WORKSPACE", "SESSION", "CONTEXT", "AGENT"]) ok(text.includes(quadrant), text);
		ok(text.includes("git main"), text);
		ok(text.includes("ctx 12%"), text);
		ok(text.includes("compact auto @80%"), text);
		ok(text.includes("akougkas/clio-coder"), text);
		ok(text.includes("writing response"), text);
		ok(text.includes("Read 7"), text);
		assertWidthSafe(lines, 130);
	});

	it("stacks all four quadrants on a medium terminal", () => {
		const lines = renderFooterStatusLines(state(), 96);
		const text = stripAnsi(lines.join("\n"));
		for (const quadrant of ["WORKSPACE", "SESSION", "CONTEXT", "AGENT"]) ok(text.includes(quadrant), text);
		assertWidthSafe(lines, 96);
	});

	it("drops the lowest-priority quadrant (Session) on a narrow terminal", () => {
		const lines = renderFooterStatusLines(state(), 70);
		const text = stripAnsi(lines.join("\n"));
		ok(text.includes("WORKSPACE"), text);
		ok(text.includes("CONTEXT"), text);
		ok(text.includes("AGENT"), text);
		ok(!text.includes("SESSION"), `Session quadrant should be dropped when narrow: ${text}`);
		assertWidthSafe(lines, 70);
	});

	it("integrates dispatch worker rows into the Agent quadrant", () => {
		const lines = renderFooterStatusLines(
			state({ agent: { dispatchSummary: "dispatch 1 active 12.3ktok", dispatchRows: [row()] } }),
			130,
		);
		const text = stripAnsi(lines.join("\n"));
		ok(text.includes("dispatch 1 active"), text);
		ok(text.includes("worker:test"), text);
		assertWidthSafe(lines, 130);
	});

	it("stays width-safe across narrow, medium, and wide terminals in both modes", () => {
		for (const width of [40, 60, 72, 80, 100, 120, 160]) {
			const compact = renderFooterDashboardLines(
				state({ agent: { dispatchSummary: "dispatch 2 active" } }),
				width,
				"compact",
			);
			ok(compact.length >= 1 && compact.length <= 2, `compact must be 1-2 lines, got ${compact.length} at ${width}`);
			assertWidthSafe(compact, width);
			const expanded = renderFooterDashboardLines(
				state({
					agent: { dispatchSummary: "dispatch 1 active 12.3ktok", dispatchRows: [row(), row({ agentId: "worker:b" })] },
				}),
				width,
				"expanded",
			);
			assertWidthSafe(expanded, width);
		}
	});
});
