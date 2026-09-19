import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createWorkerProgressFold } from "../../src/domains/observability/worker-progress.js";
import { buildContextLedger } from "../../src/domains/session/context-ledger.js";
import { getKeybindings, setKeybindings, stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { contextCategorySwatch, renderContextMeterGrid } from "../../src/interactive/context-meter.js";
import { buildFooterDashboard, type FooterDashboardRenderState } from "../../src/interactive/footer/dashboard.js";
import { DASHBOARD_PAGES, renderCompactDashboard, renderDashboardPage } from "../../src/interactive/footer/pages.js";
import { createKeybindingManager } from "../../src/interactive/keybinding-manager.js";
import {
	renderToolExecution,
	renderToolPreview,
	renderToolSubline,
} from "../../src/interactive/renderers/tool-execution.js";
import { clioTheme } from "../../src/interactive/theme/index.js";
import { transcriptDetail } from "../../src/interactive/transcript-detail.js";

function state(): FooterDashboardRenderState {
	const ledger = buildContextLedger({
		provider: "blade",
		model: "dynamo/qwopus",
		contextWindow: 262144,
		systemPromptTokens: 3700,
		toolSchemaTokens: 8200,
		messageTokens: 55300,
		agentsTokens: 915,
		skillsTokens: 361,
		compactionThreshold: 0.9,
		compactionAuto: true,
	});
	const row = {
		runId: "scout-run",
		agentId: "scout",
		agentAudience: "shadow" as const,
		runtimeKind: "http" as const,
		runtimeId: "litellm",
		targetId: "blade",
		wireModelId: "mini/qwopus",
		taskSummary: "Explore the dispatch architecture and explain worker handoffs",
		status: "running" as const,
		elapsedMs: 12000,
		tokenCount: 70000,
		costUsd: 0,
		inputTokens: 68000,
		outputTokens: 2000,
		ttftMs: 300,
		lastContextTokens: 17000,
		contextWindow: 262144,
	};
	return {
		workspace: {
			cwd: "~/iowarp/clio-coder",
			branch: "v050",
			dirty: false,
			projectType: "typescript",
			remote: "iowarp/clio-coder",
		},
		session: {
			id: "session",
			name: null,
			version: "0.5.0",
			turns: 2,
			tokens: "70k",
			throughput: null,
			throughputDetail: null,
			cost: null,
			target: "blade · dynamo/qwopus3.8-27b-flash@q4_k_m",
			thinking: "on",
			capabilities: ["tools", "vision"],
			safety: "auto-edit",
			toolProfile: "agent-managed",
		},
		context: {
			label: null,
			used: ledger.usedTokens,
			contextWindow: ledger.contextWindow,
			toolSchemaTokens: 8200,
			compactionThreshold: 0.9,
			compactionAuto: true,
			clioMd: "CLIO-CODER.md none",
			memory: null,
			extensions: null,
			ledger,
		},
		agent: {
			statusText: "exploring",
			dispatchSummary: "helpers scout 1 running",
			toolTally: "19 available",
			dispatchRows: [row],
			lastTurn: null,
		},
		notices: [],
		status: { phase: "idle", since: 0, lastMeaningfulAt: 0, watchdogTier: 0, watchdogPeak: 0, localRuntime: false },
		toolCounts: { tools: {}, errors: 0 },
		dispatchRows: [row],
		throughput: null,
		sessionTokens: null,
		sessionCost: null,
		tick: 0,
		now: 12000,
	};
}
const plain = (rows: string[]) => rows.map(stripTerminalSequences).join("\n");

test("dashboard pages devote space to agents, context composition and complete status", () => {
	for (const width of [40, 80, 120, 172]) {
		for (const page of DASHBOARD_PAGES) {
			const rows = renderDashboardPage(state(), page, width, 40, "Alt+U");
			ok(
				rows.every((line) => visibleWidth(line) <= width),
				`${page} ${width}`,
			);
			ok(rows.length <= 33, `${page} exceeded footer budget`);
			match(plain(rows), /Alt\+U/);
		}
	}
	const activity = plain(renderDashboardPage(state(), "Activity", 172, 40, "Alt+U"));
	match(activity, /Scout/);
	match(activity, /internal agent/);
	match(activity, /Explore the dispatch/);
	match(activity, /context 17k/);
	match(activity, /blade\/mini\/qwopus/);
	const context = plain(renderDashboardPage(state(), "Context", 172, 40, "Alt+U"));
	match(context, /CONTEXT COMPOSITION/);
	match(context, /Estimated usage/);
	const status = plain(renderDashboardPage(state(), "Status", 172, 40, "Alt+U"));
	match(status, /dynamo\/qwopus3.8-27b-flash@q4_k_m/);
	match(status, /PROJECT & RESOURCES/);
});

test("resolved dashboard shortcut cycles Activity, Context, Status and closed without capturing text", () => {
	const previous = getKeybindings();
	createKeybindingManager({
		...DEFAULT_SETTINGS,
		interface: { ...DEFAULT_SETTINGS.interface, keybindings: { "clio-coder.status.toggle": "ctrl+u" } },
	});
	const footer = buildFooterDashboard({
		providers: { list: () => [] } as never,
		resolveCurrentBranch: async () => null,
		getTerminalColumns: () => 120,
		getTerminalRows: () => 40,
	});
	try {
		const modes = [];
		for (const page of DASHBOARD_PAGES) {
			modes.push(footer.toggleExpanded());
			const text = plain(footer.view.render(120));
			match(text, new RegExp(page.toUpperCase()));
			match(text, /ctrl\+u/);
		}
		modes.push(footer.toggleExpanded());
		deepStrictEqual(modes, ["expanded", "expanded", "expanded", "compact"]);
		strictEqual(footer.isExpanded(), false);
	} finally {
		footer.dispose();
		setKeybindings(previous);
	}
});

test("invocation previews omit redundant short primary values, retain options and preserve full inspection", () => {
	for (const style of ["compact", "standard", "detailed"] as const) {
		const call = {
			toolName: "read",
			toolCallId: "read",
			args: { path: "README.md", offset: 40, limit: 80 },
			result: "contents",
			isError: false,
		};
		const text = plain(renderToolPreview(call, 100, transcriptDetail(style)));
		strictEqual(text.split("README.md").length - 1, 1);
		match(text, /offset.*40/);
		match(text, /limit.*80/);
		match(plain(renderToolExecution(call, 100)), /path.*README.md/);
		const long = { ...call, args: { path: `${"directory/".repeat(12)}final.ts` } };
		match(plain(renderToolPreview(long, 100, transcriptDetail(style))), /path/);
	}
	doesNotMatch(plain(renderToolSubline({ toolName: "ls", toolCallId: "ls", args: {} }, 100)), /tool action/);
});

test("Activity gives two live agents full-width tasks and distinct work measurements", () => {
	const snapshot = state();
	const task = `${"Read the interview implementation and explain navigation, preserved drafts, round transitions, and cancellation. ".repeat(
		3,
	)}Include the final state transition.`;
	snapshot.dispatchRows = snapshot.dispatchRows.flatMap((row) => [
		{ ...row, taskSummary: task },
		{ ...row, runId: "second-scout", taskSummary: "Inspect the dashboard telemetry." },
	]);
	const text = plain(renderDashboardPage(snapshot, "Activity", 160, 60, "alt+u"));
	match(text, /Include the final state transition\./);
	match(text, /Inspect the dashboard telemetry\./);
	match(text, /Tokens.*68k input.*2k output/);
	match(text, /Work.*context 17k \/ 262\.1k/);
	doesNotMatch(text, /│/);
});

test("Activity retains fast tool actions between calls and shows live worker output", () => {
	const snapshot = state();
	const progress = createWorkerProgressFold();
	const render = () => {
		snapshot.dispatchRows = snapshot.dispatchRows.map((row) => ({ ...row, progress: progress.snapshot() }));
		return plain(renderDashboardPage(snapshot, "Activity", 160, 60, "alt+u"));
	};
	progress.observe({
		type: "clio_coder_tool_start",
		payload: {
			tool: "read",
			toolCallId: "read1",
			action: { verb: "reading", object: "src/interactive/overlays/ask-user.ts" },
		},
	});
	match(render(), /Now.*Executing tool/);
	progress.observe({ type: "clio_coder_tool_finish", payload: { tool: "read", toolCallId: "read1" } });
	match(render(), /Recent.*ask-user\.ts/);
	match(render(), /awaiting next worker event/);
	progress.observe({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning must never render" },
	});
	match(render(), /Now.*Thinking/);
	doesNotMatch(render(), /private reasoning/);
	progress.observe({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "Found the question navigation handlers." },
	});
	match(render(), /Now.*Streaming response/);
	match(render(), /Found the question navigation handlers/);
	match(render(), /Live response · provisional/);
});

