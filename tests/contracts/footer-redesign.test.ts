import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { UsageBreakdown } from "../../src/domains/observability/index.js";
import { visibleWidth } from "../../src/engine/tui.js";
import type { DispatchBoardRow } from "../../src/interactive/dispatch-board.js";
import {
	type AgentWorkFacts,
	buildHarnessStatePill,
	buildMetricStrip,
	type ContextEngineFacts,
	compactPrimaryLine,
	compactSecondaryLine,
	contextQuadrant,
	type SessionFacts,
	type WorkspaceFacts,
} from "../../src/interactive/footer/widgets.js";
import { buildSegmentedContextBar } from "../../src/interactive/footer-panel.js";
import type { AgentStatus } from "../../src/interactive/status/types.js";
import { clioTheme } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);
const strip = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
const leadingBarCells = (text: string): string => strip(text).match(/^[▰▱█░]+/)?.[0] ?? "";

describe("IT1: Segmented context bar", () => {
	const theme = clioTheme();

	it("sums integer cells exactly to filled", () => {
		const breakdown = {
			systemPromptTokens: 10,
			toolSchemaTokens: 10,
			messageTokens: 5,
			pendingUserTokens: 5,
		};
		const bar = buildSegmentedContextBar(theme, 10, 100, breakdown);
		const stripped = strip(bar);
		strictEqual(stripped, "▰▰▰▱▱▱▱▱▱▱  30.0% ");
	});

	it("uses largest-remainder and order prioritization for rounding ties", () => {
		const breakdown = {
			systemPromptTokens: 10,
			toolSchemaTokens: 10,
			messageTokens: 5,
			pendingUserTokens: 5,
		};
		const bar = buildSegmentedContextBar(theme, 8, 100, breakdown);
		const stripped = strip(bar);
		strictEqual(stripped, "▰▰▱▱▱▱▱▱  30.0% ");
	});

	it("handles window <= 0 path gracefully", () => {
		const bar = buildSegmentedContextBar(theme, 10, 0, undefined);
		const stripped = strip(bar);
		strictEqual(stripped, "▱▱▱▱▱▱▱▱▱▱  --%   ");
	});

	it("keeps percent label width stable and validates visibleWidth", () => {
		const widths = [6, 8, 12, 16];
		for (const w of widths) {
			const bar = buildSegmentedContextBar(theme, w, 1000, {
				systemPromptTokens: 100,
				toolSchemaTokens: 150,
				messageTokens: 50,
				pendingUserTokens: 0,
			});
			const len = visibleWidth(bar);
			strictEqual(len, w + 8, `width should be ${w + 8} for N=${w}`);
		}
	});

	it("applies category colors when tokens are present", () => {
		const breakdown = {
			systemPromptTokens: 200,
			toolSchemaTokens: 200,
			messageTokens: 200,
			pendingUserTokens: 0,
		};
		const bar = buildSegmentedContextBar(theme, 12, 1000, breakdown);
		ok(bar.includes(theme.fgSequence("info")));
		ok(bar.includes(theme.fgSequence("warning")));
		ok(bar.includes(theme.fgSequence("accent")));
	});

	it("clamps overfull windows and keeps cell counts exact", () => {
		const bar = buildSegmentedContextBar(theme, 10, 100, {
			systemPromptTokens: 100,
			toolSchemaTokens: 100,
			messageTokens: 100,
			pendingUserTokens: 0,
		});
		const stripped = strip(bar);
		strictEqual((stripped.match(/[▰█]/g) ?? []).length, 10);
		strictEqual((stripped.match(/[▱░]/g) ?? []).length, 0);
		ok(stripped.includes("100.0%"));
	});

	it("uses single-column context glyphs on this terminal", () => {
		strictEqual(visibleWidth("▰"), 1);
		strictEqual(visibleWidth("▱"), 1);
	});
});

