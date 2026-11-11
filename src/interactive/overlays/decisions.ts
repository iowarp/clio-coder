import { classifyDecisionPresentation, decisionFactsForAnswer } from "../../domains/safety/decision-presentation.js";
import type { DecisionLedgerEntry, DecisionRecord } from "../../domains/session/entries.js";
import { type Component, Input, matchesKey, type OverlayHandle, type TUI, wrapTextWithAnsi } from "../../engine/tui.js";
import type { DecisionSelection } from "../../session-control/decision-correction.js";
import { backOutOneLayer, type EscapeLayers, escapeHintEntry } from "../escape-layers.js";
import {
	fitHintEntries,
	fitHintEntryList,
	fitRow,
	type HintEntry,
	selectionLabel,
	selectionMark,
	showClioOverlayFrame,
	windowRows,
} from "../overlay-frame.js";
import {
	chipRow,
	chipRows,
	clioTheme,
	emptyState,
	factRows,
	GLYPH,
	keyCap,
	positionRow,
	rule,
	sectionRule,
	statusChip,
	toneRole,
} from "../theme/index.js";
import { confirmOnceRail, listJump } from "./confirm-once.js";

const DEFAULT_CONTENT_WIDTH = 88;

export const DECISIONS_OVERLAY_WIDTH = DEFAULT_CONTENT_WIDTH + 4;

export type { DecisionSelection } from "../../session-control/decision-correction.js";
export { formatDecisionCorrectionTurn } from "../../session-control/decision-correction.js";

export interface OpenDecisionsOverlayOptions {
	onSupersede: (selection: DecisionSelection) => void;
	onCorrection: (selection: DecisionSelection, correction: string) => void;
	onClose: () => void;
	requestRender?: () => void;
	now?: () => number;
}

/**
 * Corrections an operator typed and stepped out of with Esc, by decision. The
 * field is the only place the text lives, so Esc used to throw it away along
 * with the whole board; it now survives leaving the field and closing the
 * board, and comes back the next time that decision is corrected.
 */
const keptCorrections = new Map<string, string>();

function decisionRowKey(interviewId: string, key: string): string {
	return `${interviewId}:${key}`;
}

