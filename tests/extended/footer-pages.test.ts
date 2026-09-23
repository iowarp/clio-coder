import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createWorkerProgressFold } from "../../src/domains/observability/worker-progress.js";
import { buildContextLedger } from "../../src/domains/session/context-ledger.js";
import { getKeybindings, setKeybindings, stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { contextCategorySwatch, renderContextMeterGrid } from "../../src/interactive/context-meter.js";
import { buildFooterDashboard, type FooterDashboardRenderState } from "../../src/interactive/footer/dashboard.js";
import { footerKeyHint } from "../../src/interactive/footer/key-hints.js";
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
	const activity = plain(renderDashboardPage(state(), "Activity", 172, 120, "Alt+U"));
	match(activity, /Scout/);
	match(activity, /internal agent/);
	match(activity, /Explore the dispatch/);
	match(activity, /context 17k/);
	match(activity, /blade\/mini\/qwopus/);
	const context = plain(renderDashboardPage(state(), "Context", 172, 120, "Alt+U"));
	match(context, /CONTEXT COMPOSITION/);
	match(context, /Estimated usage/);
	const status = plain(renderDashboardPage(state(), "Status", 172, 120, "Alt+U"));
	match(status, /COST & CONNECTIONS/);
	match(status, /LOCAL MACHINE/);
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

test("the footer composes at the width a frame renders it, so a resize never stacks rows fitted to the old width", () => {
	let columns = 120;
	const footer = buildFooterDashboard({
		providers: { list: () => [] } as never,
		resolveCurrentBranch: async () => null,
		getTerminalColumns: () => columns,
		getTerminalRows: () => 40,
	});
	try {
		strictEqual(footer.view.render(120).length, 2);
		// The first frame after a resize renders before the footer's next refresh.
		columns = 40;
		const narrow = footer.view.render(40);
		strictEqual(narrow.length, 2, plain(narrow));
		for (const row of narrow) ok(visibleWidth(row) <= 40, row);
		deepStrictEqual(footer.view.render(40), narrow, "a repeat frame at the same width reuses the rows");
	} finally {
		footer.dispose();
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
	const text = plain(renderDashboardPage(snapshot, "Activity", 160, 120, "alt+u"));
	match(text, /Read the interview implementation/);
	match(text, /Inspect the dashboard telemetry\./);
	match(text, /Tokens.*68k input.*2k output/);
	match(text, /Work.*context 17k \/ 262\.1k/);
});

test("Activity retains fast tool actions between calls and shows live worker output", () => {
	const snapshot = state();
	const progress = createWorkerProgressFold();
	const render = () => {
		snapshot.dispatchRows = snapshot.dispatchRows.map((row) => ({ ...row, progress: progress.snapshot() }));
		return plain(renderDashboardPage(snapshot, "Activity", 160, 120, "alt+u"));
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

test("compact footer exposes activity, headroom and inference identity in two bounded dynamic rows", () => {
	for (const width of [40, 80, 160]) {
		const rows = renderCompactDashboard(state(), width);
		strictEqual(rows.length, 2);
		ok(rows.every((row) => visibleWidth(row) <= width));
	}
	const text = plain(renderCompactDashboard(state(), 160));
	match(text, /exploring/);
	match(text, /1 active/);

	match(text, /262.1k/);
	match(text, /clio-coder.*v050/);
	match(text, /think/);
	doesNotMatch(text, /auto-edit|70k processed|standard/);
});

test("Status renders live resource telemetry instead of a configuration dump", () => {
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
		match(text, /COST & CONNECTIONS/);
		match(text, /LOCAL MACHINE/);
		match(text, /Clio RSS/);
		match(text, /RAM/);
		match(text, /GPU/);
		match(text, /Subscriptions.*loading/);
		match(text, /Clio ceiling/);
		doesNotMatch(text, /Worker approvals|PERMISSIONS & LIMITS/);
	} finally {
		footer.dispose();
	}
});

test("Context dashboard shares the overlay category swatches and filled/free/reserve grid", () => {
	const snapshot = state();
	const ledger = snapshot.context.ledger;
	ok(ledger);
	const theme = clioTheme();
	const rows = renderDashboardPage(snapshot, "Context", 172, 120, "alt+u");
	const ansi = rows.join("\n");
	for (const group of ledger.meter.filter((group) => group.tokens > 0)) {
		ok(ansi.includes(contextCategorySwatch(group.category, theme)));
	}
	for (const row of renderContextMeterGrid(ledger, 64, 8, theme)) ok(ansi.includes(row));
	match(plain(rows), /Filled = context.*empty = available.*shaded = reserve/);
});

test("finished agents collapse into bounded history while retries retain live cards", () => {
	const snapshot = state();
	const row = snapshot.dispatchRows[0];
	ok(row);
	snapshot.dispatchRows = [
		{ ...row, status: "retrying", runId: "retry", taskSummary: "Active retry task" },
		...Array.from({ length: 8 }, (_, index) => ({
			...row,
			status: "completed" as const,
			runId: `done-${index}`,
			taskSummary: "Historical verbose task must not render",
		})),
	];
	const text = plain(renderDashboardPage(snapshot, "Activity", 160, 120, "alt+u"));
	match(text, /Active retry task/);
	match(text, /INVOCATION HISTORY · 8 finished/);
	match(text, /Scout · completed.*internal.*1[2]s.*↑68k ↓2k/);
	match(text, /4 more finished runs/);
	doesNotMatch(text, /Historical verbose task/);
	snapshot.dispatchRows = [{ ...row, status: "failed", outcomeDetail: "result_contract_exhausted" }];
	const settled = plain(renderDashboardPage(snapshot, "Activity", 86, 75, "alt+u"));
	match(settled, /No agents running/);
	match(settled, /Scout · failed/);
	match(settled, /result_contract_exhausted.*\/view dispatch:scout-run/);
	doesNotMatch(settled, /AGENT ACTIVITY|Task |Recent |Worker output|Budget /);
});

test("expanded pages have identical viewport-relative height across widths and lifecycle changes", () => {
	for (const width of [40, 86, 160])
		for (const height of [24, 40, 75, 93]) {
			const snapshot = state();
			for (const page of DASHBOARD_PAGES) {
				const rows = renderDashboardPage(snapshot, page, width, height, "alt+u");
				strictEqual(rows.length, Math.max(8, Math.floor(height / 4)));
				ok(rows.every((row) => visibleWidth(row) <= width));
			}
			snapshot.dispatchRows = [];
			strictEqual(
				renderDashboardPage(snapshot, "Activity", width, height, "alt+u").length,
				Math.max(8, Math.floor(height / 4)),
			);
		}
});

test("compact notice borrows a row then expires without changing height", () => {
	const snapshot = state();
	snapshot.notices = [{ id: "n", text: "Worker finished", level: "info", key: null, addedAt: 11000, expiresAt: 13000 }];
	const before = renderCompactDashboard(snapshot, 100);
	strictEqual(before.length, 2);
	match(plain(before), /Worker finished/);
	snapshot.now = 14000;
	const after = renderCompactDashboard(snapshot, 100);
	strictEqual(after.length, 2);
	doesNotMatch(plain(after), /Worker finished/);
	match(plain(after), /newline|send|Library|Model|Thinking|queue|Dashboard/i);
});

test("demo tips borrow the compact footer row and yield to operational notices", () => {
	const input = state();
	input.notices = [];
	input.demoHint = "Explore /help · guidance in /settings";
	const rows = renderCompactDashboard(input, 80).map(stripTerminalSequences);
	strictEqual(rows.length, 2);
	match(rows[1] ?? "", /Tip.*Explore \/help/);
	input.notices = [
		{ id: "demo-priority", text: "Permission needed", level: "warning", key: null, addedAt: input.now, expiresAt: null },
	];
	match(plain(renderCompactDashboard(input, 80)), /Permission needed/);
	doesNotMatch(plain(renderCompactDashboard(input, 80)), /Tip/);
	input.notices = [];
	input.demoHint = null;
	doesNotMatch(renderCompactDashboard(input, 80).map(stripTerminalSequences).join("\n"), /Tip/);
});

test("footer hints resolve remapped bindings and omit unbound actions", () => {
	const previous = getKeybindings();
	createKeybindingManager({
		...DEFAULT_SETTINGS,
		interface: {
			...DEFAULT_SETTINGS.interface,
			keybindings: {
				"clio-coder.model.select": "ctrl+m",
				"clio-coder.library.toggle": [],
			},
		},
	});
	try {
		const hints = Array.from({ length: 40 }, (_, i) => footerKeyHint(i * 12000)).join("\n");
		match(hints, /ctrl\+m Model picker/);
		doesNotMatch(hints, /alt\+m|alt\+l|Library/);
		match(hints, /newline/);
		match(hints, /Thinking effort/);
		match(hints, /Send after the active run/);
	} finally {
		setKeybindings(previous);
	}
});

test("worker cards and Status distinguish shared account limits from recorded session usage", () => {
	const snapshot = state();
	snapshot.quota = [
		{
			providerId: "claude-code",
			displayName: "Claude Code",
			status: "ok",
			plan: "Max",
			windows: [{ key: "weekly", label: "Weekly", usedPct: 91, resetsAt: null }],
			fetchedAt: null,
		},
	];
	snapshot.dispatchRows = snapshot.dispatchRows.map((row) => ({
		...row,
		runtimeId: "claude-code",
		runtimeKind: "subprocess",
	}));
	match(plain(renderDashboardPage(snapshot, "Activity", 160, 120, "alt+u")), /Account.*Shared Claude Code.*9% left/);
	const status = plain(renderDashboardPage(snapshot, "Status", 160, 120, "alt+u"));
	match(status, /SESSION.*recorded tokens/);
	match(status, /Claude Code.*Weekly 91%/);
	match(plain(renderDashboardPage(snapshot, "Context", 160, 120, "alt+u")), /subscription limits are account-wide/);
});

test("compact quota stays beside the selected model while workspace and rotating hints remain visible", () => {
	const snapshot = state();
	snapshot.workspace.dirty = true;
	snapshot.quotaRoute = { runtimeId: "claude-code", wireModelId: "claude-opus" };
	snapshot.session.target = "Claude · claude-opus";
	snapshot.quota = [
		{
			providerId: "claude-code",
			displayName: "Claude Code",
			status: "ok",
			fetchedAt: null,
			windows: [
				{ key: "session", label: "5h", usedPct: 7, resetsAt: null },
				{ key: "weekly", label: "Weekly", usedPct: 9, resetsAt: null },
			],
		},
		{
			providerId: "codex",
			displayName: "Codex",
			status: "ok",
			fetchedAt: null,
			windows: [{ key: "weekly", label: "Weekly", usedPct: 77, resetsAt: null }],
		},
	];
	for (const width of [80, 120, 160]) {
		const rows = renderCompactDashboard(snapshot, width).map(stripTerminalSequences);
		match(rows[0] ?? "", /weekly 91% left/);
		doesNotMatch(rows[0] ?? "", /Codex|5h/);
		match(rows[1] ?? "", /clio-coder.*v050 \*/);
		doesNotMatch(rows[1] ?? "", /weekly|Claude|Codex/);
		ok(rows.every((line) => visibleWidth(line) <= width));
	}
	const initial = plain(renderCompactDashboard(snapshot, 160));
	snapshot.now += 12000;
	ok(plain(renderCompactDashboard(snapshot, 160)) !== initial);
	for (let page = 0; page < 40; page++) {
		snapshot.now = page * 12000;
		match(stripTerminalSequences(renderCompactDashboard(snapshot, 160)[1] ?? ""), /clio-coder.*v050 \*/);
		ok(footerKeyHint(snapshot.now));
	}
	snapshot.session.shutdownArmed = true;
	match(plain(renderCompactDashboard(snapshot, 100)), /clio-coder.*v050 \*.*Ctrl\+C again/);
	match(plain(renderCompactDashboard(snapshot, 40)), /Ctrl\+C again to quit/u);
	snapshot.quotaRoute = { runtimeId: "litellm", wireModelId: "claude-opus" };
	doesNotMatch(plain(renderCompactDashboard(snapshot, 160)), /weekly/);
});

test("the compact footer names an armed skill surface beside the activity, unpadded, until it clears", () => {
	const snapshot = state();
	snapshot.session.target = "blade · dynamo/qwopus3.8-27b-flash@q4_k_m";
	const line = (width: number) => stripTerminalSequences(renderCompactDashboard(snapshot, width)[0] ?? "");
	for (const width of [60, 100, 200]) doesNotMatch(line(width), /skill|§/u);
	snapshot.session.activeSkills = ["tdd"];
	for (const width of [100, 200]) match(line(width), /^exploring · 1 active · skill tdd {2}· {2}blade/u);
	for (const width of [60, 100, 200]) {
		match(line(width), /^exploring · 1 active · skill tdd\b/u);
		ok(visibleWidth(line(width)) <= width);
	}
	// At 60 columns the whole activity and the badge leave no readable room for the identity.
	doesNotMatch(line(60), /blade/u);
	// Narrow: the knowledge mark stands in for the word, and an identity with
	// no room left is dropped rather than cut to a stub.
	snapshot.session.activeSkills = ["tdd", "perf-review"];
	for (const width of [40, 60]) {
		const row = line(width);
		match(row, /§ tdd/u);
		doesNotMatch(row, /……|skill t…/u);
		ok(visibleWidth(row) <= width, row);
	}
	match(line(40), /§ tdd… +▰/u, "no room for the identity at 40 columns, so the meter follows the badge");
	// The mark form is never padded out to the badge's budget.
	snapshot.session.activeSkills = ["tdd-go"];
	const { statusText, dispatchRows } = { statusText: snapshot.agent.statusText, dispatchRows: snapshot.dispatchRows };
	snapshot.agent.statusText = "Ready";
	snapshot.dispatchRows = [];
	match(line(60), /^Ready · § tdd-go {2}· {2}blade/u);
	snapshot.agent.statusText = statusText;
	snapshot.dispatchRows = dispatchRows;
	snapshot.session.activeSkills = [];
	doesNotMatch(line(100), /skill|§/u);
});

test("a narrow compact footer keeps the meter's percent whole, the activity whole, and no identity stub", () => {
	const snapshot = state();
	snapshot.agent.statusText = "Writing · 3s";
	const line = (width: number) => stripTerminalSequences(renderCompactDashboard(snapshot, width)[0] ?? "");
	// The context engine's budget meter, as the live footer reads it: a segmented bar with its percent.
	snapshot.context = {
		...snapshot.context,
		ledger: undefined,
		budget: { inputSource: "estimated" },
		used: 33_900,
		contextWindow: 262_144,
		systemPromptTokens: 3_700,
		toolSchemaTokens: 8_200,
		messageTokens: 22_000,
	} as unknown as FooterDashboardRenderState["context"];
	for (const width of [40, 60]) {
		const row = line(width);
		ok(visibleWidth(row) <= width, row);
		// Counts that do not fit are dropped; the percent is never cut.
		match(row, / {2}\d+\.\d%$/u, row);
		doesNotMatch(row, /~|\d…|\/ /u, row);
		// The activity is whole; a row too narrow for the worker count drops it rather than cut it.
		match(row, width === 60 ? /^Writing · 3s · 1 active\b/u : /^Writing · 3s +▰/u, row);
		// An identity is readable or absent, never a stub like `bla…_k_m`.
		const identity = / {2}· {2}(.+?)(?: · think| {3})/u.exec(row)?.[1];
		ok(identity === undefined || visibleWidth(identity) >= 12, row);
	}
	match(line(100), /12\.\d% {2}~33\.9k \/ 262\.1k$/u);
	// The ledger meter states counts alone, so a narrow row states its percent instead.
	const ledgerSnapshot = state();
	const narrow = stripTerminalSequences(renderCompactDashboard(ledgerSnapshot, 40)[0] ?? "");
	match(narrow, /▒ \d+\.\d%$/u, narrow);
	match(stripTerminalSequences(renderCompactDashboard(ledgerSnapshot, 100)[0] ?? ""), /68\.5k \/ 262\.1k$/u);
});

test("the footer spinner and live elapsed change once per animation step, not once per refresh", () => {
	let now = 10_000;
	const footer = buildFooterDashboard({
		providers: { list: () => [] } as never,
		resolveCurrentBranch: async () => null,
		getTerminalColumns: () => 120,
		getTerminalRows: () => 40,
		now: () => now,
		getAgentStatus: () => ({
			phase: "writing",
			since: 8_000,
			lastMeaningfulAt: now,
			watchdogTier: 0,
			watchdogPeak: 0,
			localRuntime: false,
		}),
	});
	try {
		const line = () => footer.view.render(120)[0] ?? "";
		footer.refresh();
		const first = line();
		match(stripTerminalSequences(first), /Writing · 2s/);
		// The status stream and the ticker both refresh; inside one step neither moves anything.
		now = 10_050;
		footer.refresh();
		footer.refresh();
		strictEqual(line(), first);
		now = 10_130;
		footer.refresh();
		ok(line() !== first, "the next step advances the spinner");
		match(stripTerminalSequences(line()), /Writing · 2s/);
	} finally {
		footer.dispose();
	}
});