describe("IT2: Harness-state pill", () => {
	const theme = clioTheme();
	const toolCounts = { tools: {}, errors: 0, active: 0 };
	const dispatchRows: DispatchBoardRow[] = [];

	const baseStatus: AgentStatus = {
		phase: "idle",
		since: 1000,
		lastMeaningfulAt: 1000,
		watchdogTier: 0,
		watchdogPeak: 0,
		localRuntime: false,
	};

	it("maps every phase to its glyph, label, and color token", () => {
		const testPhases: Array<{
			phase: AgentStatus["phase"];
			expected: string;
			token: Parameters<typeof theme.fgSequence>[0];
		}> = [
			{ phase: "idle", expected: "◌ idle", token: "muted" },
			{ phase: "preparing", expected: "◔ prep", token: "info" },
			{ phase: "waiting_model", expected: "◔ waiting", token: "info" },
			{ phase: "thinking", expected: "◐ thinking", token: "reason" },
			{ phase: "writing", expected: "◑ writing", token: "accent" },
			{ phase: "tool_running", expected: "⚙ tool bash", token: "accent" },
			{ phase: "tool_blocked", expected: "⏸ blocked", token: "warning" },
			{ phase: "retrying", expected: "↻ retry 2/5", token: "warning" },
			{ phase: "compacting", expected: "♻ compacting", token: "reason" },
			{ phase: "dispatching", expected: "⇲ dispatch", token: "accent" },
			{ phase: "stuck", expected: "⚠ stuck 1s", token: "error" },
			{ phase: "ended", expected: "✓ done", token: "success" },
		];

		const now = 2000;
		for (const { phase, expected, token } of testPhases) {
			const status: AgentStatus = {
				...baseStatus,
				phase,
				since: 1000,
				tool: { toolName: "bash", toolPreview: "" },
				retry: { attempt: 2, maxAttempts: 5, waitMs: 1000 },
			};
			const pill = buildHarnessStatePill(theme, status, toolCounts, dispatchRows, 0, now, 100, false);
			const stripped = strip(pill);
			ok(stripped.includes(expected), `phase ${phase} should contain "${expected}", got "${stripped}"`);
			ok(pill.includes(theme.fgSequence(token)), `phase ${phase} should use ${token}`);
		}
	});

	it("includes a spinner only when active", () => {
		const activeStatus: AgentStatus = { ...baseStatus, phase: "thinking" };
		const activePill = buildHarnessStatePill(theme, activeStatus, toolCounts, dispatchRows, 0, 1000, 80, false);
		const activeStripped = strip(activePill);
		ok(activeStripped.startsWith("⣾"), `active pill should start with spinner frame, got "${activeStripped}"`);

		const idleStatus: AgentStatus = { ...baseStatus, phase: "idle" };
		const idlePill = buildHarnessStatePill(theme, idleStatus, toolCounts, dispatchRows, 0, 1000, 80, false);
		const idleStripped = strip(idlePill);
		ok(!idleStripped.startsWith("⣾"), `idle pill should not start with spinner`);

		const endedStatus: AgentStatus = { ...baseStatus, phase: "ended" };
		const endedPill = buildHarnessStatePill(theme, endedStatus, toolCounts, dispatchRows, 0, 1000, 80, false);
		const endedStripped = strip(endedPill);
		ok(!endedStripped.startsWith("⣾"), `ended pill should not start with spinner`);
	});

	it("applies badge priority: fleet > tools > none", () => {
		const idleStatus: AgentStatus = { ...baseStatus, phase: "idle" };

		const rows: DispatchBoardRow[] = [
			{
				runId: "1",
				agentId: "worker1",
				status: "running",
				tokenCount: 0,
				elapsedMs: 0,
				inputTokens: 0,
				outputTokens: 0,
				runtimeKind: "http",
				runtimeId: "r1",
				endpointId: "e1",
				wireModelId: "w1",
				costUsd: 0,
				ttftMs: null,
			},
		];
		const p1 = buildHarnessStatePill(theme, idleStatus, { tools: {}, errors: 0, active: 3 }, rows, 0, 1000, 80, true);
		ok(strip(p1).includes("· fleet 1"), `should show fleet badge, got "${strip(p1)}"`);

		const p2 = buildHarnessStatePill(theme, idleStatus, { tools: {}, errors: 0, active: 3 }, [], 0, 1000, 80, true);
		ok(strip(p2).includes("· tools 3"), `should show tools count, got "${strip(p2)}"`);

		const p3 = buildHarnessStatePill(theme, idleStatus, { tools: {}, errors: 0, active: 0 }, [], 0, 1000, 80, true);
		ok(strip(p3).includes("· tools none"), `should show tools none, got "${strip(p3)}"`);

		const activeStatus: AgentStatus = { ...baseStatus, phase: "thinking" };
		const p4 = buildHarnessStatePill(theme, activeStatus, { tools: {}, errors: 0, active: 0 }, [], 0, 1000, 80, true);
		ok(!strip(p4).includes("tools none"), `active phase should not claim tools none, got "${strip(p4)}"`);

		const p5 = buildHarnessStatePill(theme, idleStatus, { tools: {}, errors: 0, active: 3 }, [], 0, 1000, 47, true);
		ok(!strip(p5).includes("tools 3"), `ultra-narrow pill should drop badges, got "${strip(p5)}"`);
	});
});

