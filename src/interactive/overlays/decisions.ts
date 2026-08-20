import type { DecisionLedgerEntry, DecisionRecord } from "../../domains/session/entries.js";
import {
	type Component,
	Input,
	matchesKey,
	type OverlayHandle,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../../engine/tui.js";
import { buildHint, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme, GLYPH, rule } from "../theme/index.js";

const DEFAULT_CONTENT_WIDTH = 88;

export const DECISIONS_OVERLAY_WIDTH = DEFAULT_CONTENT_WIDTH + 4;

export interface DecisionSelection {
	interviewId: string;
	key: string;
	label: string;
	value: string;
}

/** The operator-authored turn that makes a durable correction visible to the model. */
export function formatDecisionCorrectionTurn(selection: DecisionSelection, correction: string): string {
	return `Decision "${selection.label}" (previously: ${selection.value}) is superseded by the operator. New direction: ${correction}. Acknowledge and adjust the plan.`;
}

export interface OpenDecisionsOverlayOptions {
	onSupersede: (selection: DecisionSelection) => void;
	onCorrection: (selection: DecisionSelection, correction: string) => void;
	onClose: () => void;
	requestRender?: () => void;
	now?: () => number;
}

interface SelectableDecision {
	interview: DecisionLedgerEntry;
	decision: DecisionRecord;
}

function fitLine(text: string, width: number): string {
	const safeWidth = Math.max(1, Math.floor(width));
	return visibleWidth(text) <= safeWidth ? text : truncateToWidth(text, safeWidth, "…", true);
}

function relativeTime(timestamp: string, now: number): string {
	const value = Date.parse(timestamp);
	if (!Number.isFinite(value)) return "unknown time";
	const seconds = Math.max(0, Math.floor((now - value) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function selectionFor(row: SelectableDecision): DecisionSelection {
	return {
		interviewId: row.interview.interviewId,
		key: row.decision.key,
		label: row.decision.label ?? row.decision.key,
		value: row.decision.value,
	};
}

function selectableRows(interviews: ReadonlyArray<DecisionLedgerEntry>): SelectableDecision[] {
	return interviews.flatMap((interview) => interview.decisions.map((decision) => ({ interview, decision })));
}

function interviewHeader(interview: DecisionLedgerEntry, width: number, now: number): string[] {
	const theme = clioTheme();
	const rounds = `${interview.roundCount} round${interview.roundCount === 1 ? "" : "s"}`;
	const status =
		interview.interviewStatus === "complete" ? theme.fg("success", "complete") : theme.fg("warning", "cancelled");
	const heading = `${theme.fg("accent", relativeTime(interview.endedAt, now))}${theme.fg("dim", " · ")}${theme.fg("muted", rounds)}${theme.fg("dim", " · ")}${status}`;
	const lines = [fitLine(heading, width)];
	if (interview.summary) {
		lines.push(...wrapTextWithAnsi(theme.fg("dim", interview.summary), width).map((line) => fitLine(line, width)));
	}
	return lines;
}

function decisionLines(decision: DecisionRecord, selected: boolean, expanded: boolean, width: number): string[] {
	const theme = clioTheme();
	const cursor = selected ? theme.fg("accent", GLYPH.cursor) : " ";
	const status = decision.status === "active" ? theme.fg("success", GLYPH.ok) : theme.fg("dim", GLYPH.cancelled);
	const labelText = decision.label ?? decision.key;
	const label = decision.status === "superseded" ? theme.fg("dim", labelText) : theme.fg("muted", labelText);
	const value = decision.status === "superseded" ? theme.fg("dim", decision.value) : decision.value;
	const lines = [fitLine(`${cursor} ${status} ${label}${theme.fg("dim", ":")} ${value}`, width)];
	if (decision.status === "superseded" && decision.correction) {
		lines.push(fitLine(`      ${theme.fg("dim", "correction")} ${theme.fg("muted", decision.correction)}`, width));
	}
	if (selected && expanded) {
		if (decision.source_question) {
			lines.push(
				...wrapTextWithAnsi(`${theme.fg("dim", "question")} ${theme.fg("muted", decision.source_question)}`, width).map(
					(line) => fitLine(`      ${line}`, width),
				),
			);
		}
		lines.push(
			...wrapTextWithAnsi(`${theme.fg("dim", "answer")} ${theme.fg("muted", decision.value)}`, width).map((line) =>
				fitLine(`      ${line}`, width),
			),
		);
	}
	return lines;
}

export function formatDecisionsOverlayBodyLines(
	interviews: ReadonlyArray<DecisionLedgerEntry>,
	selectedIndex = 0,
	expandedKey: string | null = null,
	contentWidth = DEFAULT_CONTENT_WIDTH,
	now = Date.now(),
): string[] {
	const width = Math.max(1, Math.floor(contentWidth));
	const theme = clioTheme();
	if (interviews.length === 0) {
		return [
			...wrapTextWithAnsi(theme.fg("muted", "No interview decisions have been recorded on this branch."), width),
			"",
			...wrapTextWithAnsi(theme.fg("dim", "Completed and cancelled ask_user interviews appear here."), width),
		].map((line) => fitLine(line, width));
	}
	const selected = selectableRows(interviews)[selectedIndex];
	const lines: string[] = [];
	for (let interviewIndex = 0; interviewIndex < interviews.length; interviewIndex += 1) {
		const interview = interviews[interviewIndex];
		if (!interview) continue;
		if (interviewIndex > 0) lines.push(rule(theme, width));
		lines.push(...interviewHeader(interview, width, now));
		if (interview.decisions.length === 0) {
			lines.push(fitLine(`  ${theme.fg("dim", "No compact decisions were recorded.")}`, width));
			continue;
		}
		for (const decision of interview.decisions) {
			const isSelected =
				selected?.interview.interviewId === interview.interviewId && selected.decision.key === decision.key;
			const rowKey = `${interview.interviewId}:${decision.key}`;
			lines.push(...decisionLines(decision, isSelected, isSelected && expandedKey === rowKey, width));
		}
	}
	return lines;
}

class DecisionsOverlayBody implements Component {
	private selectedIndex = 0;
	private expandedKey: string | null = null;
	private correctionInput: Input | null = null;
	private status = "";

	constructor(
		private readonly getInterviews: () => ReadonlyArray<DecisionLedgerEntry>,
		private readonly options: OpenDecisionsOverlayOptions,
	) {}

	render(width: number): string[] {
		const interviews = this.readInterviews();
		const rows = selectableRows(interviews);
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, rows.length - 1)));
		const body = formatDecisionsOverlayBodyLines(
			interviews,
			this.selectedIndex,
			this.expandedKey,
			width,
			this.options.now?.() ?? Date.now(),
		);
		if (this.correctionInput) {
			const theme = clioTheme();
			body.push("", fitLine(theme.fg("accent", "New direction"), width));
			body.push(
				...this.correctionInput
					.render(Math.max(1, width))
					.map((line) =>
						fitLine(line.startsWith("> ") ? `${theme.fg("accent", `${GLYPH.cursor} `)}${line.slice(2)}` : line, width),
					),
			);
		}
		if (this.status) body.push("", fitLine(clioTheme().fg("warning", this.status), width));
		return body;
	}

	handleInput(data: string): void {
		if (this.correctionInput) {
			this.correctionInput.handleInput(data);
			return;
		}
		const rows = selectableRows(this.readInterviews());
		if (matchesKey(data, "esc")) {
			this.options.onClose();
			return;
		}
		if (rows.length === 0) return;
		if (matchesKey(data, "up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.expandedKey = null;
			this.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.selectedIndex = Math.min(rows.length - 1, this.selectedIndex + 1);
			this.expandedKey = null;
			this.requestRender();
			return;
		}
		const selected = rows[this.selectedIndex];
		if (!selected) return;
		if (matchesKey(data, "enter") || data === "\n") {
			const key = `${selected.interview.interviewId}:${selected.decision.key}`;
			this.expandedKey = this.expandedKey === key ? null : key;
			this.requestRender();
			return;
		}
		if (matchesKey(data, "s")) {
			try {
				this.options.onSupersede(selectionFor(selected));
				this.status = "Decision superseded.";
			} catch (error) {
				this.status = error instanceof Error ? error.message : String(error);
			}
			this.requestRender();
			return;
		}
		if (matchesKey(data, "c")) this.beginCorrection(selected);
	}

	invalidate(): void {
		this.correctionInput?.invalidate();
	}

	footerHint(): string {
		return this.correctionInput
			? buildHint([{ key: "Enter", verb: "submit" }])
			: buildHint([
					{ key: "↑↓", verb: "select" },
					{ key: "Enter", verb: "expand" },
					{ key: "s", verb: "supersede" },
					{ key: "c", verb: "correct" },
				]);
	}

	private readInterviews(): ReadonlyArray<DecisionLedgerEntry> {
		try {
			return this.getInterviews();
		} catch (error) {
			this.status = error instanceof Error ? error.message : String(error);
			return [];
		}
	}

	private beginCorrection(selected: SelectableDecision): void {
		const input = new Input();
		input.onSubmit = (value) => {
			const correction = value.trim();
			if (correction.length === 0) {
				this.status = "Enter the operator's new direction.";
				this.requestRender();
				return;
			}
			try {
				this.options.onCorrection(selectionFor(selected), correction);
			} catch (error) {
				this.status = error instanceof Error ? error.message : String(error);
				this.requestRender();
			}
		};
		input.onEscape = () => this.options.onClose();
		this.correctionInput = input;
		this.status = "";
		this.requestRender();
	}

	private requestRender(): void {
		this.options.requestRender?.();
	}
}

/** Mount the settled interview decision board. */
export function openDecisionsOverlay(
	tui: TUI,
	getInterviews: () => ReadonlyArray<DecisionLedgerEntry>,
	options: OpenDecisionsOverlayOptions,
): OverlayHandle {
	const body = new DecisionsOverlayBody(getInterviews, {
		...options,
		requestRender: options.requestRender ?? (() => tui.requestRender()),
	});
	return showClioOverlayFrame(tui, body, {
		anchor: "center",
		width: DECISIONS_OVERLAY_WIDTH,
		title: () => "Decisions",
		footerHint: () => body.footerHint(),
	});
}
