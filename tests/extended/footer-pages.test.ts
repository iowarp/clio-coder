import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { buildContextLedger } from "../../src/domains/session/context-ledger.js";
import { createWorkerProgressFold } from "../../src/domains/telemetry/worker-progress.js";
import { getKeybindings, setKeybindings, stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import type { FooterDashboardRenderState } from "../../src/interactive/footer/dashboard.js";
import { buildFooterDashboard } from "../../src/interactive/footer/dashboard.js";
import { footerKeyHint } from "../../src/interactive/footer/key-hints.js";
import { dashboardPageViewport, renderCompactDashboard } from "../../src/interactive/footer/pages.js";
import { footerTelemetry } from "../../src/interactive/footer/spend.js";
import { createKeybindingManager } from "../../src/interactive/keybinding-manager.js";
import {
	renderToolExecution,
	renderToolPreview,
	renderToolSubline,
} from "../../src/interactive/renderers/tool-execution.js";
import { transcriptDetail } from "../../src/interactive/transcript-detail.js";
import { runUsageOf, telemetryViewOf } from "../harness/telemetry-view.js";

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
		usage: runUsageOf("scout-run", [{ usage: { input: 68000, output: 2000 }, usd: null }]),
		ttft: "300ms",
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
			target: "blade · dynamo/qwopus3.8-27b-flash@q4_k_m",
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
		telemetry: footerTelemetry(telemetryViewOf("fixture-session", [])),
		tick: 0,
		now: 12000,
	};
}
const plain = (rows: string[]) => rows.map(stripTerminalSequences).join("\n");
/** The dashboard is one fixed glance panel; it never scrolls, so one render holds every row it shows. */
function page(snapshot: FooterDashboardRenderState, width: number, rows: number): string[] {
	return dashboardPageViewport(snapshot, width, rows, "Alt+U");
}

test("the dashboard is one glance panel: turn, session and fleet blocks and where the detail lives", () => {
	for (const width of [40, 80, 120, 172]) {
		const rows = page(state(), width, 40);
		ok(
			rows.every((line) => visibleWidth(line) <= width),
			`${width}`,
		);
		strictEqual(rows.length, 6, `${width}: standard is four content rows between two rules`);
		match(plain(rows), /Alt\+U/);
		doesNotMatch(plain(rows), /Alt\+PgUp|of \d+ rows/);
	}
	const glance = plain(page(state(), 172, 120));
	match(glance, /^Dashboard ─/);
	match(glance, /fleet +● 1 running/);
	match(glance, /● ◆ ↳ scout +12s +Explore the dispatch/);
	doesNotMatch(glance, /context 17k/);
	match(glance, /context +▰.*68\.5k\/262k 26%/);
	match(glance, /limit +unknown/);
	doesNotMatch(glance, /Connections ─|Machine ─|Composition/);
	match(glance, /\[Alt\+U\] close · \/usage · \/context · \/fleet ─$/);
});

test("the resolved dashboard shortcut opens the page and closes it again without capturing text", () => {
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
		const modes = [footer.toggleExpanded()];
		const text = plain(footer.view.render(120));
		match(text, /Dashboard/);
		match(text, /\[Ctrl\+U\] close/);
		modes.push(footer.toggleExpanded());
		deepStrictEqual(modes, ["open", "closed"]);
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
		strictEqual(narrow.length, 1, plain(narrow));
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
		// Arguments the row does not consume leave the header; detailed states them as the card's `args` row.
		(style === "detailed" ? match : doesNotMatch)(text, /offset.*40/);
		(style === "detailed" ? match : doesNotMatch)(text, /limit.*80/);
		match(plain(renderToolExecution(call, 100)), /path.*README.md/);
		const long = { ...call, args: { path: `${"directory/".repeat(12)}final.ts` } };
		// Compact is the action row alone, so a cut path keeps its tail there and
		// the full path stays in inspection; the other styles add a `path ›` row.
		match(
			plain(renderToolPreview(long, 100, transcriptDetail(style))),
			style === "compact" ? /▸ read …\/(?:directory\/)+final\.ts ✓/ : /path/,
		);
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
	const text = plain(page(snapshot, 160, 120));
	match(text, /scout +12s +Read the interview/);
	match(text, /scout +12s +Inspect the dashboard telemetry\./);
	doesNotMatch(text, /Work.*context 17k \/ 262\.1k/);
});

