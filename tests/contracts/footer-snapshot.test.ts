import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { it, test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { TelemetryView } from "../../src/domains/telemetry/contract.js";
import { getKeybindings, setKeybindings, stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { createFollowUpQueuePanel } from "../../src/interactive/follow-up-queue-panel.js";
import { buildFooterDashboard, capabilityLabels } from "../../src/interactive/footer/dashboard.js";
import { footerKeyHint } from "../../src/interactive/footer/key-hints.js";
import type { Notification } from "../../src/interactive/footer/notifications.js";
import { formatNotificationPanel } from "../../src/interactive/footer/notifications.js";
import { DASHBOARD_PAGES, renderCompactDashboard, renderDashboardPage } from "../../src/interactive/footer/pages.js";
import { dispatchSegment } from "../../src/interactive/footer-panel.js";
import { createKeybindingManager } from "../../src/interactive/keybinding-manager.js";
import { GLYPH } from "../../src/interactive/theme/index.js";
import { footerState } from "../harness/footer-fixture.js";
import { goldenTelemetryRecords, telemetryViewOf } from "../harness/telemetry-view.js";

test("unchanged footer refresh preserves rendered rows while changed state and width invalidate them", () => {
	let now = 10_000;
	let used = 100;
	const notices: Notification[] = [];
	const panel = buildFooterDashboard({
		providers: { list: () => [] } as never,
		resolveCurrentBranch: async () => null,
		getTerminalColumns: () => 120,
		getContextUsage: () => ({ tokens: used, contextWindow: 1000, percent: used / 10 }),
		now: () => now,
		getNotifications: () => notices,
		getAgentStatus: () => ({
			phase: "writing",
			since: 8000,
			lastMeaningfulAt: now,
			watchdogTier: 0,
			watchdogPeak: 0,
			localRuntime: false,
		}),
	});
	try {
		const first = panel.view.render(120);
		panel.refresh();
		strictEqual(panel.view.render(120), first);
		now += 1000;
		panel.refresh();
		strictEqual(panel.view.render(120), first, "elapsed status is owned by the composer");
		used = 200;
		panel.refresh();
		notStrictEqual(panel.view.render(120), first);
		const narrow = panel.view.render(60);
		strictEqual(narrow.length, 1);
		strictEqual(panel.view.render(60), narrow);
		notStrictEqual(panel.view.render(120), narrow);
		strictEqual(panel.view.render(120).length, 2);
		notices.push({ id: "warning", level: "warning", text: "Needs attention", key: null, addedAt: now, expiresAt: null });
		panel.refresh();
		strictEqual(panel.view.render(60).length, 2);
		notices.pop();
		panel.refresh();
		strictEqual(panel.view.render(60).length, 1);
	} finally {
		panel.dispose();
	}
});

test("footer hydration reads time and notices once per snapshot", () => {
	let clocks = 0;
	let notices = 0;
	const panel = buildFooterDashboard({
		providers: { list: () => [] } as never,
		resolveCurrentBranch: async () => null,
		now: () => {
			clocks++;
			return 12000;
		},
		getNotifications: () => {
			notices++;
			return [];
		},
	});
	try {
		clocks = 0;
		notices = 0;
		panel.refresh();
		strictEqual(clocks, 1);
		strictEqual(notices, 1);
	} finally {
		panel.dispose();
	}
});

test("footer pages use snapshot time and preserve their row contracts at release widths", () => {
	const state = footerState();
	state.resources = {
		sampledAt: 9000,
		scope: "local OS",
		hostTotalBytes: 1024 ** 3,
		hostFreeBytes: 512 * 1024 ** 2,
		processRssBytes: 1000,
		cpuPercent: 40,
		network: null,
		disk: null,
		gpu: null,
	};
	for (const width of [60, 80, 120, 200]) {
		const compact = renderCompactDashboard(state, width);
		strictEqual(compact.length, 2);
		for (const page of DASHBOARD_PAGES) {
			const rows = renderDashboardPage(state, page, width, 240, "Alt+U");
			strictEqual(rows.length, 16);
			match(stripTerminalSequences(rows[0] ?? ""), new RegExp(page));
			if (page === "Status") match(rows.map(stripTerminalSequences).join("\n"), /3s ago/);
			for (const row of [...rows, ...compact]) {
				ok(visibleWidth(row) <= width);
				const plain = row.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
				ok([...plain].every((char) => char.charCodeAt(0) >= 32 && (char.charCodeAt(0) < 127 || char.charCodeAt(0) > 159)));
			}
		}
	}
});

test("compact footer names an unknown serving window without a percentage", () => {
	const state = footerState();
	state.context.ledger = null;
	state.context.used = 100;
	state.context.contextWindow = null;
	const rows = renderCompactDashboard(state, 100).map(stripTerminalSequences).join("\n");
	match(rows, /100 in context/u);
	strictEqual(/\?%/u.test(rows), false);
});

test("footer totals come from the read model: unknown usage stays partial, never-sent is counted, nothing reads as 0 (#434)", () => {
	const records = goldenTelemetryRecords();
	const golden = telemetryViewOf("golden-p0", records);
	const neverSentId = golden.calls({ dispositions: ["never_sent"] }).calls[0]?.callId;
	let view: TelemetryView | null = telemetryViewOf(
		"golden-p0",
		records.filter((record) => "callId" in record.data && record.data.callId === neverSentId),
	);
	const panel = buildFooterDashboard({
		providers: { list: () => [] } as never,
		resolveCurrentBranch: async () => null,
		getTerminalRows: () => 120,
		getTelemetry: () => view,
	});
	try {
		panel.setExpanded(true);
		for (const scenario of ["never-sent", "golden", "unbound"] as const) {
			view = scenario === "never-sent" ? view : scenario === "golden" ? golden : null;
			panel.refresh();
			for (const width of [40, 80, 120]) {
				const rows = panel.view.render(width);
				const text = rows.map(stripTerminalSequences).join(" ").replace(/\s+/gu, " ");
				if (scenario === "never-sent") match(text, /(?:0 tok|session 0 tokens) · 1 never sent/u);
				if (scenario === "golden") {
					// Two calls have unknown usage; the footer states the bound with the one mark /usage and the exit card use.
					match(text, /(?:≥5\.3k tok|session ≥5\.3k tokens) · 1 never sent/u);
					ok(!/at least|some calls unknown|~5\.3k/u.test(text));
					match(text, /\$0\.01 \+\?/u);
				}
				if (scenario === "unbound") match(text, /not available/u);
				for (const row of rows) ok(visibleWidth(row) <= width);
			}
		}
	} finally {
		panel.dispose();
	}
});

test("retrying and cancelling workers count as active on every footer surface", () => {
	const state = footerState();
	const base = state.dispatchRows[0];
	ok(base);
	state.dispatchRows = [
		{ ...base, runId: "retry", status: "retrying" },
		{ ...base, runId: "cancel", status: "cancelling" },
	];
	state.agent.dispatchRows = state.dispatchRows;
	match(dispatchSegment(state.dispatchRows) ?? "", /2 active/u);
	for (const width of [60, 80, 120, 200]) {
		const compact = renderCompactDashboard(state, width);
		const expanded = renderDashboardPage(state, "Status", width, 240, "Alt+U");
		match(compact.map(stripTerminalSequences).join("\n"), /2 workers/u);
		match(expanded.map(stripTerminalSequences).join("\n"), /2 active/u);
		for (const line of [...compact, ...expanded]) {
			ok(visibleWidth(line) <= width);
			for (const tail of line.split(String.fromCharCode(27)).slice(1)) ok(/^\[[0-9;]*m/u.test(tail));
		}
	}
});

test("footer, queue and action hints spell live keybindings consistently", () => {
	const previous = getKeybindings();
	const manager = createKeybindingManager({
		...DEFAULT_SETTINGS,
		interface: {
			...DEFAULT_SETTINGS.interface,
			keybindings: {
				"clio-coder.status.toggle": "ctrl+u",
				"clio-coder.leader": "alt+g",
				"clio-coder.model.select": "ctrl+m",
				"clio-coder.notifications.dismiss": "ctrl+n",
			},
		},
	});
	try {
		match(manager.actionLabel("clio-coder.notifications.dismiss"), /Ctrl\+N/u);
		match(manager.actionLabel("clio-coder.model.select"), /Alt\+G M/u);
		match(footerKeyHint(0, false, Number.POSITIVE_INFINITY, "idle") ?? "", /Ctrl\+M Model picker/u);
		const state = footerState();
		state.demo = false;
		state.session.leaderArmed = true;
		const queue = createFollowUpQueuePanel({ getDequeueKey: () => manager.actionLabel("clio-coder.message.dequeue") });
		queue.setMessages([{ id: "q1", enqueuedAt: 0, kind: "follow-up", text: "inspect this" }]);
		const notice = {
			id: "warning",
			level: "warning" as const,
			text: "Connection needs review",
			key: null,
			addedAt: state.now,
			expiresAt: null,
		};
		for (const width of [60, 80, 120, 200]) {
			const compact = renderCompactDashboard(state, width);
			match(compact.map(stripTerminalSequences).join("\n"), /Alt\+G → choose key/u);
			const queued = queue.render(width);
			match(queued.map(stripTerminalSequences).join("\n"), /\[Alt\+Q · Alt\+G Q\] all to editor/u);
			state.session.leaderArmed = false;
			state.notices = [notice];
			const badge = renderCompactDashboard(state, width);
			const panel = formatNotificationPanel([notice], width, {
				dismissKeyLabel: manager.actionLabel("clio-coder.notifications.dismiss"),
			});
			match(badge.map(stripTerminalSequences).join("\n"), new RegExp(GLYPH.warn));
			match(panel.map(stripTerminalSequences).join("\n"), new RegExp(GLYPH.warn));
			match(panel.map(stripTerminalSequences).join("\n"), /Ctrl\+N · Alt\+G X dismiss/u);
			state.session.leaderArmed = true;
			state.notices = [];
			for (const line of [...compact, ...queued, ...badge, ...panel]) {
				ok(visibleWidth(line) <= width);
				for (const tail of line.split(String.fromCharCode(27)).slice(1)) ok(/^\[[0-9;]*m/u.test(tail));
			}
		}
	} finally {
		setKeybindings(previous);
	}
});

it("the dashboard names image input for both vision and text-only models", () => {
	deepStrictEqual(capabilityLabels({ ...EMPTY_CAPABILITIES, chat: true }).includes("images no"), true);
	deepStrictEqual(capabilityLabels({ ...EMPTY_CAPABILITIES, chat: true, vision: true }).includes("images yes"), true);
});