describe("IT3: Metric strip", () => {
	const theme = clioTheme();
	const activeStatus: AgentStatus = {
		phase: "writing",
		since: 1000,
		lastMeaningfulAt: 1000,
		watchdogTier: 0,
		watchdogPeak: 0,
		localRuntime: false,
	};
	const idleStatus: AgentStatus = {
		phase: "idle",
		since: 1000,
		lastMeaningfulAt: 1000,
		watchdogTier: 0,
		watchdogPeak: 0,
		localRuntime: false,
	};
	const mockThroughput = {
		tokensPerSecond: 50,
		outputTokens: 200,
		durationMs: 4000,
		ttftMs: 200,
		providerId: "prov",
		modelId: "model",
		recordedAt: 1000,
	};
	const mockLastTurn = {
		elapsedMs: 3000,
		modelId: "model",
		endpointId: "prov",
		inputTokens: 500,
		outputTokens: 150,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 120,
		toolCount: 1,
		toolErrorCount: 0,
		stopReason: "stop" as const,
		watchdogPeak: 0 as const,
		truncated: false,
	};
	const mockSessionTokens: UsageBreakdown = {
		input: 1000,
		output: 2000,
		totalTokens: 3000,
		cacheRead: 0,
		cacheWrite: 0,
		reasoningTokens: 0,
	};

	it("renders streaming/active state chips", () => {
		const out = buildMetricStrip(theme, activeStatus, mockThroughput, mockLastTurn, mockSessionTokens, 5.5, 500, 100);
		const stripped = strip(out);
		ok(stripped.includes("⚡50/s"), `should have speed, got "${stripped}"`);
		ok(stripped.includes("↓200"), `should have live output, got "${stripped}"`);
		ok(stripped.includes("ttft 200ms"), `should have ttft, got "${stripped}"`);
		ok(stripped.includes("↑500"), `should have input, got "${stripped}"`);
		ok(stripped.includes("Σ3k"), `should have cumulative total, got "${stripped}"`);
		ok(stripped.includes("$5.50"), `should have cost, got "${stripped}"`);
	});

	it("renders idle state chips using lastTurn", () => {
		const out = buildMetricStrip(theme, idleStatus, mockThroughput, mockLastTurn, mockSessionTokens, 5.5, 500, 100);
		const stripped = strip(out);
		ok(stripped.includes("✓ 3.0s"), `should have stop/time, got "${stripped}"`);
		ok(stripped.includes("↑500 ↓150"), `should have turn in/out, got "${stripped}"`);
		ok(stripped.includes("r120"), `should have reasoning, got "${stripped}"`);
		ok(stripped.includes("1 tool"), `should have tools count, got "${stripped}"`);
		ok(stripped.includes("Σ3k"), `should have cumulative total, got "${stripped}"`);
		ok(stripped.includes("$5.50"), `should have cost, got "${stripped}"`);
	});

	it("drops lowest-priority chips first to fit within maxWidth", () => {
		const fullStr = strip(
			buildMetricStrip(theme, idleStatus, mockThroughput, mockLastTurn, mockSessionTokens, 5.5, 500, 100),
		);
		const maxLen = fullStr.length;

		const cut1 = strip(
			buildMetricStrip(theme, idleStatus, mockThroughput, mockLastTurn, mockSessionTokens, 5.5, 500, maxLen - 8),
		);
		ok(!cut1.includes("$5.50"), `should have dropped cost, got "${cut1}"`);
		ok(cut1.includes("Σ3k"), `should keep cumulative total, got "${cut1}"`);

		const cut2 = strip(
			buildMetricStrip(theme, idleStatus, mockThroughput, mockLastTurn, mockSessionTokens, 5.5, 500, maxLen - 16),
		);
		ok(!cut2.includes("$5.50"), `should have dropped cost`);
		ok(!cut2.includes("Σ3k"), `should have dropped cumulative total, got "${cut2}"`);
	});

	it("never exceeds maxWidth while dropping whole chips", () => {
		const full = buildMetricStrip(theme, idleStatus, mockThroughput, mockLastTurn, mockSessionTokens, 5.5, 500, 100);
		for (let maxWidth = 1; maxWidth <= visibleWidth(full); maxWidth += 1) {
			const out = buildMetricStrip(theme, idleStatus, mockThroughput, mockLastTurn, mockSessionTokens, 5.5, 500, maxWidth);
			ok(visibleWidth(out) <= maxWidth, `strip "${strip(out)}" exceeds ${maxWidth}`);
			ok(!strip(out).includes("…"), `strip "${strip(out)}" should not be hard-truncated`);
		}
	});

	it("returns empty string if neither active nor lastTurn exists", () => {
		const out = buildMetricStrip(theme, idleStatus, null, null, mockSessionTokens, 5.5, null, 100);
		strictEqual(out, "");
	});
});