test("the dashboard keeps its height while a worker streams and leaves live worker output to /fleet", () => {
	const snapshot = state();
	const progress = createWorkerProgressFold();
	const render = () => {
		snapshot.dispatchRows = snapshot.dispatchRows.map((row) => ({ ...row, progress: progress.snapshot() }));
		const rows = page(snapshot, 160, 120);
		strictEqual(rows.length, 6);
		return plain(rows);
	};
	progress.observe({
		type: "clio_coder_tool_start",
		payload: {
			tool: "read",
			toolCallId: "read1",
			action: { verb: "reading", object: "src/interactive/overlays/ask-user.ts" },
		},
	});
	match(render(), /● ◆ ↳ scout +12s +Explore the dispatch/);
	progress.observe({ type: "clio_coder_tool_finish", payload: { tool: "read", toolCallId: "read1" } });
	progress.observe({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning must never render" },
	});
	doesNotMatch(render(), /private reasoning/);
	progress.observe({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "Found the question navigation handlers." },
	});
	doesNotMatch(render(), /Found the question navigation handlers|Live response/);
});

test("the footer exposes workspace, model identity and worker count in bounded rows of the tier's height", () => {
	for (const width of [40, 80, 160]) {
		const rows = renderCompactDashboard(state(), width);
		// Standard is the status line and the hint row; a W1 width keeps the status line alone.
		strictEqual(rows.length, width < 44 ? 1 : 2);
		ok(rows.every((row) => visibleWidth(row) <= width));
	}
	const idle = state();
	idle.dispatchRows = [];
	strictEqual(renderCompactDashboard(idle, 40).length, 1, "a narrow idle footer is one row");
	const text = plain(renderCompactDashboard(state(), 160));
	match(text, /1 worker/);
	match(text, /^>C_ /);
	// Context fill is the rail's; the status line never repeats it.
	doesNotMatch(text, /262\.1K/);
	match(text, /clio-coder.*v050/);
	doesNotMatch(text, /think/u);
	doesNotMatch(text, /autonomy|yolo|70k processed|standard|exploring/);
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
	const rows = page(snapshot, 160, 120);
	strictEqual(rows.length, 6, "nine runs never grow the panel");
	const text = plain(rows);
	// Counts worst first: a settled run with no verified record is never ok (6.1).
	match(text, /fleet +! 8 unverified · ● 1/);
	strictEqual(
		text.split("\n").filter((line) => /[!●✓] ◆ ↳ scout/u.test(line)).length,
		3,
		"the fleet block holds three run rows",
	);
	snapshot.dispatchRows = [{ ...row, status: "failed", outcomeDetail: "result_contract_exhausted" }];
	const settled = plain(page(snapshot, 86, 75));
	match(settled, /fleet +✗ 1 failed/);
	doesNotMatch(settled, /AGENT ACTIVITY|Task |Recent |Worker output|Budget /);
	const wide = plain(page(snapshot, 160, 75));
	match(wide, /✗ ◆ ↳ scout +12s +result_contract_exhausted/);
});

test("the dashboard has the tier's height, reduced to a third of the terminal, across widths and lifecycle changes", () => {
	for (const width of [40, 86, 160])
		for (const height of [12, 15, 24, 40, 75, 93]) {
			const snapshot = state();
			const expected = Math.max(3, Math.min(6, Math.floor(height / 3)));
			const rows = page(snapshot, width, height);
			strictEqual(rows.length, expected);
			ok(rows.every((row) => visibleWidth(row) <= width));
			snapshot.dispatchRows = [];
			strictEqual(page(snapshot, width, height).length, expected);
		}
});

