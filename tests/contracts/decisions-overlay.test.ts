import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { DecisionLedgerEntry } from "../../src/domains/session/entries.js";
import { type Component, type OverlayHandle, type TUI, visibleWidth } from "../../src/engine/tui.js";
import {
	type DecisionSelection,
	formatDecisionCorrectionTurn,
	formatDecisionsOverlayBodyLines,
	openDecisionsOverlay,
} from "../../src/interactive/overlays/decisions.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

function interview(overrides: Partial<DecisionLedgerEntry> = {}): DecisionLedgerEntry {
	return {
		kind: "decisionLedger",
		turnId: "decision-ledger-1",
		parentTurnId: "user-1",
		timestamp: "2026-08-19T10:03:00.000Z",
		interviewId: "interview-1",
		interviewStatus: "complete",
		startedAt: "2026-08-19T10:00:00.000Z",
		endedAt: "2026-08-19T10:03:00.000Z",
		roundCount: 2,
		summary: "Keep the release focused.",
		decisions: [
			{
				key: "scope",
				label: "Scope",
				value: "Only the interactive session",
				source_question: "Which runtime should receive this feature?",
				status: "active",
				decidedAt: "2026-08-19T10:01:00.000Z",
			},
			{
				key: "release_gate",
				value: "Focused contracts",
				status: "superseded",
				decidedAt: "2026-08-19T10:02:00.000Z",
				revisedAt: "2026-08-19T10:04:00.000Z",
				correction: "Run the complete contract suite.",
			},
		],
		...overrides,
	};
}

function fakeTui(): {
	tui: TUI;
	component: () => Component;
} {
	let mounted: Component | undefined;
	const handle = {
		hide() {},
		setHidden() {},
		isHidden: () => false,
		focus() {},
		unfocus() {},
		isFocused: () => true,
	} as OverlayHandle;
	const tui = {
		terminal: { columns: 100, rows: 40 },
		showOverlay(component: Component): OverlayHandle {
			mounted = component;
			return handle;
		},
		requestRender() {},
	} as unknown as TUI;
	return {
		tui,
		component: () => {
			if (!mounted) throw new Error("overlay not mounted");
			return mounted;
		},
	};
}

