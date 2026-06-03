import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "../../src/engine/tui.js";
import type { DispatchBoardRow } from "../../src/interactive/dispatch-board.js";
import {
	buildFooterDashboard,
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
			throughput: "⚡22 Tk/s",
			throughputDetail: "gen 4.1s · ttft 700ms · ↓2k",
			cost: "cost $0.05",
		},
		context: {
			label: "ctx █░░░░░░░░░ 12%",
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
		ok(text.includes("22 Tk/s"), text);
		ok(text.includes("⚡"), text);
		ok(text.includes("$0.05"), text);
		ok(text.includes("ctx █░░░░░░░░░ 12%"), text);
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

	it("renders four horizontal quadrants at the normal wide dashboard breakpoint", () => {
		const lines = renderFooterDashboardLines(
			state({ agent: { statusText: "writing response · 4.2s" } }),
			100,
			"expanded",
		);
		const text = stripAnsi(lines.join("\n"));
		ok(text.includes("CLIO DASHBOARD"), text);
		ok(text.includes("WORKSPACE"), text);
		ok(text.includes("SESSION"), text);
		ok(text.includes("CONTEXT"), text);
		ok(text.includes("AGENT"), text);
		ok(
			lines
				.map(stripAnsi)
				.some(
					(line) =>
						line.includes("WORKSPACE") && line.includes("SESSION") && line.includes("CONTEXT") && line.includes("AGENT"),
				),
			text,
		);
		ok(text.includes("ctx █░░░░░░░░░ 12%"), text);
		ok(text.includes("speed"), text);
		ok(text.includes("writing response"), text);
		assertWidthSafe(lines, 100);
	});

	it("renders a 2×2 quadrant dashboard below the four-column breakpoint", () => {
		const lines = renderFooterDashboardLines(state({ agent: { statusText: "writing response · 4.2s" } }), 90, "expanded");
		const text = stripAnsi(lines.join("\n"));
		ok(text.includes("CLIO DASHBOARD"), text);
		for (const quadrant of ["WORKSPACE", "SESSION", "CONTEXT", "AGENT"]) ok(text.includes(quadrant), text);
		ok(text.includes("git main"), text);
		ok(text.includes("ctx █░░░░░░░░░ 12%"), text);
		ok(text.includes("speed"), text);
		ok(text.includes("gen 4.1s"), text);
		ok(text.includes("compact auto @80%"), text);
		ok(text.includes("akougkas/clio-coder"), text);
		ok(text.includes("writing response"), text);
		ok(text.includes("Read 7"), text);
		assertWidthSafe(lines, 90);
	});

	it("stacks all four quadrants vertically below the 2x2 breakpoint", () => {
		const lines = renderFooterStatusLines(state(), 70);
		const text = stripAnsi(lines.join("\n"));
		for (const quadrant of ["WORKSPACE", "SESSION", "CONTEXT", "AGENT"]) ok(text.includes(quadrant), text);
		assertWidthSafe(lines, 70);
	});

	it("keeps all four quadrants on a narrow terminal", () => {
		const lines = renderFooterStatusLines(state(), 60);
		const text = stripAnsi(lines.join("\n"));
		ok(text.includes("WORKSPACE"), text);
		ok(text.includes("SESSION"), text);
		ok(text.includes("CONTEXT"), text);
		ok(text.includes("AGENT"), text);
		assertWidthSafe(lines, 60);
	});

	it("renders CLIO.md and memory facts in the Context quadrant", () => {
		const lines = renderFooterStatusLines(state({ context: { clioMd: "CLIO.md stale", memory: "mem 5" } }), 120);
		const text = stripAnsi(lines.join("\n"));
		ok(text.includes("CLIO.md stale"), text);
		ok(text.includes("mem 5"), text);
	});

	it("shows active compaction in the Context quadrant", () => {
		const lines = renderFooterStatusLines(state({ context: { compactionActive: true } }), 120);
		const text = stripAnsi(lines.join("\n"));
		ok(text.includes("compacting auto @80%"), text);
	});

	it("builds Context and live Session facts from footer deps", () => {
		let turns = 4;
		const panel = buildFooterDashboard({
			modes: { current: () => "default" } as never,
			providers: {} as never,
			getTerminalColumns: () => 120,
			getWorkspaceSnapshot: () => ({
				cwd: process.cwd(),
				isGit: false,
				branch: null,
				dirty: null,
				ahead: null,
				behind: null,
				recentCommits: [],
				remoteUrl: null,
				projectType: "typescript",
				capturedAt: "2026-01-01T00:00:00.000Z",
			}),
			getSessionInfo: () => ({ id: "s1", name: "live", turns }),
			getContextState: () => ({ clioMd: "ok", memoryCount: 2 }),
		});
		let text = stripAnsi(panel.statusLines(120).join("\n"));
		ok(text.includes("turns 4"), text);
		ok(text.includes("CLIO.md ok"), text);
		ok(text.includes("mem 2"), text);

		turns = 5;
		text = stripAnsi(panel.statusLines(120).join("\n"));
		ok(text.includes("turns 5"), text);
	});

	it("includes latest token throughput in Session facts", () => {
		const panel = buildFooterDashboard({
			modes: { current: () => "default" } as never,
			providers: {} as never,
			getTerminalColumns: () => 120,
			getSessionTokens: () => ({
				input: 5500,
				output: 120,
				cacheRead: 0,
				cacheWrite: 0,
				reasoningTokens: 80,
				totalTokens: 5700,
			}),
			getTokenThroughput: () => ({
				tokensPerSecond: 42,
				outputTokens: 120,
				durationMs: 2857,
				ttftMs: 640,
				providerId: "mini",
				modelId: "gemma-4-12b-q4-code-256k",
				recordedAt: 1,
			}),
		});
		const text = stripAnsi(panel.statusLines(120).join("\n"));
		ok(text.includes("42 Tk/s"), text);
		ok(text.includes("gen 2.9s"), text);
		ok(text.includes("ttft 640ms"), text);
		ok(text.includes("↓120"), text);
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