test("a compact notice takes its own row above the hints, then leaves when it expires", () => {
	const snapshot = state();
	snapshot.notices = [{ id: "n", text: "Worker finished", level: "info", key: null, addedAt: 11000, expiresAt: 13000 }];
	const before = renderCompactDashboard(snapshot, 100);
	strictEqual(before.length, 3);
	match(plain(before), /Worker finished/);
	match(stripTerminalSequences(before[2] ?? ""), /newline|send|Library|Model|Thinking|queue|Dashboard/i);
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

test("turning demo guidance off drops the learning hints from the hint slot", () => {
	const input = state();
	input.notices = [];
	input.demoHint = null;
	input.demo = false;
	const hint = renderCompactDashboard(input, 100).map(stripTerminalSequences)[1] ?? "";
	doesNotMatch(hint, /\? Keys|newline|send|Dashboard/i);
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
		const hints = Array.from({ length: 40 }, (_, i) =>
			footerKeyHint(i * 60000, false, Number.POSITIVE_INFINITY, "idle"),
		).join("\n");
		match(hints, /Ctrl\+M model(?! picker)/);
		doesNotMatch(hints, /Alt\+M|Alt\+L|Library/);
		match(hints, /\? keys · \/ commands/);
		const runHints = Array.from({ length: 40 }, (_, i) =>
			footerKeyHint(i * 60000, false, Number.POSITIVE_INFINITY, "steer"),
		).join("\n");
		match(runHints, /send now/);
	} finally {
		setKeybindings(previous);
	}
});

test("idle keeps its pinned keys while a key the operator already pressed leaves the run's learning rotation", () => {
	const previous = getKeybindings();
	createKeybindingManager(DEFAULT_SETTINGS);
	try {
		const rotation = (context: "idle" | "steer", learned: (feature: string) => boolean) =>
			Array.from({ length: 40 }, (_, i) =>
				footerKeyHint(i * 60000, false, Number.POSITIVE_INFINITY, context, { learned }),
			).join("\n");
		const fresh = rotation("idle", () => false);
		match(fresh, /\? keys · \/ commands · Alt\+M model/);
		// Idle is the same three keys whatever the operator learned; the row teaches nothing more there.
		const learned = rotation("idle", (feature) => feature === "?" || feature === "key:clio-coder.thinking.cycle");
		match(learned, /\? keys · \/ commands · Alt\+M model/);
		doesNotMatch(learned, /thinking/i);
		match(
			rotation("steer", () => false),
			/send now/,
		);
		doesNotMatch(
			rotation("steer", (feature) => feature === "key:clio-coder.message.interrupt"),
			/send now/,
		);
	} finally {
		setKeybindings(previous);
	}
});

test("worker cards and Status distinguish shared account limits from recorded session usage", () => {
	const snapshot = state();
	snapshot.quota = [
		{
			provider: "claude-code",
			credentials: ["claude-code"],
			displayName: "claude-code",
			status: "ok",
			plan: null,
			credits: null,
			message: null,
			retryAfter: null,
			pool: null,
			access: "unknown",
			overage: "unknown",
			resetsAt: null,
			validUntil: null,
			source: "poll",
			stale: false,
			windows: [
				{
					key: "weekly",
					scope: null,
					label: "Weekly",
					usedPct: { fact: { kind: "measured", value: 91, source: "provider" }, display: "91%" },
					resetsAt: null,
					unit: null,
					durationSeconds: null,
					access: "unknown",
				},
			],
			observedAt: null,
		},
	];
	snapshot.dispatchRows = snapshot.dispatchRows.map((row) => ({
		...row,
		runtimeId: "claude-code",
		runtimeKind: "subprocess",
	}));
	// A worker's shared account is a run fact for Fleet Runs; the glance panel keeps the session's own limit.
	const glance = plain(page(snapshot, 160, 120));
	match(glance, /limit +unknown/);
	doesNotMatch(glance, /Shared claude-code/);
});

test("compact quota stays beside the selected model while workspace and rotating hints remain visible", () => {
	const snapshot = state();
	snapshot.workspace.dirty = true;
	snapshot.quotaRoute = { runtimeId: "claude-code", wireModelId: "claude-opus" };
	snapshot.session.target = "Claude · claude-opus";
	snapshot.quota = [
		{
			provider: "claude-code",
			credentials: ["claude-code"],
			displayName: "claude-code",
			status: "ok",
			plan: null,
			credits: null,
			message: null,
			retryAfter: null,
			pool: null,
			access: "unknown",
			overage: "unknown",
			resetsAt: null,
			validUntil: null,
			source: "poll",
			stale: false,
			observedAt: null,
			windows: [
				{
					key: "session",
					scope: null,
					label: "5h",
					usedPct: { fact: { kind: "measured", value: 7, source: "provider" }, display: "7%" },
					resetsAt: null,
					unit: null,
					durationSeconds: null,
					access: "unknown",
				},
				{
					key: "weekly",
					scope: null,
					label: "Weekly",
					usedPct: { fact: { kind: "measured", value: 9, source: "provider" }, display: "9%" },
					resetsAt: null,
					unit: null,
					durationSeconds: null,
					access: "unknown",
				},
			],
		},
		{
			provider: "codex",
			credentials: ["codex"],
			displayName: "codex",
			status: "ok",
			plan: null,
			credits: null,
			message: null,
			retryAfter: null,
			pool: null,
			access: "unknown",
			overage: "unknown",
			resetsAt: null,
			validUntil: null,
			source: "poll",
			stale: false,
			observedAt: null,
			windows: [
				{
					key: "weekly",
					scope: null,
					label: "Weekly",
					usedPct: { fact: { kind: "measured", value: 77, source: "provider" }, display: "77%" },
					resetsAt: null,
					unit: null,
					durationSeconds: null,
					access: "unknown",
				},
			],
		},
	];
	for (const width of [80, 120, 160]) {
		const rows = renderCompactDashboard(snapshot, width).map(stripTerminalSequences);
		// The weekly window rides the status line beside the route while it fits, and is the first fact to drop;
		// the hint row holds keys only.
		if (width >= 120) match(rows[0] ?? "", /weekly 9% used/);
		doesNotMatch(rows.join("\n"), /Codex|5h/);
		match(rows[0] ?? "", /clio-coder.*v050\*/);
		doesNotMatch(rows[1] ?? "", /weekly|Claude|Codex/);
		ok(rows.every((line) => visibleWidth(line) <= width));
	}
	const initial = plain(renderCompactDashboard(snapshot, 160));
	match(initial, /Enter send/);
	for (let page = 0; page < 40; page++) {
		snapshot.now = page * 12000;
		match(stripTerminalSequences(renderCompactDashboard(snapshot, 160)[0] ?? ""), /clio-coder.*v050\*/);
		ok(footerKeyHint(snapshot.now));
	}
	snapshot.session.shutdownArmed = true;
	match(plain(renderCompactDashboard(snapshot, 100)), /clio-coder.*v050\*[\s\S]*Ctrl\+C again/);
	match(plain(renderCompactDashboard(snapshot, 40)), /Ctrl\+C again to quit/u);
	snapshot.quotaRoute = { runtimeId: "litellm", wireModelId: "claude-opus" };
	doesNotMatch(plain(renderCompactDashboard(snapshot, 160)), /weekly/);
});

test("the status line names an armed skill surface beside the worker count until it clears", () => {
	const snapshot = state();
	snapshot.session.modelId = "qwopus";
	const facts = (width: number) => stripTerminalSequences(renderCompactDashboard(snapshot, width)[0] ?? "");
	for (const width of [60, 100, 200]) doesNotMatch(facts(width), /skill|§/u);
	snapshot.session.activeSkills = ["tdd"];
	for (const width of [60, 100, 200]) {
		// The fact drops whole before anything the status line owns, so 60 cells keep the workspace instead.
		if (width >= 100) match(facts(width), /skill tdd · 1 worker/u);
		ok(visibleWidth(facts(width)) <= width);
	}
	// The skill names take at most a third of the row; what does not fit ends in one ellipsis, and a row too narrow
	// for the fact drops it whole before the worker count.
	snapshot.session.activeSkills = ["tdd", "perf-review"];
	for (const width of [40, 60, 100]) {
		const row = facts(width);
		match(row, /1 worker/u);
		doesNotMatch(row, /……|skil(?!l)/u);
		ok(visibleWidth(row) <= width, row);
	}
	match(facts(100), /skill tdd, perf-review · 1 worker/u);
	snapshot.dispatchRows = [];
	snapshot.session.activeSkills = ["tdd-go"];
	match(facts(100), /skill tdd-go · qwopus$/u);
	snapshot.session.activeSkills = [];
	doesNotMatch(facts(100), /skill|§/u);
});

test("a narrow status line leaves the context counts to the rail and never cuts a figure", () => {
	const snapshot = state();
	// A short model id, so the only identifier the row could elide is not in the way of the figure check.
	snapshot.session.modelId = "qwopus";
	const line = (width: number) => stripTerminalSequences(renderCompactDashboard(snapshot, width)[0] ?? "");
	// The context engine's budget meter, as the live footer reads it: counts with a percent.
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
		doesNotMatch(row, /\d…/u, row);
	}
	// The bottom rail owns context fill (4.1); the status line states none of it at any width.
	for (const width of [40, 60, 100]) doesNotMatch(line(width), /33\.9K|262\.1K|%/u);
	const ledgerSnapshot = state();
	for (const width of [40, 100])
		doesNotMatch(stripTerminalSequences(renderCompactDashboard(ledgerSnapshot, width)[0] ?? ""), /68\.5K|262\.1K|%/u);
});

