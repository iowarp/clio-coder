import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { costAggregateForAmount, type UsageBreakdown } from "../../src/domains/observability/index.js";
import { visibleWidth } from "../../src/engine/tui.js";
import type { DispatchBoardRow } from "../../src/interactive/dispatch-board.js";
import { type FooterDashboardRenderState, renderFooterStatusLines } from "../../src/interactive/footer/dashboard.js";
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
	zipColumns,
} from "../../src/interactive/footer/widgets.js";
import { buildSegmentedContextBar } from "../../src/interactive/footer-panel.js";
import type { AgentStatus } from "../../src/interactive/status/types.js";
import { clioTheme, spinnerFrame } from "../../src/interactive/theme/index.js";

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

	it("handles window <= 0 path gracefully with the unified ?% unknown grammar", () => {
		const bar = buildSegmentedContextBar(theme, 10, 0, undefined);
		const stripped = strip(bar);
		strictEqual(stripped, "▱▱▱▱▱▱▱▱▱▱  ?%    ");
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

	it("leads every phase with a spinner or static glyph, then label and color token", () => {
		// Live phases lead with the animated spinner in place of the static phase
		// glyph. Idle, the attention states (blocked, retry, stuck), and the ended
		// state stay static, so their glyph anchors the pill.
		const testPhases: Array<{
			phase: AgentStatus["phase"];
			label: string;
			live: boolean;
			staticGlyph: string;
			token: Parameters<typeof theme.fgSequence>[0];
		}> = [
			{ phase: "idle", label: "idle", live: false, staticGlyph: "◌", token: "muted" },
			{ phase: "preparing", label: "prep", live: true, staticGlyph: "◔", token: "info" },
			{ phase: "waiting_model", label: "waiting", live: true, staticGlyph: "◔", token: "info" },
			{ phase: "thinking", label: "thinking", live: true, staticGlyph: "◐", token: "reason" },
			{ phase: "writing", label: "writing", live: true, staticGlyph: "◑", token: "accent" },
			{ phase: "tool_running", label: "tool bash", live: true, staticGlyph: "⚙", token: "accent" },
			// tool_blocked fires only on PermissionRequested, so the pill names the
			// wait for confirmation instead of contradicting the ask overlay.
			{ phase: "tool_blocked", label: "confirm", live: false, staticGlyph: "⏸", token: "warning" },
			{ phase: "retrying", label: "retry 2/5", live: false, staticGlyph: "↻", token: "warning" },
			{ phase: "compacting", label: "compacting", live: true, staticGlyph: "♻", token: "reason" },
			{ phase: "dispatching", label: "dispatch", live: true, staticGlyph: "⇲", token: "action" },
			{ phase: "stuck", label: "stuck 1s", live: false, staticGlyph: "⚠", token: "error" },
			{ phase: "ended", label: "done", live: false, staticGlyph: "✓", token: "success" },
		];

		const now = 2000;
		const tick = 0;
		for (const { phase, label, live, staticGlyph, token } of testPhases) {
			const status: AgentStatus = {
				...baseStatus,
				phase,
				since: 1000,
				tool: { toolName: "bash", toolPreview: "" },
				retry: { attempt: 2, maxAttempts: 5, waitMs: 1000 },
			};
			const pill = buildHarnessStatePill(theme, status, toolCounts, dispatchRows, tick, now, 100, false);
			const stripped = strip(pill);
			const lead = live ? spinnerFrame(tick) : staticGlyph;
			strictEqual(stripped, `${lead} ${label}`, `phase ${phase} should render "${lead} ${label}", got "${stripped}"`);
			ok(pill.includes(theme.fgSequence(token)), `phase ${phase} should use ${token}`);
			if (live) {
				ok(!stripped.includes(staticGlyph), `phase ${phase} spinner should replace, not sit beside, "${staticGlyph}"`);
			}
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

		// Attention states are not live-spinning; they hold their static glyph.
		for (const phase of ["tool_blocked", "retrying", "stuck"] as const) {
			const attentionStatus: AgentStatus = {
				...baseStatus,
				phase,
				since: 900,
				retry: { attempt: 2, maxAttempts: 5, waitMs: 1000 },
			};
			const attentionPill = strip(
				buildHarnessStatePill(theme, attentionStatus, toolCounts, dispatchRows, 0, 1000, 80, false),
			);
			ok(!attentionPill.startsWith("⣾"), `${phase} pill should not start with spinner, got "${attentionPill}"`);
		}
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
				targetId: "e1",
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
		targetId: "prov",
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
	const knownCost = costAggregateForAmount(5.5, "known");

	it("renders streaming/active state chips", () => {
		const out = buildMetricStrip(
			theme,
			activeStatus,
			mockThroughput,
			mockLastTurn,
			mockSessionTokens,
			knownCost,
			500,
			100,
		);
		const stripped = strip(out);
		ok(stripped.includes("⚡50/s"), `should have speed, got "${stripped}"`);
		ok(stripped.includes("↓200"), `should have live output, got "${stripped}"`);
		ok(stripped.includes("ttft 200ms"), `should have ttft, got "${stripped}"`);
		ok(stripped.includes("↑500"), `should have input, got "${stripped}"`);
		ok(stripped.includes("Σ3k"), `should have cumulative total, got "${stripped}"`);
		ok(stripped.includes("$5.50"), `should have cost, got "${stripped}"`);
	});

	it("renders idle state chips using lastTurn", () => {
		const out = buildMetricStrip(theme, idleStatus, mockThroughput, mockLastTurn, mockSessionTokens, knownCost, 500, 100);
		const stripped = strip(out);
		ok(stripped.includes("✓ 3.0s"), `should have stop/time, got "${stripped}"`);
		ok(stripped.includes("↑500 ↓150"), `should have turn in/out, got "${stripped}"`);
		ok(stripped.includes("r120"), `should have reasoning, got "${stripped}"`);
		ok(stripped.includes("1 tool"), `should have tools count, got "${stripped}"`);
		ok(stripped.includes("Σ3k"), `should have cumulative total, got "${stripped}"`);
		ok(stripped.includes("$5.50"), `should have cost, got "${stripped}"`);
	});

	/**
	 * Cost used to sit last and so was the first chip cut, which is how an
	 * 80-column footer spent its whole budget on per-turn detail and dropped the
	 * money field at the exact moment it acquired a value, while `/cost` on the
	 * same session was reporting one. The session totals now outrank the per-turn
	 * detail; below them the drop order is unchanged.
	 */
	it("drops per-turn detail before the session totals to fit within maxWidth", () => {
		const fullStr = strip(
			buildMetricStrip(theme, idleStatus, mockThroughput, mockLastTurn, mockSessionTokens, knownCost, 500, 100),
		);
		const maxLen = fullStr.length;

		const cut1 = strip(
			buildMetricStrip(theme, idleStatus, mockThroughput, mockLastTurn, mockSessionTokens, knownCost, 500, maxLen - 8),
		);
		ok(!cut1.includes("1 tool"), `should have dropped the tool count first, got "${cut1}"`);
		ok(cut1.includes("$5.50"), `should keep cost, got "${cut1}"`);
		ok(cut1.includes("Σ3k"), `should keep cumulative total, got "${cut1}"`);

		const cut2 = strip(
			buildMetricStrip(theme, idleStatus, mockThroughput, mockLastTurn, mockSessionTokens, knownCost, 500, maxLen - 16),
		);
		ok(!cut2.includes("$5.50"), `should have dropped cost, got "${cut2}"`);
		ok(cut2.includes("Σ3k"), `should keep cumulative total, got "${cut2}"`);
	});

	it("never exceeds maxWidth while dropping whole chips", () => {
		const full = buildMetricStrip(
			theme,
			idleStatus,
			mockThroughput,
			mockLastTurn,
			mockSessionTokens,
			knownCost,
			500,
			100,
		);
		for (let maxWidth = 1; maxWidth <= visibleWidth(full); maxWidth += 1) {
			const out = buildMetricStrip(
				theme,
				idleStatus,
				mockThroughput,
				mockLastTurn,
				mockSessionTokens,
				knownCost,
				500,
				maxWidth,
			);
			ok(visibleWidth(out) <= maxWidth, `strip "${strip(out)}" exceeds ${maxWidth}`);
			ok(!strip(out).includes("…"), `strip "${strip(out)}" should not be hard-truncated`);
		}
	});

	it("renders truthful cost provenance and drops the entire cost chip when narrow", () => {
		const costs = [
			[costAggregateForAmount(0, "known_free"), "$0.00 local"],
			[costAggregateForAmount(0.42, "estimated"), "~$0.42 est"],
			[{ ...costAggregateForAmount(0.42, "known"), hasUnknown: true }, "$0.42 +?"],
		] as const;
		for (const [cost, expected] of costs) {
			const full = strip(buildMetricStrip(theme, idleStatus, mockThroughput, mockLastTurn, null, cost, null, 100));
			ok(full.includes(expected), full);
			const narrow = strip(buildMetricStrip(theme, idleStatus, mockThroughput, mockLastTurn, null, cost, null, 8));
			ok(!narrow.includes(expected.slice(0, 4)), `cost chip must be whole or absent, got "${narrow}"`);
		}
	});

	it("returns empty string if neither active nor lastTurn exists", () => {
		const out = buildMetricStrip(theme, idleStatus, null, null, mockSessionTokens, knownCost, null, 100);
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
		target: "mock-target · model",
		thinking: "high",
		capabilities: ["tools", "reason", "vision", "ctx 262k"],
		safety: "auto-edit",
		toolProfile: "profile",
		outputVerbosity: "minimal",
	};

	const context: ContextEngineFacts = {
		label: "ctx ░░░░░ 50%",
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
				targetId: "e1",
				wireModelId: "w1",
				costUsd: 0,
				ttftMs: null,
			},
		],
		lastTurn: {
			elapsedMs: 2500,
			modelId: "model",
			targetId: "prov",
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
			const line = compactSecondaryLine(
				context,
				agent,
				w,
				theme,
				status,
				throughput,
				null,
				costAggregateForAmount(1.2, "known"),
			);
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

	it("shows the active output mode in both compact and expanded footer states", () => {
		const compact = strip(
			compactSecondaryLine(context, agent, 80, theme, { ...status, phase: "idle" }, null, null, null, "verbose"),
		);
		ok(compact.includes("out verbose"), compact);
		const compactNarrow = strip(
			compactSecondaryLine(context, agent, 20, theme, { ...status, phase: "idle" }, null, null, null, "verbose"),
		);
		ok(compactNarrow.includes("out:v"), compactNarrow);

		const expanded = strip(
			renderFooterStatusLines(
				expandedRenderState({
					workspace,
					session: { ...session, outputVerbosity: "minimal" },
					context,
					agent: { ...agent, statusText: null, toolTally: "none · 0✗" },
					status: { ...status, phase: "idle" },
				}),
				120,
			).join("\n"),
		);
		ok(/output\s+minimal/.test(expanded), expanded);
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
		const line = compactSecondaryLine(
			context,
			agent,
			40,
			theme,
			status,
			throughput,
			null,
			costAggregateForAmount(1.2, "known"),
		);
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

	it("styles the ledger ctx row as kv: dim key, muted percent, dim ?% before measurement", () => {
		const ledger = {
			contextWindow: 10_000,
			percent: 43.5,
			meter: [{ category: "messages", label: "conversation", tokens: 4_350, percent: 43.5 }],
			groups: [],
		} as unknown as NonNullable<ContextEngineFacts["ledger"]>;

		const measured = compactSecondaryLine({ ...context, ledger }, agent, 80, theme, status, null, null, null);
		ok(measured.includes(theme.fg("dim", "ctx")), `the ctx key reads dim, got "${measured}"`);
		ok(measured.includes(theme.fg("muted", "43.5%")), `a measured percent reads muted, got "${measured}"`);

		const unmeasured = compactSecondaryLine(
			{ ...context, ledger: { ...ledger, percent: null } },
			agent,
			80,
			theme,
			status,
			null,
			null,
			null,
		);
		ok(unmeasured.includes(theme.fg("dim", "?%")), `the unmeasured placeholder reads dim, got "${unmeasured}"`);
	});

	it("verifies expanded context quadrant contains the color legend", () => {
		const quad = contextQuadrant(context);
		const legendLine = quad[quad.length - 1] ?? "";
		const stripped = strip(legendLine);
		ok(stripped.includes("sys"), "legend should contain sys");
		ok(stripped.includes("tools"), "legend should contain tools");
		ok(stripped.includes("chat"), "legend should contain chat");
		ok(stripped.includes("free"), "legend should contain free");
		ok(!strip(quad.join("\n")).includes("ctx ░"), "expanded context should not use the old flat ctx label");
	});

	it("renders expanded dashboard without overflowing responsive widths", () => {
		const state = expandedRenderState({
			workspace,
			session,
			context,
			agent: { ...agent, statusText: null, toolTally: "none · 0✗" },
			status: { ...status, phase: "idle" },
		});
		for (const w of [70, 80, 100, 119, 120, 134, 200, 240]) {
			const lines = renderFooterStatusLines(state, w);
			for (const line of lines) {
				ok(visibleWidth(line) <= w, `width ${w} line "${strip(line)}" overflowed with ${visibleWidth(line)}`);
			}
		}
	});

	it("uses four deliberate wide sections and renames AGENT to ACTIVITY", () => {
		const lines = renderFooterStatusLines(
			expandedRenderState({
				workspace,
				session,
				context,
				agent: { ...agent, statusText: null, toolTally: "none · 0✗" },
				status: { ...status, phase: "idle" },
			}),
			134,
		);
		const headerRow = strip(lines.find((line) => strip(line).includes("WORKSPACE")) ?? "");
		ok(headerRow.includes("WORKSPACE"), `wide header should include WORKSPACE, got "${headerRow}"`);
		ok(headerRow.includes("SESSION"), `wide header should include SESSION, got "${headerRow}"`);
		ok(headerRow.includes("CONTEXT"), `wide header should include CONTEXT, got "${headerRow}"`);
		ok(headerRow.includes("ACTIVITY"), `wide header should include ACTIVITY, got "${headerRow}"`);
		ok(!headerRow.includes("AGENT"), `wide header should not include AGENT, got "${headerRow}"`);
		strictEqual(headerRow.split("│").length, 4, `wide header should have four columns, got "${headerRow}"`);
	});

	it("paints the dashboard header wordmark as a logotype: dim scaffolding around a bold accent C", () => {
		const lines = renderFooterStatusLines(
			expandedRenderState({
				workspace,
				session,
				context,
				agent: { ...agent, statusText: null, toolTally: "none · 0✗" },
				status: { ...status, phase: "idle" },
			}),
			120,
		);
		const header = lines.find((line) => strip(line).includes("CLIO DASHBOARD")) ?? "";
		const theme = clioTheme();
		const logotype = `${theme.fg("dim", ">")}${theme.style("accent", "C", { bold: true })}${theme.fg("dim", "_")}`;
		ok(header.includes(logotype), `the dashboard header should open with the composed logotype, got "${header}"`);
		ok(
			header.includes(theme.style("title", "CLIO DASHBOARD", { bold: true })),
			"the header label next to the logotype stays bold title",
		);
		ok(strip(header).includes(">C_ CLIO DASHBOARD"), "the stripped header keeps the plain wordmark for width math");
	});

	it("keeps expanded context segmented and removes old awkward labels", () => {
		const joined = strip(
			renderFooterStatusLines(
				expandedRenderState({
					workspace,
					session,
					context,
					agent: { ...agent, statusText: null, toolTally: "none · 0✗" },
					status: { ...status, phase: "idle" },
				}),
				134,
			).join("\n"),
		);
		ok(joined.includes("50.0%"), `expanded context should include segmented percent, got "${joined}"`);
		ok(joined.includes("▰ sys"), "expanded context should include segmented legend");
		ok(joined.includes("▱ free"), "expanded context should include free legend");
		ok(!joined.includes("ctx ░"), `expanded dashboard should not include old ctx bar, got "${joined}"`);
		ok(!joined.includes("tools no tools"), `expanded dashboard should not say tools no tools, got "${joined}"`);
		ok(/\btools\s+none · 0✗/.test(joined), `expanded activity should say tools none, got "${joined}"`);
	});

	it("keeps live telemetry out of SESSION and in ACTIVITY", () => {
		const lines = renderFooterStatusLines(
			expandedRenderState({
				workspace,
				session,
				context,
				agent: { ...agent, statusText: null, toolTally: "none · 0✗" },
				status: { ...status, phase: "idle" },
			}),
			134,
		);
		const sessionText = wideColumnText(lines, 1);
		const activityText = wideColumnText(lines, 3);
		ok(sessionText.includes("target"), `SESSION should include target, got "${sessionText}"`);
		ok(sessionText.includes("caps"), `SESSION should include caps, got "${sessionText}"`);
		ok(
			!sessionText.includes("policy"),
			`SESSION must not show a send-policy row (one send path exists), got "${sessionText}"`,
		);
		ok(!sessionText.includes("speed"), `SESSION should not include speed, got "${sessionText}"`);
		ok(!sessionText.includes("cost"), `SESSION should not include cost, got "${sessionText}"`);
		ok(!sessionText.includes("tok"), `SESSION should not include token rows, got "${sessionText}"`);
		ok(!sessionText.includes("v0.2.2"), `SESSION should not duplicate version, got "${sessionText}"`);
		ok(activityText.includes("last"), `ACTIVITY should include last-turn row, got "${activityText}"`);
		ok(activityText.includes("turn"), `ACTIVITY should include turn metrics, got "${activityText}"`);
		ok(activityText.includes("cost"), `ACTIVITY should include cost, got "${activityText}"`);
	});

	it("paints all four quadrant tags with the identical bold accentDeep sequence", () => {
		const lines = renderFooterStatusLines(
			expandedRenderState({
				workspace,
				session,
				context,
				agent: { ...agent, statusText: null, toolTally: "none · 0✗" },
				status: { ...status, phase: "idle" },
			}),
			134,
		);
		const header = lines.find((line) => strip(line).includes("WORKSPACE")) ?? "";
		// The bold accentDeep opener the tag paints; slice it off a marker render so
		// the expectation carries no hand-written escape bytes.
		const boldAccentDeep = theme.style("accentDeep", " ", { bold: true }).split(" ")[0] ?? "";
		const tagSequence = (label: string): string => header.match(new RegExp(`(${ESC}\\[[0-9;]*m)${label}`))?.[1] ?? "";
		for (const label of ["WORKSPACE", "SESSION", "CONTEXT", "ACTIVITY"]) {
			strictEqual(tagSequence(label), boldAccentDeep, `${label} tag should render in bold accentDeep`);
		}
	});

	it("keeps the idle dashboard free of action orange", () => {
		const joined = renderFooterStatusLines(
			expandedRenderState({
				workspace,
				session,
				context,
				agent: { ...agent, statusText: null, dispatchSummary: null, dispatchRows: [], toolTally: "none · 0✗" },
				status: { ...status, phase: "idle" },
			}),
			134,
		).join("\n");
		ok(
			!joined.includes(theme.fgSequence("action")),
			`idle dashboard must contain no action orange, got "${strip(joined)}"`,
		);
	});

	it("never paints a dashboard value in the accentDeep structure color", () => {
		// accentDeep only ever appears as the bold section tag, so its fg-only
		// (value) sequence must not survive anywhere in the rendered dashboard.
		const joined = renderFooterStatusLines(expandedRenderState({ workspace, session, context, agent, status }), 134).join(
			"\n",
		);
		ok(
			!joined.includes(theme.fgSequence("accentDeep")),
			`accentDeep is a structure color and must not paint any value, got "${strip(joined)}"`,
		);
	});

	it("marks a clipped quadrant cell with an ellipsis instead of an unmarked cut", () => {
		const rows = zipColumns(
			["fill tools 11.5k · sys 6.5k · proj 1.2k · msgs 40k"],
			["state running tool: bash for a very long while"],
			20,
			18,
			" | ",
		);
		const row = strip(rows[0] ?? "");
		strictEqual(visibleWidth(row), 20 + 3 + 18, "cells stay padded to their exact column widths");
		const [leftCell, rightCell] = row.split(" | ");
		ok(leftCell?.includes("…"), `a clipped left cell carries the marker: ${JSON.stringify(row)}`);
		ok(rightCell?.includes("…"), `a clipped right cell carries the marker: ${JSON.stringify(row)}`);

		const short = strip(zipColumns(["fits"], ["also fits"], 20, 18, " | ")[0] ?? "");
		ok(!short.includes("…"), `an unclipped cell carries no marker: ${JSON.stringify(short)}`);
	});
});

function expandedRenderState(parts: {
	workspace: WorkspaceFacts;
	session: SessionFacts;
	context: ContextEngineFacts;
	agent: AgentWorkFacts;
	status: AgentStatus;
}): FooterDashboardRenderState {
	const sessionTokens: UsageBreakdown = {
		input: 1000,
		output: 200,
		totalTokens: 1200,
		cacheRead: 0,
		cacheWrite: 0,
		reasoningTokens: 100,
	};
	return {
		workspace: parts.workspace,
		session: parts.session,
		context: parts.context,
		agent: parts.agent,
		notices: [],
		status: parts.status,
		toolCounts: { tools: {}, errors: 0, active: 0 },
		dispatchRows: parts.agent.dispatchRows,
		throughput: {
			tokensPerSecond: 99,
			outputTokens: 140,
			durationMs: 1600,
			ttftMs: 171,
			providerId: "mini",
			modelId: "model",
			recordedAt: 1000,
		},
		sessionTokens,
		sessionCost: costAggregateForAmount(1.2, "known"),
		tick: 0,
		now: 2000,
	};
}

function wideColumnText(lines: readonly string[], column: number): string {
	return lines
		.map(strip)
		.filter((line) => line.includes("│"))
		.map((line) => line.split("│")[column]?.trim() ?? "")
		.join("\n");
}