test("compact footer exposes activity, headroom and workspace in three bounded rows", () => {
	for (const width of [40, 80, 160]) {
		const rows = renderCompactDashboard(state(), width);
		strictEqual(rows.length, 3);
		ok(rows.every((row) => visibleWidth(row) <= width));
	}
	const text = plain(renderCompactDashboard(state(), 160));
	match(text, /exploring.*1 agent active/);
	match(text, /CONTEXT.*available/);
	match(text, /dashboard/);
	match(text, /v050.*auto-edit.*70k processed/);
});

test("Status renders live configured harness limits without exposing arbitrary settings", () => {
	const footer = buildFooterDashboard({
		providers: { list: () => [] } as never,
		resolveCurrentBranch: async () => null,
		getTerminalColumns: () => 172,
		getTerminalRows: () => 75,
		getSettings: () => DEFAULT_SETTINGS,
	});
	try {
		for (let i = 0; i < 3; i++) footer.toggleExpanded();
		const text = plain(footer.view.render(172));
		match(text, /PERMISSIONS & LIMITS/);
		match(text, /Worker approvals/);
		match(text, /tracked pricing only/);
		match(text, /EXECUTION & CONTEXT POLICY/);
		match(text, /Fleet concurrency/);
		match(text, /Working set/);
		match(text, /Stream deadlines/);
	} finally {
		footer.dispose();
	}
});

test("Context dashboard shares the overlay category swatches and filled/free/reserve grid", () => {
	const snapshot = state();
	const ledger = snapshot.context.ledger;
	ok(ledger);
	const theme = clioTheme();
	const rows = renderDashboardPage(snapshot, "Context", 172, 75, "alt+u");
	const ansi = rows.join("\n");
	for (const group of ledger.meter.filter((group) => group.tokens > 0)) {
		ok(ansi.includes(contextCategorySwatch(group.category, theme)));
	}
	for (const row of renderContextMeterGrid(ledger, 64, 10, theme)) ok(ansi.includes(row));
	match(plain(rows), /Filled = context.*empty = available.*shaded = reserve/);
});