test("the compact footer holds still across refreshes and carries no activity spinner", () => {
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
		footer.refresh();
		const first = footer.view.render(120).join("\n");
		// The composer rail owns the working spinner and elapsed time; the footer never repaints for them.
		doesNotMatch(stripTerminalSequences(first), /Writing|\d+s\b/u);
		now = 10_130;
		footer.refresh();
		strictEqual(footer.view.render(120).join("\n"), first);
	} finally {
		footer.dispose();
	}
});

test("the compact footer shows the most severe live notice with its level glyph at every width", () => {
	for (const width of [60, 80, 120, 200]) {
		const snapshot = state();
		const rows = renderCompactDashboard(
			{
				...snapshot,
				notices: [
					{ id: "e", level: "error", text: "provider down", key: null, addedAt: snapshot.now - 5_000, expiresAt: null },
					{ id: "i", level: "info", text: "saved", key: null, addedAt: snapshot.now - 10, expiresAt: snapshot.now + 9_000 },
				],
			},
			width,
		);
		const text = plain(rows);
		match(text, /✗ provider/u, `${width}`);
		doesNotMatch(text, /saved|•/u, `${width}`);
		for (const row of rows) ok(visibleWidth(row) <= width, `${width}: ${stripTerminalSequences(row)}`);
	}
});

test("visible welcome owns idle teaching while the footer preserves operational notices", () => {
	const input = state();
	input.welcomeVisible = true;
	input.demoHint = null;
	const idle = renderCompactDashboard(input, 100).map(stripTerminalSequences)[1] ?? "";
	doesNotMatch(idle, /Dashboard|newline|send|Model|Thinking|Library|Explore/iu);
	// The one tip the demo hints chose for a launchpad without its own hint column still speaks.
	input.demoHint = "Explore /help";
	match(renderCompactDashboard(input, 100).map(stripTerminalSequences)[1] ?? "", /Tip Explore \/help/u);
	input.demoHint = null;
	input.notices = [
		{
			id: "welcome-priority",
			text: "Permission needed",
			level: "warning",
			key: null,
			addedAt: input.now,
			expiresAt: null,
		},
	];
	match(plain(renderCompactDashboard(input, 100)), /Permission needed/u);
	input.notices = [];
	input.welcomeVisible = false;
	input.demoHint = null;
	match(
		renderCompactDashboard(input, 100).map(stripTerminalSequences)[1] ?? "",
		/newline|send|Library|Model|Thinking|queue|Dashboard/iu,
	);
});
