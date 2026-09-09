import {
	classifyDecisionPresentation,
	type DecisionPresentation,
	decisionFactsForAnswer,
} from "../../domains/safety/decision-presentation.js";
import {
	type Component,
	Editor,
	Input,
	matchesKey,
	type OverlayHandle,
	type SelectItem,
	SelectList,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../../engine/tui.js";
import type { AskUserAnswer, AskUserQuestion, AskUserResult } from "../../tools/ask-user.js";
import { cancelledAskUserResult } from "../../tools/ask-user.js";
import {
	buildHint,
	DEFAULT_SELECT_THEME,
	type HintEntry,
	type OverlayEscVerb,
	showClioOverlayFrame,
} from "../overlay-frame.js";
import { type ClioToken, clioTheme, dotSep, editorTheme, GLYPH, rule, screenTitle } from "../theme/index.js";
import { nextContentScrollOffset, type ViewScrollAction } from "../view/view-overlay.js";

/**
 * The default title and border token for a local conversational answer.
 * Outward and other consequence tiers replace both values with their typed
 * presentation. All ask_user surfaces carry the same classified signal.
 */
const DEFAULT_ASK_USER_PRESENTATION = classifyDecisionPresentation(decisionFactsForAnswer("local"));

export const ASK_USER_DECISION_TONE: ClioToken = DEFAULT_ASK_USER_PRESENTATION.semanticToken;
export const ASK_USER_DECISION_TITLE = DEFAULT_ASK_USER_PRESENTATION.title;
export const ASK_USER_WAITING_TITLE = "Ask User";

/**
 * One box for every request shape.
 *
 * Three surfaces used to answer three request shapes: a fixed 68-column bar for
 * a short question, a fixed 88-column panel for a longer option list, and a
 * full-screen workspace for an interview. The bar cut Daisy's four-part research
 * question to two parts at every terminal width, and the workspace put twelve
 * empty rows between the question and its options. The box now sizes itself to
 * what it has to say, sits above the composer where the operator was typing,
 * and takes a readable measure from the terminal rather than a constant.
 */
export const ASK_USER_MAX_BOX_WIDTH = 100;
export const ASK_USER_MIN_BOX_WIDTH = 40;
const ASK_USER_MARGIN = { top: 1, right: 2, bottom: 1, left: 2 };
/** Two border rows plus the one-row margin above and below. */
const ASK_USER_FRAME_AND_MARGIN_ROWS = 4;
const MIN_INNER_ROWS = 6;
/** The question region keeps at least this many rows before the options window shrinks. */
const MIN_QUESTION_ROWS = 3;
/** Below this width an option's description goes under its label instead of beside it. */
const STACKED_OPTION_WIDTH = 56;
const MAX_LABEL_COLUMN = 30;
const MIN_LABEL_COLUMN = 12;
const ELLIPSIS = "…";
const CONTINUATION_INDENT = "    ";
const TEXT_ASKING_DESCRIPTION = "opens a text field for your answer";

export function askUserBoxWidth(columns: number): number {
	if (!Number.isFinite(columns) || columns <= 0) return ASK_USER_MAX_BOX_WIDTH;
	return Math.max(ASK_USER_MIN_BOX_WIDTH, Math.min(ASK_USER_MAX_BOX_WIDTH, Math.floor(columns) - 4));
}

export interface OpenAskUserOverlayDeps {
	onCancel: () => void;
}

export interface AskUserOverlaySession extends OverlayHandle {
	ask(questions: ReadonlyArray<AskUserQuestion>, presentation?: DecisionPresentation): Promise<AskUserResult>;
	cancel(): void;
	close(): void;
	isWaiting(): boolean;
}

type Mode = "select" | "text";
type InterviewPhase = "waiting" | "asking" | "closed";

interface QuestionState {
	mode: Mode;
	selected: Set<number>;
	customAnswer: string;
	inputValue: string;
	answer: string;
	/**
	 * The operator's typed text exactly as submitted, empty when they typed
	 * nothing. `answer` is the one-line rendering of the whole decision and gets
	 * trimmed and joined; this is the record of what they actually typed, and
	 * losing it is what made an interview re-ask for the same figures three times
	 * (issue #228).
	 */
	rawValue: string;
	focusedValue?: string;
}

export interface AskUserOverlayViewDeps extends OpenAskUserOverlayDeps {
	getTerminalRows: () => number;
	requestRender: () => void;
	/** The engine, for the multi-line answer editor. Absent, the field is a one-line input. */
	tui?: TUI;
}

function questionHasOptions(question: AskUserQuestion): boolean {
	return (question.options?.length ?? 0) > 0;
}

function initialMode(question: AskUserQuestion): Mode {
	return questionHasOptions(question) ? "select" : "text";
}

function createQuestionState(question: AskUserQuestion): QuestionState {
	return {
		mode: initialMode(question),
		selected: new Set<number>(),
		customAnswer: "",
		inputValue: "",
		answer: "",
		rawValue: "",
	};
}

function normalizedLabel(label: string): string {
	return label
		.toLowerCase()
		.replace(/[^a-z0-9']+/g, " ")
		.trim();
}

function isOtherOption(label: string): boolean {
	const normalized = normalizedLabel(label);
	return (
		normalized === "other" ||
		normalized === "custom" ||
		normalized === "something else" ||
		normalized.startsWith("other ")
	);
}

/**
 * An option whose label says the operator is about to type.
 *
 * wtf-MS interviews offer "Provided details" beside "help me explore"; the
 * candidates round offers "Combine or edit; I'll describe". Choosing such an
 * option used to record the bare label, and the model then had a route with no
 * details on it and asked again. Enter on one of these opens the text field
 * with the label kept, the same path `t` takes.
 */
export function optionAsksForText(label: string): boolean {
	if (isOtherOption(label)) return true;
	const normalized = normalizedLabel(label);
	return /\b(provided? details|i'?ll (describe|type|explain|specify|provide|write)|i (will|can) (describe|type|explain|specify|provide|write)|let me (describe|type|explain|specify)|type (it|my|the)|describe (it|my|the|below))\b/u.test(
		normalized,
	);
}

function optionItems(question: AskUserQuestion, selected: ReadonlySet<number>): SelectItem[] {
	const options = question.options ?? [];
	const explicitOtherIndex = options.findIndex((option) => isOtherOption(option.label));
	const items: SelectItem[] = [];
	for (let index = 0; index < options.length; index += 1) {
		const option = options[index];
		if (!option) continue;
		const isExplicitOther = index === explicitOtherIndex;
		const label =
			question.multi_select === true && !isExplicitOther
				? `${selected.has(index) ? "[x]" : "[ ]"} ${option.label}`
				: option.label;
		const item: SelectItem = {
			value: isExplicitOther ? "other" : `option:${index}`,
			label,
		};
		if (option.description) item.description = option.description;
		else if (optionAsksForText(option.label)) item.description = TEXT_ASKING_DESCRIPTION;
		items.push(item);
	}
	if (explicitOtherIndex === -1) {
		// The implicit choice is one word on screen; its description says what it
		// does, and the tool's longer label is what the answer records.
		items.push({
			value: "other",
			label: question.multi_select === true ? "[ ] Other" : "Other",
			description: "type your answer",
		});
	}
	return items;
}

function optionIndexFromValue(value: string): number | null {
	if (!value.startsWith("option:")) return null;
	const index = Number(value.slice("option:".length));
	return Number.isInteger(index) && index >= 0 ? index : null;
}

/** The labels the operator chose, in list order. */
function selectedOptionLabels(question: AskUserQuestion, selected: ReadonlySet<number>): string[] {
	const labels: string[] = [];
	for (const index of [...selected].sort((a, b) => a - b)) {
		const label = question.options?.[index]?.label;
		if (label) labels.push(label);
	}
	return labels;
}

function answerText(question: AskUserQuestion, selected: ReadonlySet<number>, customAnswer: string): string {
	const parts = selectedOptionLabels(question, selected);
	const custom = customAnswer.trim();
	if (custom.length > 0) parts.push(custom);
	return parts.join("; ");
}

function fitLine(text: string, width: number): string {
	const safeWidth = Math.max(1, width);
	if (visibleWidth(text) <= safeWidth) return text;
	return truncateToWidth(text, safeWidth, ELLIPSIS, true);
}

/** Wrap a prose value inside the columns left by its one-time row label. */
function wrapLabeledValue(prefix: string, value: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const prefixWidth = visibleWidth(prefix);
	const valueWidth = Math.max(1, safeWidth - prefixWidth);
	return wrapTextWithAnsi(value, valueWidth).map(
		(line, index) => `${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`,
	);
}

function compactTitle(question: AskUserQuestion): string {
	return (question.header ?? question.question).replace(/\s+/g, " ").trim();
}

const BOLD_SPAN = /\*\*([^*\n]+?)\*\*/gu;
const LIST_MARKER = /^(\s*)(\d{1,2}[.)]|[-*•])\s+(.*)$/u;

function inlineMarkdown(text: string): string {
	const theme = clioTheme();
	return text.replace(BOLD_SPAN, (_match, inner: string) => theme.paint(inner, { bold: true }));
}

/**
 * The question, wrapped to the width and never cut.
 *
 * A model writes a question the way it writes prose: `**Domain**` for emphasis
 * and `1.` lists for the parts it wants answered. The old body rendered the
 * asterisks literally and wrapped a list item's second row back to column zero,
 * where it read as a new paragraph. Bold spans render bold, list items hang
 * under their marker, and blank lines survive one deep so paragraphs stay apart.
 */
export function formatAskUserQuestion(text: string, width: number): string[] {
	const safeWidth = Math.max(4, width);
	const lines: string[] = [];
	let previousBlank = true;
	for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
		const line = raw.replace(/\t/g, "    ").trimEnd();
		if (line.trim().length === 0) {
			if (!previousBlank) lines.push("");
			previousBlank = true;
			continue;
		}
		previousBlank = false;
		const list = LIST_MARKER.exec(line);
		if (list) {
			const lead = list[1] ?? "";
			const marker = (list[2] ?? "").replace(/^[-*]$/u, "•");
			const rest = list[3] ?? "";
			const prefix = `${lead}${marker} `;
			const indent = " ".repeat(visibleWidth(prefix));
			const wrapped = wrapTextWithAnsi(inlineMarkdown(rest), Math.max(4, safeWidth - indent.length));
			wrapped.forEach((part, index) => {
				lines.push(`${index === 0 ? prefix : indent}${part}`);
			});
			continue;
		}
		// An indented line is a continuation the author laid out by hand, such as
		// the "In: … · Out: …" row under a candidate; its wrapped rows keep the
		// indent so they read as part of it rather than as a new paragraph.
		const lead = /^\s*/u.exec(line)?.[0] ?? "";
		const wrapped = wrapTextWithAnsi(inlineMarkdown(line.slice(lead.length)), Math.max(4, safeWidth - lead.length));
		lines.push(...wrapped.map((part) => `${lead}${part}`));
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** The typed answer box: a small editor whose chrome is a caption above and a key hint below. */
class AnswerEditor extends Editor {
	caption = "";

	constructor(tui: TUI) {
		super(tui, editorTheme(clioTheme()), { paddingX: 0 });
		// The overlay forwards keys itself, so the engine never focuses this
		// editor; the flag is what draws the cursor.
		this.focused = true;
	}

	protected override renderTopBorder(width: number): string {
		const theme = clioTheme();
		return fitLine(theme.fg("dim", this.caption), width);
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		if (hiddenLineCount <= 0) return "";
		return fitLine(clioTheme().fg("dim", `${GLYPH.down} ${hiddenLineCount} more rows`), width);
	}
}

/** One shape over the two text controls, so the view never asks which it holds. */
interface TextControl {
	render(width: number): string[];
	handleInput(data: string): void;
	getText(): string;
	setText(text: string): void;
	invalidate(): void;
}

class InputTextControl implements TextControl {
	constructor(
		private readonly input: Input,
		private readonly caption: string,
	) {}

	render(width: number): string[] {
		const theme = clioTheme();
		const rows = this.input
			.render(width)
			.map((line) =>
				fitLine(line.startsWith("> ") ? `${theme.fg("accent", `${GLYPH.cursor} `)}${line.slice(2)}` : line, width),
			);
		return [fitLine(theme.fg("dim", this.caption), width), ...rows];
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}

	getText(): string {
		return this.input.getValue();
	}

	setText(text: string): void {
		this.input.setValue(text);
	}

	invalidate(): void {
		this.input.invalidate();
	}
}

class EditorTextControl implements TextControl {
	constructor(private readonly editor: AnswerEditor) {}

	render(width: number): string[] {
		return this.editor.render(width);
	}

	handleInput(data: string): void {
		this.editor.handleInput(data);
	}

	getText(): string {
		return this.editor.getText();
	}

	setText(text: string): void {
		this.editor.setText(text);
	}

	invalidate(): void {
		this.editor.invalidate();
	}
}

interface OptionRowLayout {
	/** Rows per item, in item order. */
	rows: string[][];
}

/**
 * Every option, with its whole description.
 *
 * A description is what the operator is choosing between: "+Latency,
 * +Simplicity. Good for: Financial, Auth" is the trade-off, and the old table
 * cut it to its first clause on every row the cursor was not on. Every row now
 * wraps its description beside the label, or under it when the box is too
 * narrow for two columns, and the row carries no key: the footer does.
 */
function layoutOptionRows(items: ReadonlyArray<SelectItem>, focusedIndex: number, width: number): OptionRowLayout {
	const theme = clioTheme();
	const safeWidth = Math.max(8, width);
	const stacked = safeWidth < STACKED_OPTION_WIDTH;
	const widestLabel = items.reduce((max, item) => Math.max(max, visibleWidth(item.label)), 0);
	const labelColumn = Math.max(
		MIN_LABEL_COLUMN,
		Math.min(MAX_LABEL_COLUMN, Math.floor(safeWidth * 0.42), widestLabel + 2),
	);
	const rows: string[][] = [];
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		if (!item) continue;
		const focused = index === focusedIndex;
		const prefix = focused ? theme.fg("accent", `${GLYPH.cursor} `) : "  ";
		const description = item.description?.replace(/[\r\n]+/g, " ").trim() ?? "";
		const paint = (text: string): string => (focused ? theme.style("accent", text, { bold: true }) : text);
		const describe = (text: string): string => (focused ? text : theme.fg("muted", text));
		if (description.length === 0) {
			rows.push(
				wrapTextWithAnsi(paint(item.label), Math.max(4, safeWidth - 2)).map(
					(line, at) => `${at === 0 ? prefix : "  "}${line}`,
				),
			);
			continue;
		}
		if (stacked || visibleWidth(item.label) > labelColumn - 1) {
			const labelRows = wrapTextWithAnsi(paint(item.label), Math.max(4, safeWidth - 2)).map(
				(line, at) => `${at === 0 ? prefix : "  "}${line}`,
			);
			const descriptionRows = wrapTextWithAnsi(
				describe(description),
				Math.max(4, safeWidth - CONTINUATION_INDENT.length),
			).map((line) => `${CONTINUATION_INDENT}${line}`);
			rows.push([...labelRows, ...descriptionRows]);
			continue;
		}
		const spacing = " ".repeat(Math.max(1, labelColumn - visibleWidth(item.label)));
		const descriptionWidth = Math.max(4, safeWidth - 2 - labelColumn);
		const wrapped = wrapTextWithAnsi(describe(description), descriptionWidth);
		const indent = " ".repeat(2 + labelColumn);
		rows.push([
			`${prefix}${paint(item.label)}${spacing}${wrapped[0] ?? ""}`,
			...wrapped.slice(1).map((line) => `${indent}${line}`),
		]);
	}
	return { rows };
}

/**
 * The rows of a windowed list: every option when they fit, otherwise a run of
 * whole options around the focused one, with a position marker. An option is
 * never split across the window edge, so a description is read whole or not
 * at all, and one arrow key brings any hidden option back.
 */
function windowOptionRows(layout: OptionRowLayout, focusedIndex: number, rowBudget: number, width: number): string[] {
	const theme = clioTheme();
	const total = layout.rows.reduce((sum, rows) => sum + rows.length, 0);
	if (total <= rowBudget) return layout.rows.flat();
	const budget = Math.max(1, rowBudget - 1);
	const focusedRows = layout.rows[focusedIndex]?.length ?? 1;
	let start = focusedIndex;
	let end = focusedIndex + 1;
	let used = focusedRows;
	// Grow around the focus, later options first so the reading order continues
	// downward, then earlier ones.
	let grew = true;
	while (grew) {
		grew = false;
		const after = layout.rows[end]?.length;
		if (after !== undefined && used + after <= budget) {
			used += after;
			end += 1;
			grew = true;
		}
		const before = layout.rows[start - 1]?.length;
		if (before !== undefined && used + before <= budget) {
			used += before;
			start -= 1;
			grew = true;
		}
	}
	const visible = layout.rows.slice(start, end).flat();
	const marker = `  (${focusedIndex + 1}/${layout.rows.length})${start > 0 ? ` ${GLYPH.up}` : ""}${end < layout.rows.length ? ` ${GLYPH.down}` : ""}`;
	return [...visible, fitLine(theme.fg("dim", marker), width)];
}

class AskUserOverlayView implements Component {
	private phase: InterviewPhase = "waiting";
	private index = 0;
	private status = "";
	private questions: ReadonlyArray<AskUserQuestion> = [];
	private states: QuestionState[] = [];
	private history: AskUserAnswer[] = [];
	/** Rounds answered so far; the strip and header count these, not answers. */
	private roundsAnswered = 0;
	private list: SelectList | null = null;
	private text: TextControl | null = null;
	private resolveCurrent: ((result: AskUserResult) => void) | null = null;
	/** Rows of the question region already scrolled past. */
	private questionScroll = 0;
	private questionOverflows = false;
	private questionRegionRows = 1;
	private questionTotalRows = 0;
	private ledgerExpanded = false;
	private detailsExpanded = false;
	private presentation: DecisionPresentation = DEFAULT_ASK_USER_PRESENTATION;

	constructor(private readonly deps: AskUserOverlayViewDeps) {}

	begin(
		questions: ReadonlyArray<AskUserQuestion>,
		presentation: DecisionPresentation = DEFAULT_ASK_USER_PRESENTATION,
	): Promise<AskUserResult> {
		if (this.phase === "closed") return Promise.resolve(cancelledAskUserResult());
		if (this.resolveCurrent) return Promise.resolve(cancelledAskUserResult());
		this.phase = "asking";
		this.index = 0;
		this.status = "";
		this.questions = [...questions];
		this.presentation = presentation;
		this.states = this.questions.map((question) => createQuestionState(question));
		this.list = null;
		this.text = null;
		this.detailsExpanded = false;
		this.resetQuestionScroll();
		this.rebuildControl();
		this.deps.requestRender();
		return new Promise<AskUserResult>((resolve) => {
			this.resolveCurrent = resolve;
		});
	}

	cancel(): void {
		this.finish(cancelledAskUserResult());
	}

	close(): void {
		this.phase = "closed";
		this.finish(cancelledAskUserResult());
	}

	isWaiting(): boolean {
		return this.phase === "waiting" && this.resolveCurrent === null;
	}

	/** True while the overlay is holding a question the operator has to answer. */
	isDecisionPending(): boolean {
		return this.phase === "asking";
	}

	decisionTitle(): string {
		return this.presentation.title;
	}

	decisionTone(): ClioToken {
		return this.presentation.semanticToken;
	}

	invalidate(): void {
		this.list?.invalidate();
		this.text?.invalidate();
	}

	handleInput(data: string): void {
		if (this.phase !== "asking") return;
		const question = this.currentQuestion();
		const state = this.currentState();
		if (!question || !state) return;

		// Scrolling the question must not cost the operator their place in the
		// options, so the region has keys of its own that neither control claims.
		if (this.handleScrollInput(data, state.mode)) return;

		if (state.mode === "text") {
			if (matchesKey(data, "escape")) {
				this.escapeFromTextInput(question, state);
				return;
			}
			if (this.isTextModePreviousKey(data)) {
				this.goToRelativeQuestion(-1);
				return;
			}
			if (this.isTextModeNextKey(data)) {
				this.goToRelativeQuestion(1);
				return;
			}
			this.text?.handleInput(data);
			return;
		}

		if (this.isPreviousQuestionKey(data)) {
			this.goToRelativeQuestion(-1);
			return;
		}
		if (this.isNextQuestionKey(data)) {
			this.goToRelativeQuestion(1);
			return;
		}
		if (question.multi_select === true && data === " ") {
			this.toggleCurrentSelection(question, state);
			return;
		}
		if (question.multi_select === true && (matchesKey(data, "enter") || data === "\n")) {
			this.commitMultiSelectOrOpenOther(state);
			return;
		}
		if (this.isAddTextKey(data)) {
			this.chooseFocusedAndOpenText(question, state);
			return;
		}
		if (data === "a" && this.ledgerEntries().length > 0) {
			this.ledgerExpanded = !this.ledgerExpanded;
			this.deps.requestRender();
			return;
		}
		if (data === "?") {
			this.detailsExpanded = !this.detailsExpanded;
			this.deps.requestRender();
			return;
		}
		this.list?.handleInput(data);
	}

	/**
	 * The body, top to bottom: where the round stands, the question, its
	 * options or the answer field, the status, and the answers so far. The
	 * question region is the one part that scrolls; everything the operator has
	 * to act on stays on screen at its full row cost, and the box draws only the
	 * rows it needs.
	 */
	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const maxRows = this.maxInnerRows();
		if (this.phase !== "asking") return this.renderWaiting(safeWidth, maxRows);
		const question = this.currentQuestion();
		if (!question) return [clioTheme().fg("muted", "No questions.")];

		const strip = this.renderQuestionStrip(safeWidth);
		const header = this.renderQuestionHeader(question, safeWidth);
		const details = this.renderDecisionContext(safeWidth);
		const status = this.status.length > 0 ? wrapTextWithAnsi(clioTheme().fg("dim", this.status), safeWidth) : [];
		const body = formatAskUserQuestion(question.question, safeWidth);
		const fixedTop = [...strip, ...header, ...details];
		// The control is sized after the question has claimed its minimum, so a
		// long option list cannot push a short question off the box.
		const controlBudget = Math.max(
			4,
			maxRows - fixedTop.length - 1 - status.length - Math.min(body.length, MIN_QUESTION_ROWS) - 1,
		);
		const control = this.renderControlLines(safeWidth, controlBudget);
		const ledgerBudget = Math.max(
			1,
			maxRows - fixedTop.length - 1 - control.length - status.length - Math.min(body.length, MIN_QUESTION_ROWS),
		);
		const ledger = this.renderAnswerLedger(safeWidth, ledgerBudget);
		const fixed = fixedTop.length + 1 + control.length + status.length + ledger.length;

		const regionRows = Math.max(1, Math.min(body.length, maxRows - fixed));
		const overflows = body.length > regionRows;
		this.questionOverflows = overflows;
		this.questionTotalRows = body.length;
		const viewRows = overflows ? Math.max(1, regionRows - 1) : regionRows;
		this.questionRegionRows = viewRows;
		this.questionScroll = Math.max(0, Math.min(this.questionScroll, Math.max(0, body.length - viewRows)));
		const visible = body.slice(this.questionScroll, this.questionScroll + viewRows);
		if (overflows) visible.push(fitLine(clioTheme().fg("dim", this.scrollIndicator(body.length, viewRows)), safeWidth));

		return [...fixedTop, ...visible, "", ...control, ...status, ...ledger].slice(0, maxRows);
	}

	private scrollIndicator(total: number, viewRows: number): string {
		const above = this.questionScroll;
		const below = Math.max(0, total - viewRows - above);
		const parts: string[] = [];
		if (above > 0) parts.push(`${GLYPH.up} ${above} more`);
		if (below > 0) parts.push(`${GLYPH.down} ${below} more`);
		parts.push("PgUp/PgDn");
		return parts.join("  ");
	}

	/** True when the key belonged to the question region rather than to a control. */
	private handleScrollInput(data: string, mode: Mode): boolean {
		if (!this.questionOverflows) return false;
		const action = this.scrollAction(data, mode);
		if (!action) return false;
		const next = nextContentScrollOffset(this.questionScroll, this.questionTotalRows, this.questionRegionRows, action);
		if (next !== this.questionScroll) {
			this.questionScroll = next;
			this.deps.requestRender();
		}
		return true;
	}

	private scrollAction(data: string, mode: Mode): ViewScrollAction | null {
		if (matchesKey(data, "pageUp")) return "page-up";
		if (matchesKey(data, "pageDown")) return "page-down";
		// Ctrl+U and Ctrl+D are line-kill and half-page in a text field, so they
		// stay with the input while one is focused.
		if (mode === "select" && matchesKey(data, "ctrl+u")) return "half-up";
		if (mode === "select" && matchesKey(data, "ctrl+d")) return "half-down";
		return null;
	}

	private resetQuestionScroll(): void {
		this.questionScroll = 0;
	}

	footerHint(): string {
		if (this.phase !== "asking") return buildHint([]);
		const question = this.currentQuestion();
		const state = this.currentState();
		if (!question || !state) return buildHint([]);
		const recordAnswer =
			this.presentation.requiredActions.find((action) => action.id === "record-answer")?.label.toLowerCase() ??
			"record answer";
		const scroll: HintEntry[] = this.questionOverflows ? [{ key: "PgUp/PgDn", verb: "scroll" }] : [];
		if (state.mode === "text") {
			// Esc means two different things depending on what is behind the field.
			// A question with options has a list to fall back to, so the key goes
			// back; a question without one has nothing behind it and the key still
			// leaves the interview. The footer says which one this is.
			const escapeVerb: OverlayEscVerb = questionHasOptions(question) ? "back" : "close";
			const entries: HintEntry[] = [{ key: "Enter", verb: recordAnswer }];
			if (this.deps.tui) entries.push({ key: "Shift+Enter", verb: "newline" });
			if (this.questions.length > 1) entries.push({ key: "Alt+Left/Right", verb: "question" });
			return buildHint([...entries, ...scroll], escapeVerb);
		}
		const entries: HintEntry[] = [];
		if (this.questions.length > 1) entries.push({ key: "Left/Right", verb: "question" });
		if (question.multi_select === true) entries.push({ key: "Space", verb: "toggle" });
		// `t` is on every select footer because the operator cannot tell from a
		// label whether the option needs a figure attached until they read it.
		entries.push({ key: "t", verb: "add text", short: "text" });
		entries.push({ key: "Enter", verb: recordAnswer });
		if (this.ledgerEntries().length > 0) entries.push({ key: "a", verb: "answers" });
		entries.push({ key: "?", verb: "details" });
		return buildHint([...entries, ...scroll]);
	}

	/**
	 * The classified context, folded.
	 *
	 * Tier, requester, effect, and reversibility used to take four rows above
	 * every question, and for a local conversational answer they say nothing the
	 * title ("Answer a question") does not. They render on `?`; a tier that is
	 * not the default one keeps its one-line identity on screen because that is
	 * the row that says the answer reaches outside the workspace.
	 */
	private renderDecisionContext(width: number): string[] {
		const theme = clioTheme();
		const lines: string[] = [];
		const defaultTier = this.presentation.tier === DEFAULT_ASK_USER_PRESENTATION.tier;
		if (!defaultTier || this.detailsExpanded) {
			const tier = theme.style(this.presentation.semanticToken, this.presentation.tierLabel, { bold: true });
			const requested = theme.fg("dim", `requested by ${this.presentation.requestedByCopy}`);
			lines.push(fitLine(`${tier}${dotSep(theme)}${requested}`, width));
		}
		if (this.detailsExpanded) {
			lines.push(
				...wrapTextWithAnsi(
					`${theme.fg("dim", "Effect:")} ${theme.fg("muted", this.presentation.authorizationCopy)}`,
					width,
				),
				...wrapTextWithAnsi(theme.fg("muted", this.presentation.reversibilityCopy), width),
				"",
			);
		}
		return lines;
	}

	private finish(result: AskUserResult): void {
		const resolve = this.resolveCurrent;
		this.resolveCurrent = null;
		this.list = null;
		this.text = null;
		this.status = "";
		if (result.cancelled !== true) {
			this.history.push(...result.answers);
			this.roundsAnswered += 1;
		}
		if (this.phase !== "closed") this.phase = "waiting";
		this.deps.requestRender();
		resolve?.(result);
	}

	private renderWaiting(width: number, maxRows: number): string[] {
		const theme = clioTheme();
		const lines = [
			fitLine(
				`${screenTitle(theme, "Interview")}${dotSep(theme)}${theme.fg(
					"muted",
					this.history.length > 0 ? "answer sent · waiting for the next question" : "waiting for the first question",
				)}`,
				width,
			),
		];
		const ledger = this.renderAnswerLedger(width, Math.max(1, maxRows - lines.length));
		return [...lines, ...ledger].slice(0, maxRows);
	}

	/**
	 * Rows the body may draw. The frame budgets the same number from the live
	 * terminal, so the body never hands the frame more than it can draw and the
	 * frame's "… N more rows" cut never fires on a decision.
	 */
	private maxInnerRows(): number {
		const rows = this.deps.getTerminalRows();
		if (!Number.isFinite(rows) || rows <= 0) return 40;
		return Math.max(MIN_INNER_ROWS, Math.floor(rows) - ASK_USER_FRAME_AND_MARGIN_ROWS);
	}

	private currentQuestion(): AskUserQuestion | null {
		return this.questions[this.index] ?? null;
	}

	private currentState(): QuestionState | null {
		return this.states[this.index] ?? null;
	}

	private isPreviousQuestionKey(data: string): boolean {
		return this.questions.length > 1 && matchesKey(data, "left");
	}

	private isNextQuestionKey(data: string): boolean {
		return this.questions.length > 1 && matchesKey(data, "right");
	}

	private isTextModePreviousKey(data: string): boolean {
		return this.questions.length > 1 && (matchesKey(data, "alt+left") || matchesKey(data, "ctrl+left"));
	}

	private isTextModeNextKey(data: string): boolean {
		return this.questions.length > 1 && (matchesKey(data, "alt+right") || matchesKey(data, "ctrl+right"));
	}

	/**
	 * The key that adds typed text to the option under the cursor.
	 *
	 * Choosing an option used to be the whole answer, so a model that offered
	 * "Exact number - I'll type it" gave the operator a label and nowhere to put
	 * the number; the interview then spent two of its four rounds asking for the
	 * figures again (issue #228). The list itself only reads the arrows, Enter,
	 * and Esc, so a letter is free here.
	 */
	private isAddTextKey(data: string): boolean {
		return matchesKey(data, "t");
	}

	/**
	 * Take the focused option and open the text field for it, without committing.
	 * Submitting the text records the label and the text together.
	 */
	private chooseFocusedAndOpenText(question: AskUserQuestion, state: QuestionState): void {
		const current = this.list?.getSelectedItem();
		const optionIndex = current && current.value !== "other" ? optionIndexFromValue(current.value) : null;
		let label: string | undefined;
		if (optionIndex !== null) {
			if (question.multi_select === true) state.selected.add(optionIndex);
			else state.selected = new Set<number>([optionIndex]);
			state.focusedValue = `option:${optionIndex}`;
			label = question.options?.[optionIndex]?.label;
		}
		this.openTextInput(label ? `Your answer, with "${label}"` : "Your answer");
	}

	/**
	 * The row above the question: its header, and the round for a phased
	 * interview. `Question 1/1` was a counter over a set of one, printed on every
	 * confirmation; a round of several questions names them in the strip instead.
	 */
	private renderQuestionHeader(question: AskUserQuestion, width: number): string[] {
		const theme = clioTheme();
		const parts: string[] = [];
		if (question.header) parts.push(screenTitle(theme, question.header));
		if (this.questions.length <= 1 && this.roundsAnswered > 0) {
			parts.push(theme.fg("dim", `Round ${this.roundsAnswered + 1}`));
		}
		if (this.currentState()?.answer.trim()) parts.push(theme.fg("muted", "answered"));
		return parts.length > 0 ? wrapTextWithAnsi(parts.join(dotSep(theme)), width) : [];
	}

	/**
	 * The questions of this round, by name.
	 *
	 * Four fixed slots at 80 columns left three characters of each header
	 * ("Con…", "Sam…"), which is the strip saying nothing. The names now flow on
	 * one row and wrap to a second when they must; a question that has been
	 * answered carries a check, the active one carries the cursor.
	 */
	private renderQuestionStrip(width: number): string[] {
		const theme = clioTheme();
		if (this.questions.length <= 1) return [];
		const parts = this.questions.map((question, index) => {
			const state = this.states[index];
			const active = index === this.index;
			const answered = Boolean(state?.answer.trim());
			const mark = answered ? `${theme.fg("success", GLYPH.ok)} ` : "";
			const name = `Q${index + 1} ${compactTitle(question)}`;
			const title = active
				? `${theme.fg("accent", GLYPH.cursor)} ${theme.style("accent", name, { bold: true })}`
				: theme.fg(answered ? "muted" : "dim", name);
			return `${mark}${title}`;
		});
		const round = this.roundsAnswered > 0 ? [theme.fg("dim", `Round ${this.roundsAnswered + 1}`)] : [];
		const strip = wrapTextWithAnsi([...round, ...parts].join(dotSep(theme)), width).slice(0, 2);
		return [...strip, ""];
	}

	private renderControlLines(width: number, rowBudget: number): string[] {
		this.ensureControl();
		const state = this.currentState();
		if (state?.mode === "text") return this.text?.render(width) ?? [""];
		return this.renderSelectControl(width, rowBudget);
	}

	/** Earlier rounds first, then this round's answered siblings. */
	private ledgerEntries(): Array<{ label: string; answer: string }> {
		const entries: Array<{ label: string; answer: string }> = [];
		this.history.forEach((answer, index) => {
			entries.push({ label: `${index + 1}.`, answer: answer.answer });
		});
		if (this.questions.length > 1) {
			this.states.forEach((state, index) => {
				const answer = state.answer.trim();
				if (answer.length > 0 && index !== this.index) entries.push({ label: `Q${index + 1}`, answer });
			});
		}
		return entries;
	}

	/**
	 * What the interview has captured, folded to one row.
	 *
	 * The full ledger used to sit between the question and its options and grow
	 * by the whole typed answer every round, so by the fourth question the
	 * options were twenty rows below the sentence they answered. The ledger is
	 * one dim row under the options until `a` opens it.
	 */
	private renderAnswerLedger(width: number, rowBudget: number): string[] {
		const theme = clioTheme();
		const entries = this.ledgerEntries();
		if (entries.length === 0) return [];
		const count = `${entries.length} earlier answer${entries.length === 1 ? "" : "s"}`;
		if (!this.ledgerExpanded) return ["", fitLine(theme.fg("dim", `${count} · a to review`), width)];
		const rows: string[] = [];
		for (const entry of entries) {
			rows.push(...wrapLabeledValue(`${theme.fg("dim", entry.label)} `, theme.fg("muted", entry.answer), width));
		}
		const head = ["", fitLine(rule(theme, width, { left: "Answers", leftToken: "dim" }), width)];
		const budget = Math.max(1, rowBudget - head.length);
		if (rows.length <= budget) return [...head, ...rows];
		const kept = rows.slice(0, Math.max(0, budget - 1));
		return [
			...head,
			...kept,
			fitLine(theme.fg("dim", `${GLYPH.ellipsis} ${rows.length - kept.length} more on /decisions`), width),
		];
	}

	private renderSelectControl(width: number, rowBudget: number): string[] {
		const question = this.currentQuestion();
		const state = this.currentState();
		const selectedItem = this.list?.getSelectedItem();
		if (!question || !state || !selectedItem) return [""];
		const items = optionItems(question, state.selected);
		const focusedIndex = Math.max(
			0,
			items.findIndex((item) => item.value === selectedItem.value),
		);
		return windowOptionRows(layoutOptionRows(items, focusedIndex, width), focusedIndex, rowBudget, width);
	}

	private ensureControl(): void {
		const question = this.currentQuestion();
		const state = this.currentState();
		if (!question || !state) return;
		if (state.mode === "text" && !this.text) this.rebuildTextInput(question, state, "Your answer");
		if (state.mode === "select" && !this.list) this.rebuildSelectList(question, state);
	}

	private rebuildControl(): void {
		const question = this.currentQuestion();
		const state = this.currentState();
		if (!question || !state) {
			this.text = null;
			this.list = null;
			return;
		}
		if (state.mode === "text") this.rebuildTextInput(question, state, "Your answer");
		else this.rebuildSelectList(question, state);
	}

	private submitText(question: AskUserQuestion, state: QuestionState, value: string): void {
		const answer = value.trim();
		if (answer.length === 0) {
			this.status = "Enter an answer or press Esc to cancel.";
			this.deps.requestRender();
			return;
		}
		state.inputValue = answer;
		// Verbatim, before any joining or trimming the display line does. The
		// typed text is the answer; the one-line `answer` is a rendering of it.
		state.rawValue = value;
		if (questionHasOptions(question) && question.multi_select === true) {
			state.customAnswer = answer;
			this.commitCurrentAnswer();
			return;
		}
		state.customAnswer = questionHasOptions(question) ? answer : "";
		// The chosen labels and the typed text compose, so a question answered
		// with an option that says "I will type it" keeps both. With nothing
		// selected, which is the implicit Other path, this is the text alone.
		state.answer = questionHasOptions(question)
			? answerText(question, state.selected, state.customAnswer)
			: answer.replace(/\s*\n\s*/g, " ");
		this.finishIfCompleteOrAdvance();
	}

	private rebuildTextInput(question: AskUserQuestion, state: QuestionState, caption: string): void {
		const initial = state.inputValue || state.customAnswer || state.answer;
		if (this.deps.tui) {
			const editor = new AnswerEditor(this.deps.tui);
			editor.caption = caption;
			editor.setText(initial);
			editor.onSubmit = (value) => this.submitText(question, state, value);
			this.text = new EditorTextControl(editor);
		} else {
			const input = new Input();
			input.setValue(initial);
			input.onSubmit = (value) => this.submitText(question, state, value);
			this.text = new InputTextControl(input, caption);
		}
		this.list = null;
	}

	private rebuildSelectList(question: AskUserQuestion, state: QuestionState): void {
		const items = optionItems(question, state.selected);
		const activeList = new SelectList(items, Math.max(1, items.length), DEFAULT_SELECT_THEME, {
			minPrimaryColumnWidth: MIN_LABEL_COLUMN,
			maxPrimaryColumnWidth: MAX_LABEL_COLUMN,
		});
		activeList.onSelect = (item) => {
			if (item.value === "other") {
				this.openTextInput("Your answer");
				return;
			}
			const optionIndex = optionIndexFromValue(item.value);
			if (optionIndex === null) return;
			if (question.multi_select === true) {
				this.toggleSelectionIndex(question, state, optionIndex);
				return;
			}
			const label = question.options?.[optionIndex]?.label ?? item.label;
			if (optionAsksForText(label)) {
				this.chooseFocusedAndOpenText(question, state);
				return;
			}
			state.selected = new Set<number>([optionIndex]);
			// Choosing a plain option is a label-only answer, so the typed text
			// clears with the choice: it was given for a label the operator has
			// just moved off, and the composed answer runs through the same
			// `answerText` every other path uses.
			state.customAnswer = "";
			state.rawValue = "";
			state.inputValue = "";
			state.answer = answerText(question, state.selected, state.customAnswer) || item.label;
			state.focusedValue = item.value;
			this.status = "";
			this.finishIfCompleteOrAdvance();
		};
		activeList.onCancel = () => this.cancel();
		activeList.onSelectionChange = (item) => {
			state.focusedValue = item.value;
		};
		const selectedIndex = this.preferredSelectedIndex(question, state, items);
		if (selectedIndex >= 0) activeList.setSelectedIndex(selectedIndex);
		this.text = null;
		this.list = activeList;
	}

	private preferredSelectedIndex(
		question: AskUserQuestion,
		state: QuestionState,
		items: ReadonlyArray<SelectItem>,
	): number {
		if (state.focusedValue) {
			const focused = items.findIndex((item) => item.value === state.focusedValue);
			if (focused >= 0) return focused;
		}
		const firstSelected = [...state.selected][0];
		if (firstSelected !== undefined) {
			const selected = items.findIndex((item) => item.value === `option:${firstSelected}`);
			if (selected >= 0) return selected;
		}
		if (state.customAnswer.length > 0 || (questionHasOptions(question) && isOtherOption(state.answer))) {
			const other = items.findIndex((item) => item.value === "other");
			if (other >= 0) return other;
		}
		return 0;
	}

	/**
	 * Esc in the text field.
	 *
	 * The field used to resolve the whole round as cancelled, which made a typed
	 * draft unrecoverable: a single-question round had no other question to answer
	 * first, so the only way off `t` was to abandon the interview (issue #260). A
	 * question with options has a surface behind the field, so Esc goes back to it
	 * and drops the draft. A question with no options has nothing behind it, so Esc
	 * keeps its old meaning and leaves the interview; the footer says which.
	 *
	 * The draft is dropped rather than parked because Esc is the discard gesture.
	 * It never reached `answer`, `options`, or `value` in the first place, since
	 * only a submit writes those, so #228's clearing rule holds either way.
	 */
	private escapeFromTextInput(question: AskUserQuestion, state: QuestionState): void {
		if (!questionHasOptions(question)) {
			this.cancel();
			return;
		}
		state.inputValue = "";
		state.mode = "select";
		this.status = "";
		this.rebuildSelectList(question, state);
		this.deps.requestRender();
	}

	/**
	 * Leave a question the operator is walking away from on its option list.
	 *
	 * The mode used to belong to the question for the rest of the round, so a
	 * question opened with `t` came back as a prefilled field however the operator
	 * returned to it, and the option list was gone for good. Navigating away is not
	 * the discard gesture, so the draft stays in `inputValue` and `t` finds it
	 * again; what does not survive is the field being the thing that greets them.
	 *
	 * A question whose value was actually submitted keeps its field, because
	 * coming back to a recorded figure is how it gets revised (issue #228).
	 */
	private parkTextMode(): void {
		const question = this.currentQuestion();
		const state = this.currentState();
		if (!question || !state) return;
		if (state.mode !== "text" || !questionHasOptions(question)) return;
		if (state.rawValue.length > 0) return;
		state.mode = "select";
	}

	private openTextInput(caption: string): void {
		const state = this.currentState();
		const question = this.currentQuestion();
		if (!state || !question) return;
		this.syncActiveControl();
		state.mode = "text";
		this.status = "";
		this.rebuildTextInput(question, state, caption);
		this.deps.requestRender();
	}

	private toggleCurrentSelection(question: AskUserQuestion, state: QuestionState): void {
		const current = this.list?.getSelectedItem();
		if (!current) return;
		if (current.value === "other") {
			this.openTextInput("Your answer");
			return;
		}
		const optionIndex = optionIndexFromValue(current.value);
		if (optionIndex === null) return;
		this.toggleSelectionIndex(question, state, optionIndex);
	}

	private toggleSelectionIndex(question: AskUserQuestion, state: QuestionState, optionIndex: number): void {
		if (state.selected.has(optionIndex)) state.selected.delete(optionIndex);
		else state.selected.add(optionIndex);
		state.focusedValue = `option:${optionIndex}`;
		this.status = "";
		this.rebuildSelectList(question, state);
		this.deps.requestRender();
	}

	private commitMultiSelectOrOpenOther(state: QuestionState): void {
		const current = this.list?.getSelectedItem();
		if (current?.value === "other") {
			this.openTextInput("Your answer");
			return;
		}
		const optionIndex = current ? optionIndexFromValue(current.value) : null;
		if (state.selected.size === 0 && optionIndex !== null) state.selected.add(optionIndex);
		this.commitCurrentAnswer();
	}

	private commitCurrentAnswer(): void {
		const question = this.currentQuestion();
		const state = this.currentState();
		if (!question || !state) return;
		if (questionHasOptions(question) && question.multi_select === true) {
			const answer = answerText(question, state.selected, state.customAnswer);
			if (answer.length === 0) {
				this.status = "Select at least one answer or choose Other.";
				this.deps.requestRender();
				return;
			}
			state.answer = answer;
		}
		this.status = "";
		this.finishIfCompleteOrAdvance();
	}

	private finishIfCompleteOrAdvance(): void {
		this.syncActiveControl();
		if (this.allAnswered()) {
			this.finish({ answers: this.answers() });
			return;
		}
		const next = this.nextUnansweredIndex();
		if (next !== null) {
			this.index = next;
			this.resetQuestionScroll();
			const nextState = this.currentState();
			const nextQuestion = this.currentQuestion();
			if (nextState && nextQuestion && !nextState.answer.trim()) nextState.mode = initialMode(nextQuestion);
			this.rebuildControl();
		}
		this.deps.requestRender();
	}

	private nextUnansweredIndex(): number | null {
		for (let offset = 1; offset <= this.states.length; offset += 1) {
			const candidate = (this.index + offset) % this.states.length;
			if (!this.states[candidate]?.answer.trim()) return candidate;
		}
		return null;
	}

	private allAnswered(): boolean {
		return this.states.length > 0 && this.states.every((state) => state.answer.trim().length > 0);
	}

	/**
	 * What the round captured, as three separable facts per question: the one-line
	 * answer, the labels chosen, and the text typed. A reader tells a label-only
	 * answer from a label-plus-value one by whether `value` is there, which the
	 * joined string alone could never say.
	 */
	private answers(): AskUserResult["answers"] {
		const answers: AskUserResult["answers"] = [];
		for (let index = 0; index < this.questions.length; index += 1) {
			const question = this.questions[index];
			const state = this.states[index];
			const answer = state?.answer.trim();
			if (!question || !state || !answer || answer.length === 0) continue;
			const options = selectedOptionLabels(question, state.selected);
			answers.push({
				question: question.question,
				answer,
				...(options.length > 0 ? { options } : {}),
				...(state.rawValue.length > 0 ? { value: state.rawValue } : {}),
			});
		}
		return answers;
	}

	private goToRelativeQuestion(delta: -1 | 1): void {
		if (this.questions.length <= 1) return;
		this.syncActiveControl();
		this.parkTextMode();
		this.index = (this.index + delta + this.questions.length) % this.questions.length;
		this.status = "";
		this.resetQuestionScroll();
		this.rebuildControl();
		this.deps.requestRender();
	}

	private syncActiveControl(): void {
		const state = this.currentState();
		if (!state) return;
		if (this.list) {
			const current = this.list.getSelectedItem();
			if (current) state.focusedValue = current.value;
		}
		if (this.text) state.inputValue = this.text.getText();
	}
}

/**
 * The view without a frame, for layout tests: it renders the body rows the
 * frame would wrap, at the width and row count the test names.
 */
export interface AskUserViewForTesting {
	ask(questions: ReadonlyArray<AskUserQuestion>, presentation?: DecisionPresentation): Promise<AskUserResult>;
	render(width: number): string[];
	handleInput(data: string): void;
	footerHint(): string;
	cancel(): void;
}

export function createAskUserViewForTesting(deps: {
	rows: number;
	tui?: TUI;
	onCancel?: () => void;
}): AskUserViewForTesting {
	const view = new AskUserOverlayView({
		onCancel: deps.onCancel ?? (() => {}),
		getTerminalRows: () => deps.rows,
		requestRender: () => {},
		...(deps.tui ? { tui: deps.tui } : {}),
	});
	return {
		ask: (questions, presentation) => view.begin(questions, presentation),
		render: (width) => view.render(width),
		handleInput: (data) => view.handleInput(data),
		footerHint: () => view.footerHint(),
		cancel: () => view.cancel(),
	};
}

/**
 * Show the ask_user overlay.
 *
 * One frame for the whole interview: it sits above the composer, takes its
 * width from the terminal, and its height from what the round has to say. A
 * shape change between rounds is just the next render; nothing is remounted.
 */
export function openAskUserOverlay(tui: TUI, deps: OpenAskUserOverlayDeps): AskUserOverlaySession {
	let closed = false;

	const view = new AskUserOverlayView({
		...deps,
		getTerminalRows: () => tui.terminal?.rows ?? 0,
		requestRender: () => tui.requestRender(),
		tui,
	});

	const handle = showClioOverlayFrame(tui, view, {
		anchor: "bottom-center",
		width: askUserBoxWidth(tui.terminal?.columns ?? 0),
		margin: ASK_USER_MARGIN,
		// Not derived from the title: this modal swaps between a waiting title
		// and a classified decision title without ever changing hands.
		markerId: "ask-user",
		title: () => (view.isDecisionPending() ? view.decisionTitle() : ASK_USER_WAITING_TITLE),
		tone: () => (view.isDecisionPending() ? view.decisionTone() : undefined),
		footerHint: () => view.footerHint(),
	});

	const close = (): void => {
		if (closed) return;
		closed = true;
		view.close();
		handle.hide();
	};
	return {
		setHidden: (hidden) => handle.setHidden(hidden),
		isHidden: () => (closed ? true : handle.isHidden()),
		focus: () => handle.focus(),
		unfocus: (options) => (options ? handle.unfocus(options) : handle.unfocus()),
		isFocused: () => (closed ? false : handle.isFocused()),
		getBounds: () => (closed ? undefined : handle.getBounds()),
		ask: (questions, presentation) => view.begin(questions, presentation),
		cancel: () => view.cancel(),
		close,
		hide: close,
		isWaiting: () => view.isWaiting(),
	};
}