describe("IT4 & IT5: Compact lines and responsiveness", () => {
	const theme = clioTheme();
	const workspace: WorkspaceFacts = {
		cwd: "/home/user/workspace/project-xyz-longer-path",
		branch: "feature/rebalance-footer-ui",
		dirty: true,
		projectType: "typescript",
		remote: "git@github.com:org/repo.git",
	};

	const session: SessionFacts = {
		name: "default",
		id: "sess-1",
		version: "0.2.2",
		turns: 4,
		tokens: "↑1k ↓2k",
		throughput: "⚡50/s",
		throughputDetail: "ttft 200ms",
		cost: "$1.20",
		target: "mock-endpoint·model",
		thinking: "high",
		capabilities: ["tools", "reasoning"],
		safety: "auto-edit",
		sendPolicy: "policy",
		toolProfile: "profile",
	};

	const context: ContextEngineFacts = {
		label: "ctx [████░░░░] 50%",
		used: 5000,
		contextWindow: 10000,
		toolSchemaTokens: 1000,
		compactionThreshold: 0.8,
		compactionAuto: true,
		clioMd: "ok",
		memory: "mem 3",
		extensions: { active: 3, installed: 5 },
		breakdown: {
			systemPromptTokens: 2000,
			toolSchemaTokens: 1000,
			messageTokens: 2000,
			pendingUserTokens: 0,
		},
	};

	const agent: AgentWorkFacts = {
		statusText: "writing code",
		dispatchSummary: "1 active",
		toolTally: "git 2 · view 4 · active 1 · 0✗",
		dispatchRows: [
			{
				runId: "1",
				agentId: "worker1",
				status: "running",
				tokenCount: 0,
				elapsedMs: 1200,
				inputTokens: 0,
				outputTokens: 0,
				runtimeKind: "http",
				runtimeId: "r1",
				endpointId: "e1",
				wireModelId: "w1",
				costUsd: 0,
				ttftMs: null,
			},
		],
		lastTurn: {
			elapsedMs: 2500,
			modelId: "model",
			endpointId: "prov",
			inputTokens: 400,
			outputTokens: 100,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			toolCount: 2,
			toolErrorCount: 0,
			stopReason: "stop",
			watchdogPeak: 0,
			truncated: false,
		},
	};

	const status: AgentStatus = {
		phase: "writing",
		since: 1000,
		lastMeaningfulAt: 1000,
		watchdogTier: 0,
		watchdogPeak: 0,
		localRuntime: false,
	};

	it("renders compactPrimaryLine at exact requested widths and does not overflow", () => {
		for (const w of [40, 60, 80, 100, 120]) {
			const line = compactPrimaryLine(
				workspace,
				session,
				w,
				theme,
				status,
				{ tools: {}, errors: 0, active: 1 },
				agent.dispatchRows,
				0,
				2000,
			);
			strictEqual(visibleWidth(line), w, `visibleWidth should be exactly ${w}`);
		}
	});

	it("renders compactSecondaryLine at exact requested widths and does not overflow", () => {
		const throughput = {
			tokensPerSecond: 45,
			outputTokens: 120,
			durationMs: 2000,
			ttftMs: 150,
			providerId: "prov",
			modelId: "model",
			recordedAt: 1000,
		};
		for (const w of [40, 60, 80, 100, 120]) {
			const line = compactSecondaryLine(context, agent, w, theme, status, throughput, null, 1.2);
			strictEqual(visibleWidth(line), w, `visibleWidth should be exactly ${w}`);
		}
	});

	it("drops the line one badge before dropping git when the primary line is tight", () => {
		const tightWorkspace: WorkspaceFacts = {
			...workspace,
			cwd: "1234567890123456789012345678901234567890",
			branch: "feature/main",
			dirty: false,
		};
		const line = strip(
			compactPrimaryLine(
				tightWorkspace,
				session,
				72,
				theme,
				{ ...status, phase: "idle" },
				{ tools: {}, errors: 0, active: 99 },
				[],
				0,
				2000,
			),
		);
		ok(line.includes("git feature/main"), `git should remain visible, got "${line}"`);
		ok(!line.includes("tools 99"), `badge should be dropped first, got "${line}"`);
	});

	it("keeps the context bar before metrics on narrow secondary lines", () => {
		const throughput = {
			tokensPerSecond: 45,
			outputTokens: 120,
			durationMs: 2000,
			ttftMs: 150,
			providerId: "prov",
			modelId: "model",
			recordedAt: 1000,
		};
		const line = compactSecondaryLine(context, agent, 40, theme, status, throughput, null, 1.2);
		strictEqual(leadingBarCells(line).length, 6);
		strictEqual(visibleWidth(line), 40);
	});

	it("scales context bar width across responsive band boundaries", () => {
		const expectedCells = new Map<number, number | [number, number]>([
			[47, 6],
			[48, 8],
			[71, 8],
			[72, 12],
			[99, 12],
			[100, [14, 16]],
		]);
		for (const [w, expected] of expectedCells) {
			const line = compactSecondaryLine(context, agent, w, theme, status, null, null, null);
			const cells = leadingBarCells(line).length;
			if (Array.isArray(expected)) {
				ok(cells >= expected[0] && cells <= expected[1], `width ${w} should have ${expected[0]}-${expected[1]} cells`);
			} else {
				strictEqual(cells, expected, `width ${w} should have ${expected} cells`);
			}
			strictEqual(visibleWidth(line), w, `width ${w} should be exact`);
		}
		const cellsAt100 = leadingBarCells(compactSecondaryLine(context, agent, 100, theme, status, null, null, null)).length;
		const cellsAt120 = leadingBarCells(compactSecondaryLine(context, agent, 120, theme, status, null, null, null)).length;
		ok(cellsAt120 > cellsAt100, "wide terminals should grow the compact context bar within the band");
	});

	it("uses reported context tokens for the compact percent label", () => {
		const reportedContext: ContextEngineFacts = {
			...context,
			used: 8000,
			contextWindow: 10000,
			breakdown: {
				systemPromptTokens: 1000,
				toolSchemaTokens: 1000,
				messageTokens: 1000,
				pendingUserTokens: 0,
			},
		};
		const line = strip(compactSecondaryLine(reportedContext, agent, 80, theme, status, null, null, null));
		ok(line.includes("80.0%"), `percent label should use reported usage, got "${line}"`);
	});

	it("verifies expanded context quadrant contains the color legend", () => {
		const quad = contextQuadrant(context);
		const legendLine = quad[quad.length - 1] ?? "";
		const stripped = strip(legendLine);
		ok(stripped.includes("sys"), "legend should contain sys");
		ok(stripped.includes("tools"), "legend should contain tools");
		ok(stripped.includes("chat"), "legend should contain chat");
	});
});
