import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { OutputStyle } from "../../src/core/defaults.js";
import type { TelemetryContract } from "../../src/domains/telemetry/index.js";
import { createWorkerProgressFold } from "../../src/domains/telemetry/worker-progress.js";
import type { Component, TUI } from "../../src/engine/tui.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import {
	createDispatchBoardView,
	type DispatchBoardRow,
	renderFleetPlanCard,
} from "../../src/interactive/dispatch-board.js";
import { dockTop } from "../../src/interactive/dock.js";
import { createFleetDock } from "../../src/interactive/fleet-dock.js";
import type { FleetPlanRunView } from "../../src/interactive/fleet-plan-runs.js";
import { renderDoctorReport } from "../../src/interactive/renderers/doctor-report.js";
import { renderWorkerEntryLines } from "../../src/interactive/renderers/worker-entry.js";
import { transcriptDetail } from "../../src/interactive/transcript-detail.js";
import { openUsageOverlay } from "../../src/interactive/usage-overlay.js";
import { footerState } from "../harness/footer-fixture.js";

const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
const fits = (lines: string[], width: number) => {
	for (const line of lines) ok(visibleWidth(line) <= width, `${width}: ${stripTerminalSequences(line)}`);
};

test("fleet dock follows live tiers, prioritizes approval waits, and does not render discarded detail", () => {
	const fixture = footerState().dispatchRows[0];
	ok(fixture);
	let style: OutputStyle = "compact";
	let rows: DispatchBoardRow[] = [
		{
			...fixture,
			agentAudience: "base",
			taskSummary: "Inspect the parser",
		},
	];
	const dock = createFleetDock({ getRows: () => rows, getOutputStyle: () => style, getTerminalRows: () => 40 });
	for (const width of [24, 40, 80, 120, 200]) {
		style = "compact";
		const compact = dock.render(width);
		doesNotMatch(plain(compact), /Inspect the parser|Fleet Runs/);
		style = "standard";
		const standard = dock.render(width);
		match(plain(standard), /Inspect the parser/);
		style = "detailed";
		const detailed = dock.render(width);
		match(plain(detailed), /Fleet Runs/);
		ok(compact.length < standard.length);
		ok(standard.length < detailed.length);
		for (const lines of [compact, standard, detailed]) fits(lines, width);
	}
	const first = rows[0];
	ok(first);
	const waiting: DispatchBoardRow = {
		...first,
		runId: "approval",
		agentId: "waiting-worker",
		progress: {
			...createWorkerProgressFold().snapshot(),
			awaitingApproval: true,
			phase: "tool",
			tailText: "",
			recentActions: [],
			currentAction: null,
		},
	};
	rows = [first, waiting];
	style = "compact";
	const minimal = plain(dock.render(120));
	match(minimal, /waiting-worker.*approval/);
	ok(waiting.progress);
	match(
		plain(
			renderWorkerEntryLines(
				{
					runId: "approval",
					assignmentId: "approval",
					origin: "user",
					agentId: "waiting-worker",
					runtime: { kind: "clio" },
					text: "",
					droppedLines: 0,
					pending: true,
					tools: [],
					attempts: [],
					progress: waiting.progress,
				},
				120,
				{ detail: transcriptDetail("compact") },
			),
		),
		/waiting-worker.*approval/,
	);
	// A strip has no use for usage details; computing them on every paint was wasted work.
	Object.defineProperty(waiting, "usage", {
		get() {
			throw new Error("summary read full telemetry");
		},
	});
	dock.render(120);
});

test("fleet board tier changes invalidate cached rows and explicit detail overrides compact mode", () => {
	const fixture = footerState().dispatchRows[0];
	ok(fixture);
	let style: OutputStyle = "compact";
	const row = { ...fixture, agentAudience: "base" as const, taskSummary: "Investigate the parser" };
	const board = createDispatchBoardView(
		() => [row],
		() => undefined,
		() => style,
	);
	board.setBodyRows(30);
	const compact = plain(board.render(120));
	doesNotMatch(compact, /target\s|tokens\s/);
	style = "standard";
	match(plain(board.render(120)), /target\s/);
	style = "compact";
	strictEqual(plain(board.render(120)), compact);
	board.toggleDetail();
	match(plain(board.render(120)), /target\s/);
	strictEqual(board.detailExpanded(), true);
});