describe("contracts/decisions-overlay", () => {
	it("wraps a decision-ledger error instead of cutting its remedy", () => {
		const mounted = fakeTui();
		const message = "Decision ledger is unavailable; repair the session record and reopen this overlay.";
		openDecisionsOverlay(
			mounted.tui,
			() => {
				throw new Error(message);
			},
			{ onSupersede: () => {}, onCorrection: () => {}, onClose: () => {} },
		);
		const lines = mounted.component().render(30).map(stripAnsi);
		const collapsed = lines.join(" ").replace(/[│\s]+/gu, " ");

		ok(collapsed.includes(message), `ledger error was cut: ${collapsed}`);
		for (const line of lines) strictEqual(visibleWidth(line) <= 30, true, `line overflows: ${line}`);
	});

	it("wraps an expanded question, answer, and correction inside the indent instead of cutting them", () => {
		const question =
			"Which runtime should receive this feature, given that the dispatch path and the interactive path resolve their settings differently?";
		const correction = "Run the complete contract suite, including the render audit that the focused run skips.";
		const entry = interview({
			decisions: [
				{
					key: "scope",
					label: "Scope",
					value: "Only the interactive session, and only for operators who opted in",
					source_question: question,
					status: "active",
					decidedAt: "2026-08-19T10:01:00.000Z",
				},
				{
					key: "release_gate",
					value: "Focused contracts",
					status: "superseded",
					decidedAt: "2026-08-19T10:02:00.000Z",
					revisedAt: "2026-08-19T10:04:00.000Z",
					correction,
				},
			],
		});
		const width = 60;
		const lines = formatDecisionsOverlayBodyLines([entry], 0, "interview-1:scope", width).map(stripAnsi);
		const collapsed = lines.join(" ").replace(/\s+/g, " ");
		// The indent used to be spent after wrapping, so every continuation line
		// lost its last six columns to a cut that landed mid-sentence.
		ok(collapsed.includes(question), `the expanded question must not be cut: ${collapsed}`);
		ok(collapsed.includes(correction), `the correction must not be cut: ${collapsed}`);
		for (const line of lines) strictEqual(visibleWidth(line) <= width, true, `line overflows: ${line}`);
	});

	it("formats the attributed correction turn exactly", () => {
		strictEqual(
			formatDecisionCorrectionTurn(
				{ interviewId: "interview-1", key: "scope", label: "Scope", value: "CLI only" },
				"Include the TUI",
			),
			'Decision "Scope" (previously: CLI only) is superseded by the operator. New direction: Include the TUI. Acknowledge and adjust the plan.',
		);
	});

	it("groups newest interviews, renders state and correction receipts, and survives 40 columns", () => {
		const older = interview({ interviewId: "older", endedAt: "2026-08-18T10:03:00.000Z" });
		const newer = interview({
			interviewId: "newer",
			interviewStatus: "cancelled",
			exposure: "outward",
			summary: "Operator cancelled.",
		});
		const lines = formatDecisionsOverlayBodyLines([newer, older], 0, null, 40, Date.parse("2026-08-19T10:05:00.000Z"));
		const text = stripAnsi(lines.join("\n"));
		ok(text.includes("Outward consequence"), text);
		ok(text.includes("Conversational answer"), text);
		ok(text.indexOf("cancelled") < text.lastIndexOf("complete"), text);
		ok(text.includes("2 rounds"), text);
		ok(text.includes("Scope: Only the interactive"), text);
		ok(text.includes("correction Run the complete"), text);
		for (const line of lines) strictEqual(visibleWidth(line) <= 40, true, `overflow: ${stripAnsi(line)}`);
	});

	it("selects rows, expands the source question and answer, and appends a supersede action", () => {
		const mounted = fakeTui();
		const superseded: DecisionSelection[] = [];
		openDecisionsOverlay(mounted.tui, () => [interview()], {
			onSupersede: (selection) => superseded.push(selection),
			onCorrection: () => {},
			onClose: () => {},
			now: () => Date.parse("2026-08-19T10:05:00.000Z"),
		});
		const body = mounted.component();
		body.handleInput?.("\r");
		const expanded = stripAnsi(body.render(80).join("\n"));
		ok(expanded.includes("question Which runtime should receive this feature?"), expanded);
		ok(expanded.includes("answer Only the interactive session"), expanded);

		body.handleInput?.("\x1b[B");
		body.handleInput?.("s");
		deepStrictEqual(superseded, [
			{
				interviewId: "interview-1",
				key: "release_gate",
				label: "release_gate",
				value: "Focused contracts",
			},
		]);
	});

	it("opens an inline correction editor and submits one attributed correction", () => {
		const mounted = fakeTui();
		const corrections: Array<{ selection: DecisionSelection; correction: string }> = [];
		openDecisionsOverlay(mounted.tui, () => [interview()], {
			onSupersede: () => {},
			onCorrection: (selection, correction) => corrections.push({ selection, correction }),
			onClose: () => {},
		});
		const body = mounted.component();
		body.handleInput?.("c");
		ok(stripAnsi(body.render(60).join("\n")).includes("New direction"));
		for (const char of "Support workers too") body.handleInput?.(char);
		body.handleInput?.("\r");
		strictEqual(corrections.length, 1);
		strictEqual(corrections[0]?.selection.label, "Scope");
		strictEqual(corrections[0]?.correction, "Support workers too");
	});

	it("advertises the active keymap and closes on Escape in browse or correction mode", () => {
		const mounted = fakeTui();
		let closes = 0;
		openDecisionsOverlay(mounted.tui, () => [interview()], {
			onSupersede: () => {},
			onCorrection: () => {},
			onClose: () => {
				closes += 1;
			},
		});
		const footerText = stripAnsi(mounted.component().render(92).join("\n"));
		ok(footerText.includes("select"), footerText);
		ok(footerText.includes("expand"), footerText);
		ok(footerText.includes("supersede"), footerText);
		ok(footerText.includes("correct"), footerText);

		mounted.component().handleInput?.(ESC);
		strictEqual(closes, 1);
		mounted.component().handleInput?.("c");
		mounted.component().handleInput?.(ESC);
		strictEqual(closes, 2);
	});
});
