import { deepStrictEqual, match } from "node:assert/strict";
import { test } from "node:test";
import type { DecisionLedgerEntry } from "../../src/domains/session/entries.js";
import type { Component, TUI } from "../../src/engine/tui.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import type { DockFrame } from "../../src/interactive/dock.js";
import { DOCK_BODY_ROWS_MAX, dockTop } from "../../src/interactive/dock.js";
import { openDecisionsOverlay } from "../../src/interactive/overlays/decisions.js";

const ENTRY: DecisionLedgerEntry = {
	kind: "decisionLedger",
	turnId: "t1",
	parentTurnId: null,
	timestamp: "2026-11-10T00:00:00.000Z",
	interviewId: "i1",
	interviewStatus: "complete",
	startedAt: "2026-11-10T00:00:00.000Z",
	endedAt: "2026-11-10T00:01:00.000Z",
	roundCount: 1,
	decisions: [{ key: "cache_key", value: "Full path", status: "active", decidedAt: "2026-11-10T00:01:00.000Z" }],
};

test("x asks once before it supersedes a decision; another key keeps it", () => {
	const tui = {
		terminal: { rows: 35, setTitle: () => {} },
		requestRender: () => {},
		showOverlay: () => ({ hide: () => {} }),
	} as unknown as TUI;
	const superseded: string[] = [];
	const handle = openDecisionsOverlay(tui, () => [ENTRY], {
		onSupersede: (selection) => superseded.push(JSON.stringify(selection)),
		onCorrection: () => {},
		onClose: () => {},
	});
	const frame = dockTop(tui)?.frame as unknown as DockFrame & Component;
	const rail = (): string =>
		[...frame.renderDockBody(100, DOCK_BODY_ROWS_MAX), ...frame.render(100)].map(stripTerminalSequences).join("\n");
	frame.handleInput?.("s");
	deepStrictEqual(superseded, [], "s moved to x and does nothing");
	frame.handleInput?.("x");
	deepStrictEqual(superseded, [], "the first s only asks");
	match(rail(), /x again/u);
	frame.handleInput?.("j");
	frame.handleInput?.("x");
	deepStrictEqual(superseded, [], "another key kept it, so this s asks again");
	frame.handleInput?.("x");
	deepStrictEqual(superseded.length, 1);
	handle.hide();
});

test("End, Home and PgDn move the decision selection; Tab opens detail like Enter (E-13)", () => {
	const tui = {
		terminal: { rows: 35, setTitle: () => {} },
		requestRender: () => {},
		showOverlay: () => ({ hide: () => {} }),
	} as unknown as TUI;
	const three: DecisionLedgerEntry = {
		...ENTRY,
		decisions: ["a_key", "b_key", "c_key"].map((key) => ({
			key,
			value: `value of ${key}`,
			status: "active" as const,
			decidedAt: "2026-11-10T00:01:00.000Z",
		})),
	};
	const superseded: string[] = [];
	const handle = openDecisionsOverlay(tui, () => [three], {
		onSupersede: (selection) => superseded.push(JSON.stringify(selection)),
		onCorrection: () => {},
		onClose: () => {},
	});
	const frame = dockTop(tui)?.frame as unknown as DockFrame & Component;
	const body = (): string => frame.renderDockBody(100, DOCK_BODY_ROWS_MAX).map(stripTerminalSequences).join("\n");
	const collapsed = body();
	frame.handleInput?.("\t");
	match(body(), /./u);
	deepStrictEqual(body() !== collapsed, true, "Tab opened the detail");
	frame.handleInput?.("\x1b[F");
	frame.handleInput?.("x");
	frame.handleInput?.("x");
	frame.handleInput?.("\x1b[H");
	frame.handleInput?.("x");
	frame.handleInput?.("x");
	frame.handleInput?.("\x1b[6~");
	frame.handleInput?.("x");
	frame.handleInput?.("x");
	deepStrictEqual(superseded.length, 3);
	match(superseded[0] ?? "", /c_key/u);
	match(superseded[1] ?? "", /a_key/u);
	match(superseded[2] ?? "", /c_key/u);
	handle.hide();
});