interface SelectableDecision {
	interview: DecisionLedgerEntry;
	decision: DecisionRecord;
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

/**
 * One interview's header: its tier in the tier's tone, when it ended, how
 * many rounds it took and how it ended, as chips on one row; its summary,
 * when it has one, dim beneath.
 */
function interviewHeader(interview: DecisionLedgerEntry, width: number, now: number): string[] {
	const theme = clioTheme();
	const presentation = classifyDecisionPresentation(decisionFactsForAnswer(interview.exposure ?? "local"));
	const rounds = `${interview.roundCount} round${interview.roundCount === 1 ? "" : "s"}`;
	const lines = [
		chipRow(
			theme,
			[
				theme.style(toneRole(presentation.semanticToken), presentation.tierLabel, { bold: true }),
				theme.fg("annotation", relativeTime(interview.endedAt, now)),
				theme.fg("annotation", rounds),
				interview.interviewStatus === "complete"
					? statusChip(theme, "ok", "complete")
					: statusChip(theme, "cancelled", "cancelled"),
			],
			width,
		),
	];
	if (interview.summary) {
		lines.push(...wrapTextWithAnsi(theme.fg("annotation", interview.summary), width).map((line) => fitRow(line, width)));
	}
	return lines;
}

/**
 * One decision: the cursor, its standing as a glyph, its label and value on
 * one row; a superseded decision's correction beneath it; and, when expanded,
 * the question it answered, the answer, and why Clio chose it when it did.
 */
function decisionLines(
	decision: DecisionRecord,
	selected: boolean,
	expanded: boolean,
	width: number,
	draft?: string,
): string[] {
	const theme = clioTheme();
	const cursor = selectionMark(selected);
	const status = decision.status === "active" ? theme.fg("success", GLYPH.ok) : theme.fg("annotation", GLYPH.cancelled);
	const labelText = decision.label ?? decision.key;
	const label = selected
		? selectionLabel(true, labelText)
		: decision.status === "superseded"
			? theme.fg("annotation", labelText)
			: theme.fg("menuDescription", labelText);
	const value = decision.status === "superseded" ? theme.fg("annotation", decision.value) : decision.value;
	const lines = [fitRow(`${cursor} ${status} ${label}${theme.fg("annotation", ":")} ${value}`, width)];
	// The indent belongs to the container, so these facts lay out inside what
	// is left of the row, never cut at a column the row never had.
	const indent = "    ";
	const facts: Array<{ label: string; value: string }> = [];
	if (decision.status === "superseded" && decision.correction) {
		facts.push({ label: "correction", value: decision.correction });
	}
	if (draft !== undefined) facts.push({ label: "draft kept", value: draft });
	if (selected && expanded) {
		if (decision.source_question) facts.push({ label: "question", value: decision.source_question });
		facts.push({ label: "answer", value: decision.value });
		// Clio's own choices, an absent operator's question included (#421), say why.
		if (decision.source === "agent" && decision.rationale)
			facts.push({ label: "chosen by Clio", value: decision.rationale });
		if (decision.operator_choice === true) facts.push({ label: "chosen by", value: "you, as your own choice" });
	}
	if (facts.length > 0) {
		lines.push(
			...factRows(theme, facts, Math.max(1, width - indent.length)).map((line) => fitRow(`${indent}${line}`, width)),
		);
	}
	return lines;
}

/** The board's rows, and where the selected decision sits in them so a window can keep it in view. */
interface DecisionsBoardLines {
	lines: string[];
	/** First row of the selected decision's block, from its interview's header when it is that interview's first. */
	selectedStart: number;
	/** One past the selected decision's last row. */
	selectedEnd: number;
}

function formatDecisionsOverlayBodyLines(
	interviews: ReadonlyArray<DecisionLedgerEntry>,
	selectedIndex = 0,
	expandedKey: string | null = null,
	contentWidth = DEFAULT_CONTENT_WIDTH,
	now = Date.now(),
	editingKey: string | null = null,
): DecisionsBoardLines {
	const width = Math.max(1, Math.floor(contentWidth));
	const theme = clioTheme();
	if (interviews.length === 0) {
		const lines = emptyState(theme, "No questions have been answered on this branch yet.", width, {
			remedy: "When Clio asks you something and you answer or cancel it, the answer is listed here.",
		}).map((line) => fitRow(line, width));
		return { lines, selectedStart: 0, selectedEnd: 0 };
	}
	const selected = selectableRows(interviews)[selectedIndex];
	const lines: string[] = [];
	let selectedStart = 0;
	let selectedEnd = 0;
	for (let interviewIndex = 0; interviewIndex < interviews.length; interviewIndex += 1) {
		const interview = interviews[interviewIndex];
		if (!interview) continue;
		if (interviewIndex > 0) lines.push(rule(theme, width));
		const headerStart = lines.length;
		lines.push(...interviewHeader(interview, width, now));
		if (interview.decisions.length === 0) {
			const words =
				interview.interviewStatus === "complete"
					? "Finished without recording an answer."
					: "Cancelled before an answer was recorded.";
			lines.push(...emptyState(theme, words, Math.max(1, width - 2)).map((line) => fitRow(`  ${line}`, width)));
			// What it asked, so an interview that recorded nothing still says what it was about.
			const asked = interview.questions ?? [];
			if (asked.length > 0) {
				lines.push(
					...factRows(
						theme,
						asked.map((question, index) => ({
							label: index === 0 ? "asked" : "",
							value: question,
							tone: "muted" as const,
						})),
						Math.max(1, width - 4),
					).map((line) => fitRow(`    ${line}`, width)),
				);
			}
			continue;
		}
		interview.decisions.forEach((decision, decisionIndex) => {
			const isSelected =
				selected?.interview.interviewId === interview.interviewId && selected.decision.key === decision.key;
			const rowKey = decisionRowKey(interview.interviewId, decision.key);
			const start = lines.length;
			lines.push(
				...decisionLines(
					decision,
					isSelected,
					isSelected && expandedKey === rowKey,
					width,
					rowKey === editingKey ? undefined : keptCorrections.get(rowKey),
				),
			);
			if (isSelected) {
				selectedStart = decisionIndex === 0 ? headerStart : start;
				selectedEnd = lines.length;
			}
		});
	}
	return { lines, selectedStart, selectedEnd };
}

class DecisionsOverlayBody implements Component {
	private selectedIndex = 0;
	private expandedKey: string | null = null;
	private correctionInput: Input | null = null;
	/** The decision the open correction field belongs to, whose kept draft is in the field rather than under the row. */
	private correctionKey: string | null = null;
	private status: { kind: "ok" | "warning"; text: string } | null = null;
	/** The decision a first `s` asked about; a second `s` on it supersedes, any other key keeps it. */
	private armedSupersede: string | null = null;
	/** Rows the dock grants, or zero before the first dock render. */
	private rows = 0;
	private railRoom = 0;
	/** First board row in view, kept between frames so the window moves only when the selection leaves it. */
	private offset = 0;