test("settled plans fold routine steps but keep the failed step and a route to detail", () => {
	const plan: FleetPlanRunView = {
		rootId: "plan-1",
		name: "release",
		startedAtMs: 0,
		finishedAtMs: 1000,
		state: "failed",
		requiredStepCount: 20,
		succeededStepCount: 19,
		costText: null,
		steps: Array.from({ length: 20 }, (_, i) => ({
			stepId: `step-${i}`,
			kind: "code",
			label: `check ${i}`,
			state: i === 18 ? "failed" : "passed",
		})),
	};
	const compact = renderFleetPlanCard(plan, 80, "compact");
	const standard = renderFleetPlanCard(plan, 80, "standard");
	match(plain(compact), /20 more steps.*\/fleet/);
	match(plain(standard), /step-18/);
	ok(standard.length < 10);
	fits(standard, 80);
	const fixture = footerState().dispatchRows[0];
	ok(fixture);
	const board = createDispatchBoardView(
		() => [{ ...fixture, plan }],
		() => undefined,
		() => "compact",
	);
	board.setBodyRows(12);
	board.toggleDetail();
	const first = plain(board.render(80));
	for (let index = 0; index < 15; index++) {
		board.scrollDetail(1);
		fits(board.render(80), 80);
	}
	const end = plain(board.render(80));
	match(end, /step-19/);
	board.scrollDetail(-1);
	ok(plain(board.render(80)) !== end, "one page back works after repeated paging beyond the end");
	for (let index = 0; index < 15; index++) {
		board.scrollDetail(-1);
		board.render(80);
	}
	strictEqual(plain(board.render(80)), first);
});

test("doctor folds routine diagnostics by tier without dropping errors or remediation", () => {
	const findings = [
		{ ok: true, name: "healthy", detail: "routine installation path" },
		{ ok: false, name: "broken", detail: "Repair this component before continuing." },
		{ ok: true, level: "warn" as const, name: "optional", detail: "Install the missing tool." },
	];
	for (const width of [8, 24, 80, 120, 200]) {
		for (const style of ["compact", "standard", "detailed"] as const) {
			const lines = renderDoctorReport(findings, width, style);
			fits(lines, width);
			const text = plain(lines).replace(/\s/g, "");
			ok(text.includes("Repairthiscomponentbeforecontinuing."));
			ok(text.includes("Installthemissingtool."));
			strictEqual(text.includes("routineinstallationpath"), style === "detailed");
			strictEqual(text.includes("healthy"), style !== "compact");
		}
	}
});

test("usage suppresses the empty graph outside Detailed and adapts without reopening", () => {
	let style: OutputStyle = "compact";
	const tui = {
		terminal: { rows: 40, setTitle() {} },
		requestRender() {},
		showOverlay: () => ({ hide() {} }),
	} as unknown as TUI;
	const telemetry = { subscribe: () => () => {} } as unknown as TelemetryContract;
	const handle = openUsageOverlay(tui, telemetry, { getOutputStyle: () => style });
	try {
		const frame = dockTop(tui)?.frame as unknown as Component;
		for (const width of [24, 80, 120, 200]) {
			style = "compact";
			doesNotMatch(plain(frame.render(width)), /182 days|Less.*More/);
			style = "standard";
			doesNotMatch(plain(frame.render(width)), /182 days|Less.*More/);
			style = "detailed";
			const detailed = frame.render(width);
			fits(detailed, width);
			if (width >= 80) match(plain(detailed), /182 days/);
		}
	} finally {
		handle.hide();
	}
});