	constructor(
		private readonly getInterviews: () => ReadonlyArray<DecisionLedgerEntry>,
		private readonly options: OpenDecisionsOverlayOptions,
	) {}

	setBodyRows(rows: number): void {
		this.rows = Math.max(0, Math.floor(rows));
	}

	setRailRoom(cells: number): void {
		this.railRoom = Math.max(0, Math.floor(cells));
	}

	render(width: number): string[] {
		const interviews = this.readInterviews();
		const rows = selectableRows(interviews);
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, rows.length - 1)));
		const board = formatDecisionsOverlayBodyLines(
			interviews,
			this.selectedIndex,
			this.expandedKey,
			width,
			this.options.now?.() ?? Date.now(),
			this.correctionKey,
		);
		const theme = clioTheme();
		// What stays under the board whatever it scrolls to: the open field, the last outcome, and the keys the rail drops.
		const tail: string[] = [];
		if (this.correctionInput) {
			tail.push(sectionRule(theme, width, "New direction"));
			tail.push(
				...this.correctionInput
					.render(Math.max(1, width))
					.map((line) =>
						fitRow(
							theme.base(
								"inputText",
								line.startsWith("> ") ? `${theme.fg("selectedOption", `${GLYPH.cursor} `)}${line.slice(2)}` : line,
							),
							width,
						),
					),
			);
		}
		if (this.status) {
			tail.push(...wrapTextWithAnsi(statusChip(theme, this.status.kind, this.status.text), Math.max(1, width)));
		}
		const dropped = this.droppedKeys();
		if (dropped.length > 0) {
			tail.push(
				...chipRows(
					theme,
					dropped.map((entry) => `${keyCap(theme, entry.key)} ${theme.fg("menuDescription", entry.verb)}`),
					width,
				),
			);
		}
		return [...this.windowBoard(board, Math.max(1, this.rows - tail.length), width), ...tail];
	}

	/** The board cut to `room` rows around the selected decision, with a position row when anything is out of view. */
	private windowBoard(board: DecisionsBoardLines, room: number, width: number): string[] {
		if (this.rows <= 0 || board.lines.length <= room) {
			this.offset = 0;
			return board.lines;
		}
		const page = Math.max(1, room - 1);
		const span = board.selectedEnd - board.selectedStart;
		if (board.selectedStart < this.offset) this.offset = board.selectedStart;
		else if (board.selectedEnd > this.offset + page)
			this.offset = span >= page ? board.selectedStart : board.selectedEnd - page;
		const { window, start, position } = windowRows(board.lines, this.offset, page);
		this.offset = start;
		return position ? [...window, positionRow(clioTheme(), { ...position, unit: "lines" }, width)] : window;
	}

	handleInput(data: string): void {
		if (this.correctionInput) {
			this.correctionInput.handleInput(data);
			return;
		}
		const rows = selectableRows(this.readInterviews());
		const armed = this.armedSupersede;
		this.armedSupersede = null;
		if (matchesKey(data, "esc")) {
			backOutOneLayer(this.escapeLayers());
			this.requestRender();
			return;
		}
		if (rows.length === 0) return;
		if (this.status !== null && this.status.kind === "warning") this.status = null;
		if (matchesKey(data, "up") || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.expandedKey = null;
			this.requestRender();
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.selectedIndex = Math.min(rows.length - 1, this.selectedIndex + 1);
			this.expandedKey = null;
			this.requestRender();
			return;
		}
		const jump = listJump(data, this.selectedIndex, rows.length);
		if (jump !== null) {
			this.selectedIndex = jump;
			this.expandedKey = null;
			this.requestRender();
			return;
		}
		const selected = rows[this.selectedIndex];
		if (!selected) return;
		if (matchesKey(data, "enter") || data === "\n" || matchesKey(data, "tab")) {
			const key = decisionRowKey(selected.interview.interviewId, selected.decision.key);
			this.expandedKey = this.expandedKey === key ? null : key;
			this.requestRender();
			return;
		}
		if (matchesKey(data, "x")) {
			if (selected.decision.status !== "active") {
				this.status = { kind: "warning", text: "Already superseded. c gives it a new direction." };
				this.requestRender();
				return;
			}
			const armKey = decisionRowKey(selected.interview.interviewId, selected.decision.key);
			if (armed !== armKey) {
				this.armedSupersede = armKey;
				this.requestRender();
				return;
			}
			try {
				this.options.onSupersede(selectionFor(selected));
				this.status = { kind: "ok", text: "Decision superseded." };
			} catch (error) {
				this.status = { kind: "warning", text: error instanceof Error ? error.message : String(error) };
			}
			this.requestRender();
			return;
		}
		if (matchesKey(data, "c")) this.beginCorrection(selected);
	}

	invalidate(): void {
		this.correctionInput?.invalidate();
	}

	/**
	 * Esc by the shared rule. The correction field handles its own Esc (it keeps
	 * the draft), so its layer here only names it; an expanded decision folds
	 * before the board closes, because the answer was opened to read.
	 */
	private escapeLayers(): EscapeLayers {
		return [
			this.correctionInput !== null && { verb: "back, keeps draft", short: "back", back: () => {} },
			this.expandedKey !== null && {
				verb: "back",
				back: () => {
					this.expandedKey = null;
				},
			},
			{ verb: "close", back: () => this.options.onClose() },
		];
	}

	/** The keys that act on what is on screen now: a board with nothing to select offers only Esc. */
	private railEntries(): HintEntry[] {
		const esc = escapeHintEntry(this.escapeLayers()) ?? { key: "Esc", verb: "close" };
		if (this.correctionInput) return [{ key: "Enter", verb: "send", critical: true }, esc];
		const rows = selectableRows(this.readInterviews());
		const selected = rows[this.selectedIndex];
		if (selected === undefined) return [esc];
		const rowKey = decisionRowKey(selected.interview.interviewId, selected.decision.key);
		if (this.armedSupersede === rowKey) return confirmOnceRail("x", "supersede", selected.decision.key);
		const drafted = keptCorrections.has(rowKey);
		return [
			...(rows.length > 1 ? [{ key: "↑↓", verb: "select" }] : []),
			{ key: "Enter", verb: this.expandedKey === rowKey ? "fold" : "expand" },
			...(selected.decision.status === "active" ? [{ key: "x", verb: "supersede" }] : []),
			{ key: "c", verb: drafted ? "resume draft" : "correct" },
			esc,
		];
	}

	/** The keys the rail drops at this room, fitted by the same call the rail makes, so the two never disagree. */
	private droppedKeys(): HintEntry[] {
		if (this.railRoom <= 0) return [];
		const all = this.railEntries();
		const { kept } = fitHintEntryList(all, this.railRoom);
		return all.filter((entry) => !kept.includes(entry) && entry.key !== "↑↓");
	}

	footerHint(innerWidth: number): string {
		return fitHintEntries(this.railEntries(), innerWidth - 3);
	}

	private readInterviews(): ReadonlyArray<DecisionLedgerEntry> {
		try {
			return this.getInterviews();
		} catch (error) {
			this.status = { kind: "warning", text: error instanceof Error ? error.message : String(error) };
			return [];
		}
	}

	private beginCorrection(selected: SelectableDecision): void {
		const rowKey = decisionRowKey(selected.interview.interviewId, selected.decision.key);
		const input = new Input();
		input.setValue(keptCorrections.get(rowKey) ?? "");
		// End, so a resumed draft continues where it stopped.
		input.handleInput("\x1b[F");
		input.onSubmit = (value) => {
			const correction = value.trim();
			if (correction.length === 0) {
				this.status = { kind: "warning", text: "Type the new direction first, or Esc to go back." };
				this.requestRender();
				return;
			}
			try {
				this.options.onCorrection(selectionFor(selected), correction);
				keptCorrections.delete(rowKey);
			} catch (error) {
				this.status = { kind: "warning", text: error instanceof Error ? error.message : String(error) };
				this.requestRender();
			}
		};
		// Esc leaves the field, not the board, and what was typed stays with the decision.
		input.onEscape = () => {
			const draft = input.getValue();
			this.correctionInput = null;
			this.correctionKey = null;
			if (draft.trim().length > 0) {
				keptCorrections.set(rowKey, draft);
				this.status = { kind: "ok", text: "Draft kept · c reopens it" };
			} else {
				keptCorrections.delete(rowKey);
				this.status = null;
			}
			this.requestRender();
		};
		this.correctionInput = input;
		this.correctionKey = rowKey;
		this.status = null;
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
		markerId: "decisions",
		title: () => "Decisions",
		footerHint: (innerWidth) => body.footerHint(innerWidth),
	});
}
