import {
	classifyDecisionPresentation,
	type DecisionPresentation,
	decisionFactsForAnswer,
} from "../../domains/safety/decision-presentation.js";
import {
	type Component,
	Editor,
	getKeybindings,
	Input,
	matchesKey,
	type OverlayHandle,
	renderFakeCursor,
	type SelectItem,
	SelectList,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../../engine/tui.js";
import type { AskUserAnswer, AskUserQuestion, AskUserResult } from "../../tools/ask-user.js";
import { cancelledAskUserResult, recommendedOptionIndex, unavailableAskUserResult } from "../../tools/ask-user.js";
import type { ToolInvokeOptions } from "../../tools/registry.js";
import { dockGrowthRows } from "../dock.js";
import { formatKeyLabel } from "../keybinding-manager.js";
import { scrollTranscriptPage } from "../layout.js";
import {
	buildHint,
	DEFAULT_SELECT_THEME,
	fitHintEntries,
	fitHintEntryList,
	fitRow,
	type HintEntry,
	type OverlayEscVerb,
	showClioOverlayFrame,
} from "../overlay-frame.js";
import {
	type ClioToken,
	clioTheme,
	dotSep,
	editorTheme,
	emptyState,
	GLYPH,
	screenTitle,
	sectionLabel,
	sectionRule,
	selectionRow,
	statusChip,
	titleRow,
} from "../theme/index.js";
import {
	formatUnattendedRemaining,
	startUnattendedCountdown,
	type UnattendedCountdown,
	type UnattendedTimers,
} from "../unattended-countdown.js";
import { nextContentScrollOffset, type ViewScrollAction } from "../view/view-overlay.js";

/**
 * The default title and border token for a local conversational answer.
 * Outward and other consequence tiers replace both values with their typed
 * presentation. All ask_user surfaces carry the same classified signal.
 */
const DEFAULT_ASK_USER_PRESENTATION = classifyDecisionPresentation(decisionFactsForAnswer("local"));

/** An interview owns the viewport for every round, including one-question rounds. */
const ASK_USER_FRAME_AND_MARGIN_ROWS = 4;
const MIN_INNER_ROWS = 6;
/** The question region keeps at least this many rows before the options window shrinks. */
const MIN_QUESTION_ROWS = 3;
/** At or under this many body rows an option's explanation may give way so every choice stays listed. */
const COMPACT_BODY_ROWS = 12;
const MAX_LABEL_COLUMN = 30;
const MIN_LABEL_COLUMN = 12;
const CONTINUATION_INDENT = "    ";
const TEXT_ASKING_DESCRIPTION = "opens a text field for your answer";
const OTHER_CAPTION = "Other · recorded exactly as typed";
const CURSOR_CELL = renderFakeCursor(" ");

type OptionDetail = "all" | "focused" | "none";

/**
 * One way to spend the body's rows. The question and its choices are what the
 * operator acts on, so the rows around them go first: blank spacing, then the
 * header rows, and on a short terminal explanations before the key legend.
 */
interface BodyFit {
	spacing: boolean;
	headers: boolean;
	legend: boolean;
	detail: OptionDetail;
}

const FULL_FIT: BodyFit = { spacing: true, headers: true, legend: true, detail: "all" };
const TIGHT_FIT: BodyFit = { ...FULL_FIT, spacing: false };
const HEADERLESS_FIT: BodyFit = { ...TIGHT_FIT, headers: false };
const BODY_FITS: ReadonlyArray<BodyFit> = [FULL_FIT, TIGHT_FIT, HEADERLESS_FIT, { ...HEADERLESS_FIT, legend: false }];
const COMPACT_BODY_FITS: ReadonlyArray<BodyFit> = [
	FULL_FIT,
	TIGHT_FIT,
	HEADERLESS_FIT,
	{ ...HEADERLESS_FIT, detail: "focused" },
	{ ...HEADERLESS_FIT, detail: "none" },
	{ ...HEADERLESS_FIT, legend: false, detail: "focused" },
	{ ...HEADERLESS_FIT, legend: false, detail: "none" },
];

export interface OpenAskUserOverlayDeps {
	onCancel: () => void;
}

/** How a round is put in front of the operator beyond its questions. */
export interface AskUserRoundOptions {
	/**
	 * Ignore every key but Esc for this long after the round appears. A round the
	 * harness opens unprompted can land while the operator is typing in the
	 * composer, and a stray Enter must not answer it.
	 */
	inputGuardMs?: number;
	harnessInterview?: ToolInvokeOptions["harnessInterview"];
	/**
	 * Close the round as `timedOut` after this window unless a key arrives
	 * first (#421). Only a model's ask_user round carries it.
	 */
	unattended?: { windowMs: number; timers?: UnattendedTimers };
}

export interface AskUserOverlaySession extends OverlayHandle {
	ask(
		questions: ReadonlyArray<AskUserQuestion>,
		presentation?: DecisionPresentation,
		round?: AskUserRoundOptions,
	): Promise<AskUserResult>;
	cancel(): void;
	close(): void;
	isWaiting(): boolean;
}

type Mode = "select" | "text";
type InterviewPhase = "waiting" | "asking" | "closed";

interface QuestionState {
	mode: Mode;
	selected: Set<number>;
	committedSelected: Set<number>;
	/** The choices as they stood when the text field opened; Esc from the field puts them back. */
	selectedBeforeText: Set<number> | null;
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

function createQuestionState(
	question: AskUserQuestion,
	initial?: { selected?: readonly number[]; text?: string },
): QuestionState {
	const preferred = question.defaultOption;
	const focusable = preferred !== undefined && question.options?.[preferred] !== undefined;
	return {
		mode: initialMode(question),
		selected: new Set(initial?.selected),
		committedSelected: new Set(initial?.selected),
		selectedBeforeText: null,
		customAnswer: "",
		inputValue: initial?.text ?? "",
		answer: "",
		rawValue: "",
		// defaultOption sets focus; harness drafts still need the operator's submission.
		...(focusable ? { focusedValue: `option:${preferred}` } : {}),
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
	return text.replace(BOLD_SPAN, (_match, inner: string) => theme.fg("boldEmphasis", inner));
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
		return fitRow(theme.fg("annotation", this.caption), width);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.getText().length > 0) return lines;
		// The dock trims trailing blank rows and an empty field's row reads as blank,
		// which took the cursor with it, so the field keeps a visible placeholder.
		const row = lines[1];
		const at = row?.indexOf(CURSOR_CELL) ?? -1;
		if (row === undefined || at < 0) return lines;
		const start = row.slice(0, at + CURSOR_CELL.length);
		lines[1] = `${start}${clioTheme().fg("inputPlaceholder", truncateToWidth("type here", Math.max(0, width - 1), "", false))}`;
		return lines;
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		if (hiddenLineCount <= 0) return "";
		return fitRow(clioTheme().fg("annotation", `${GLYPH.down} ${hiddenLineCount} more rows`), width);
	}
}

/** One shape over the two text controls, so the view never asks which it holds. */
interface TextControl {
	render(width: number): string[];
	handleInput(data: string): void;
	applyEdit?(operation: "undo"): void;
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
				fitRow(
					theme.base(
						"inputText",
						line.startsWith("> ") ? `${theme.fg("selectedOption", `${GLYPH.cursor} `)}${line.slice(2)}` : line,
					),
					width,
				),
			);
		return [fitRow(theme.fg("annotation", this.caption), width), ...rows];
	}

	applyEdit(operation: "undo"): void {
		this.input.applyEdit(operation);
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

interface OptionRowLayout {
	/** Rows per item, in item order. */
	rows: string[][];
}

/** Full-width labels and explanations; selection never hides another option's explanation. */
function layoutOptionRows(
	items: ReadonlyArray<SelectItem>,
	focusedIndex: number,
	width: number,
	recommendedIndex = -1,
	detail: OptionDetail = "all",
): OptionRowLayout {
	const theme = clioTheme();
	const safeWidth = Math.max(8, width);
	return {
		rows: items.map((item, index) => {
			const focused = index === focusedIndex;
			const tag = index === recommendedIndex ? ` ${theme.fg("annotation", "recommended")}` : "";
			const label = `${theme.fg("menuOption", item.label, focused ? "selected" : "normal")}${tag}`;
			const prefix = focused ? theme.fg("selectedOption", `${GLYPH.cursor} `) : "  ";
			const labels = wrapTextWithAnsi(label, safeWidth - 2).map((line, at) => `${at === 0 ? prefix : "  "}${line}`);
			const description = detail === "all" || (detail === "focused" && focused) ? item.description?.trim() : undefined;
			const explanation = description
				? formatAskUserQuestion(description, Math.max(4, safeWidth - CONTINUATION_INDENT.length)).map(
						(line) => `${CONTINUATION_INDENT}${theme.base("decisionConsequence", line)}`,
					)
				: [];
			return [...labels, ...explanation];
		}),
	};
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
	return [...visible, fitRow(theme.fg("annotation", marker), width)];
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
	private optionDetailRows: string[] = [];
	/** Rows of the question region already scrolled past. */
	private questionScroll = 0;
	private questionOverflows = false;
	private questionRegionRows = 1;
	private questionTotalRows = 0;
	/** Cells the rail under this body has for keys; zero until the composer says. */
	private railRoom = 0;
	/** Whether the last option layout had to window its list. */
	private controlWindowed = false;
	private ledgerExpanded = false;
	private detailsExpanded = false;
	private presentation: DecisionPresentation = DEFAULT_ASK_USER_PRESENTATION;
	/** performance.now() before which input other than Esc is dropped. */
	private inputGuardUntil = 0;
	private harnessInterview: ToolInvokeOptions["harnessInterview"];
	/** The round's unattended countdown, while one runs or until the operator holds it. */
	private countdown: UnattendedCountdown | null = null;

	constructor(private readonly deps: AskUserOverlayViewDeps) {}

	begin(
		questions: ReadonlyArray<AskUserQuestion>,
		presentation: DecisionPresentation = DEFAULT_ASK_USER_PRESENTATION,
		round?: AskUserRoundOptions,
	): Promise<AskUserResult> {
		if (this.phase === "closed") return Promise.resolve(cancelledAskUserResult());
		// A round is already on screen; the caller is not the one being answered.
		if (this.resolveCurrent) return Promise.resolve(unavailableAskUserResult());
		this.phase = "asking";
		this.inputGuardUntil = round?.inputGuardMs !== undefined ? performance.now() + round.inputGuardMs : 0;
		this.index = 0;
		this.status = "";
		this.questions = [...questions];
		this.presentation = presentation;
		this.harnessInterview = round?.harnessInterview;
		this.states = this.questions.map((question, index) =>
			createQuestionState(question, this.harnessInterview?.initial?.[index]),
		);
		this.list = null;
		this.text = null;
		this.detailsExpanded = false;
		this.resetQuestionScroll();
		this.rebuildControl();
		this.startCountdown(round?.unattended);
		this.deps.requestRender();
		return new Promise<AskUserResult>((resolve) => {
			this.resolveCurrent = resolve;
		});
	}

	private startCountdown(unattended: AskUserRoundOptions["unattended"]): void {
		this.countdown?.cancel();
		this.countdown = null;
		if (unattended === undefined || !(unattended.windowMs > 0)) return;
		const afterSeconds = Math.round(unattended.windowMs / 1000);
		this.countdown = startUnattendedCountdown({
			windowMs: unattended.windowMs,
			...(unattended.timers !== undefined ? { timers: unattended.timers } : {}),
			// Whatever the operator committed stays theirs; the tool chooses for the rest.
			onExpire: () => {
				this.syncActiveControl();
				this.finish({ answers: this.answers(), timedOut: { afterSeconds } });
			},
			onTick: () => this.deps.requestRender(),
		});
	}

	/** What the timer does if it runs out, in the words the option list uses. */
	setRailRoom(cells: number): void {
		this.railRoom = Math.max(0, Math.floor(cells));
	}

	private unattendedOutcome(): string {
		if (this.presentation.tier === "outward") return "declines this outward step";
		const withOptions = this.questions.filter(questionHasOptions).length;
		if (withOptions === 0) return "leaves this to Clio's judgment";
		if (withOptions === this.questions.length) {
			return withOptions > 1 ? "picks the recommended option for each question" : "picks the recommended option";
		}
		return "picks each recommended option, or leaves it to Clio's judgment";
	}

	/** The same outcome for one narrow row: the choice itself when there is only one. */
	private unattendedOutcomeShort(): string {
		if (this.presentation.tier === "outward") return "declines";
		const only = this.questions.length === 1 ? this.questions[0] : undefined;
		if (only === undefined) return "recommended";
		return only.options?.[recommendedOptionIndex(only)]?.label ?? "Clio decides";
	}

	/** The option this question's timeout would take, while a timer is part of the round. */
	private recommendedIndex(question: AskUserQuestion): number {
		if (this.countdown === null || this.presentation.tier === "outward") return -1;
		const index = recommendedOptionIndex(question);
		const label = question.options?.[index]?.label ?? "";
		// A label that already says it needs no second word.
		return /\brecommended\b/iu.test(label) ? -1 : index;
	}

	/**
	 * The timer row: time left and the automatic outcome while it runs, then a
	 * held line that stays for the rest of the round, so the operator can tell a
	 * paused timer from one that was never there. Nothing about it implies work.
	 */
	private renderCountdown(width: number, headers: boolean): string[] {
		const countdown = this.countdown;
		if (countdown === null) return [];
		const theme = clioTheme();
		if (countdown.state() === "held") {
			const question = this.currentQuestion();
			const goesBack = this.currentState()?.mode === "text" && question && questionHasOptions(question);
			const line = headers
				? `${GLYPH.phaseBlocked} timer held · Enter records, ${goesBack ? "Esc goes back" : "Esc closes"}`
				: `${GLYPH.phaseBlocked} held · Enter records · ${goesBack ? "Esc back" : "Esc closes"}`;
			return headers
				? wrapTextWithAnsi(theme.fg("annotation", line), width)
				: [fitRow(theme.fg("annotation", line), width)];
		}
		const left = countdown.remainingMs();
		if (left === null) return [];
		const remaining = formatUnattendedRemaining(left);
		if (!headers) {
			const short = `${GLYPH.warn} ${remaining} then ${this.unattendedOutcomeShort()} · key holds`;
			return [fitRow(theme.fg("warning", short), width)];
		}
		return wrapTextWithAnsi(
			theme.fg(
				"warning",
				`${GLYPH.warn} No answer in ${remaining} ${this.unattendedOutcome()} and Clio continues. Any key holds.`,
			),
			width,
		);
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

	interviewTitle(): string | undefined {
		return this.harnessInterview?.title;
	}

	decisionTone(): ClioToken {
		return this.presentation.semanticToken;
	}

	invalidate(): void {
		this.list?.invalidate();
		this.text?.invalidate();
	}

	get keyboardScope(): "edit" | "review" {
		return this.currentState()?.mode === "text" ? "edit" : "review";
	}
	undoInput(): boolean {
		if (this.currentState()?.mode !== "text") return false;
		this.text?.applyEdit?.("undo");
		return true;
	}
	handleInput(data: string): void {
		if (this.phase !== "asking") {
			if (matchesKey(data, "escape")) this.deps.onCancel();
			return;
		}
		// Any key says the operator is here, the guarded ones included: the
		// round waits for them from now on.
		if (this.countdown !== null) {
			this.countdown.hold();
			this.deps.requestRender();
		}
		const question = this.currentQuestion();
		const state = this.currentState();
		if (!question || !state) return;
		if (performance.now() < this.inputGuardUntil && !matchesKey(data, "escape")) return;

		// Scrolling the question must not cost the operator their place in the
		// options, so the region has keys of its own that neither control claims.
		if (this.handleScrollInput(data, state.mode)) return;
		// A question that fits its box has no use for the page keys, and the transcript behind
		// it may hold the context the operator is answering from. A text field keeps them.
		if (state.mode !== "text" && !this.questionOverflows) {
			const direction = matchesKey(data, "pageUp") ? -1 : matchesKey(data, "pageDown") ? 1 : 0;
			if (direction !== 0 && this.deps.tui && scrollTranscriptPage(this.deps.tui, direction)) return;
		}

		// Question navigation must work from both choices and the answer editor.
		// Bare arrows browse an empty answer; once typing starts they edit text.
		const canBrowseWithArrows = state.mode !== "text" || !(this.text?.getText() ?? state.inputValue);
		if (this.questions.length > 1) {
			if (matchesKey(data, "shift+tab") || (canBrowseWithArrows && matchesKey(data, "left"))) {
				this.goToRelativeQuestion(-1);
				return;
			}
			if (matchesKey(data, "tab") || (canBrowseWithArrows && matchesKey(data, "right"))) {
				this.goToRelativeQuestion(1);
				return;
			}
		}

		if (state.mode === "text") {
			if (matchesKey(data, "escape")) {
				this.escapeFromTextInput(question, state);
				return;
			}
			this.text?.handleInput(data);
			return;
		}

		if (question.multi_select === true && data === " ") {
			this.toggleCurrentSelection(question, state);
			return;
		}
		if (question.multi_select === true && (matchesKey(data, "enter") || data === "\n")) {
			this.commitMultiSelectOrOpenOther(question, state);
			return;
		}
		if (matchesKey(data, "t")) {
			this.openOtherField(question, state);
			return;
		}
		if (matchesKey(data, "n")) {
			this.openNoteField(question, state);
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
		const wide = width >= 120 && this.maxInnerRows() >= 24 && this.phase === "asking" && this.questions.length > 1;
		const menuWidth = 28;
		const bodyWidth = Math.min(104, Math.max(1, width - (wide ? menuWidth + 5 : 0)));
		const body = this.renderBody(bodyWidth, wide);
		if (!wide) return body;
		const theme = clioTheme();
		// The side list follows the one selection rule: the cursor on the active
		// question, a check on an answered one. The rail names the keys that move
		// between them, so the list does not.
		const answered = this.states.filter((state) => state.answer.trim().length > 0).length;
		const menu = [sectionLabel(theme, "Questions", `${answered}/${this.questions.length} answered`)];
		this.questions.forEach((question, index) => {
			const state = this.states[index];
			menu.push(
				...selectionRow(theme, {
					focused: index === this.index,
					label: `${index + 1}. ${compactTitle(question)}`,
					...(state?.answer.trim() ? { mark: theme.fg("success", GLYPH.ok) } : {}),
					width: menuWidth,
				}),
			);
		});
		return Array.from({ length: Math.min(this.maxInnerRows(), Math.max(menu.length, body.length)) }, (_, index) => {
			const left = menu[index] ?? "";
			return `${left}${" ".repeat(Math.max(0, menuWidth - visibleWidth(left)))}  ${theme.fg("border", "│")}  ${body[index] ?? ""}`;
		});
	}

	private renderBody(width: number, hasMenu: boolean): string[] {
		const safeWidth = Math.max(1, width);
		const maxRows = this.maxInnerRows();
		if (this.phase !== "asking") return this.renderWaiting(safeWidth, maxRows);
		const question = this.currentQuestion();
		if (!question) return emptyState(clioTheme(), "No questions.", safeWidth);
		const compact = maxRows <= COMPACT_BODY_ROWS;
		for (const fit of compact ? COMPACT_BODY_FITS : BODY_FITS) {
			const attempt = this.composeBody(question, safeWidth, hasMenu, maxRows, fit);
			if (attempt.fits) return attempt.rows;
		}
		// Nothing lists every choice, so the list windows around the focused one.
		const fallback = compact ? COMPACT_BODY_FITS[COMPACT_BODY_FITS.length - 1] : TIGHT_FIT;
		return this.composeBody(question, safeWidth, hasMenu, maxRows, fallback ?? TIGHT_FIT).rows;
	}

	private composeBody(
		question: AskUserQuestion,
		width: number,
		hasMenu: boolean,
		maxRows: number,
		fit: BodyFit,
	): { rows: string[]; fits: boolean } {
		const theme = clioTheme();
		const gap = fit.spacing ? [""] : [];
		const countdown = this.renderCountdown(width, fit.headers);
		const strip = fit.headers
			? [
					fitRow(
						theme.style(
							"positionCount",
							this.harnessInterview
								? this.harnessPosition()
								: `Question ${this.index + 1} of ${this.questions.length} · Round ${this.roundsAnswered + 1}`,
							{ bold: true },
						),
						width,
					),
					...gap,
					...countdown,
					...(hasMenu ? [] : this.renderQuestionStrip(width, fit.spacing)),
				]
			: [...this.renderCompactPosition(question, width), ...countdown];
		const header = fit.headers ? this.renderQuestionHeader(question, width, !hasMenu && this.questions.length > 1) : [];
		const details = this.renderDecisionContext(width);
		const status = this.status.length > 0 ? wrapTextWithAnsi(statusChip(theme, "warning", this.status), width) : [];
		const legend = fit.legend ? this.renderKeyLegend(width, fit.headers ? 2 : 1) : [];
		const body = [
			...(this.harnessInterview?.intro?.(width) ?? []),
			...formatAskUserQuestion(question.question, width).map((line) => theme.fg("decisionQuestion", line)),
		];
		const fixedTop = [...strip, ...header, ...details];
		const questionFloor = Math.min(body.length, MIN_QUESTION_ROWS);
		// The control is sized after the question has claimed its minimum, so a
		// long option list cannot push a short question off the box.
		const controlBudget = Math.max(
			fit.headers ? 4 : 2,
			maxRows - fixedTop.length - gap.length - legend.length - status.length - questionFloor,
		);
		this.optionDetailRows = [];
		this.controlWindowed = false;
		const control = this.renderControlLines(width, controlBudget, fit.detail);
		const movedDetails = this.optionDetailRows.length > 0;
		body.push(...this.optionDetailRows);
		const ledgerBudget = Math.max(
			1,
			maxRows -
				fixedTop.length -
				gap.length -
				control.length -
				legend.length -
				status.length -
				Math.min(body.length, MIN_QUESTION_ROWS),
		);
		const ledger = this.renderAnswerLedger(width, ledgerBudget, fit);
		const fixed = fixedTop.length + gap.length + control.length + legend.length + status.length + ledger.length;

		const regionRows = Math.max(1, Math.min(body.length, maxRows - fixed));
		const overflows = body.length > regionRows;
		this.questionOverflows = overflows;
		this.questionTotalRows = body.length;
		const viewRows = overflows ? Math.max(1, regionRows - 1) : regionRows;
		this.questionRegionRows = viewRows;
		// Clamped locally: an attempt with more rows has a lower ceiling than the
		// layout that wins, and keeping its clamp would strand the last rows.
		const scroll = Math.max(0, Math.min(this.questionScroll, Math.max(0, body.length - viewRows)));
		const visible = body.slice(scroll, scroll + viewRows);
		if (overflows)
			visible.push(fitRow(theme.fg("annotation", this.scrollIndicator(scroll, body.length, viewRows)), width));

		return {
			rows: [...fixedTop, ...visible, ...gap, ...control, ...legend, ...status, ...ledger].slice(0, maxRows),
			fits: !this.controlWindowed && !movedDetails && fixed + Math.min(body.length, MIN_QUESTION_ROWS) <= maxRows,
		};
	}

	private harnessPosition(): string {
		const interview = this.harnessInterview;
		if (!interview) return "";
		return `Step ${interview.step}${interview.total === undefined ? "" : ` of ${interview.total}`} · Question ${this.index + 1} of ${this.questions.length}`;
	}

	/** Where the round stands on one row, for a body that has given up its header rows. */
	private renderCompactPosition(question: AskUserQuestion, width: number): string[] {
		const theme = clioTheme();
		const answered = this.states.filter((state) => state.answer.trim().length > 0).length;
		const parts = this.harnessInterview
			? [this.harnessPosition()]
			: [
					...(this.questions.length > 1 ? [`Q${this.index + 1} of ${this.questions.length}`] : []),
					...(question.header ? [question.header] : []),
					...(this.roundsAnswered > 0 ? [`Round ${this.roundsAnswered + 1}`] : []),
					...(this.questions.length > 1 && answered > 0 ? [`${answered} answered`] : []),
				];
		if (parts.length === 0) return [];
		return [fitRow(theme.style("positionCount", parts.join(" · "), { bold: true }), width)];
	}

	/** The keys the rail cannot hold, so every control stays on screen when there is a row for it. */
	private renderKeyLegend(width: number, maxRows: number): string[] {
		if (this.railRoom <= 0) return [];
		const entries = this.railEntries();
		const { kept } = fitHintEntryList(entries, this.railRoom);
		const dropped = entries.filter((entry) => !kept.includes(entry));
		if (dropped.length === 0) return [];
		const text = fitHintEntries(dropped, Math.max(1, width * maxRows - (maxRows - 1) * 8));
		return wrapTextWithAnsi(clioTheme().fg("keyboardHint", text), width).slice(0, maxRows);
	}

	private scrollIndicator(above: number, total: number, viewRows: number): string {
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

	/** The active control's keys in the order they should give way, without the way out. */
	private hintEntries(): { entries: HintEntry[]; escVerb: OverlayEscVerb } {
		const question = this.currentQuestion();
		const state = this.currentState();
		if (this.phase !== "asking" || !question || !state) return { entries: [], escVerb: "close" };
		const recordAnswer =
			this.presentation.requiredActions.find((action) => action.id === "record-answer")?.label.toLowerCase() ??
			"record answer";
		const record: HintEntry = { key: "Enter", verb: recordAnswer, short: recordAnswer.split(" ")[0] ?? recordAnswer };
		const scroll: HintEntry[] = this.questionOverflows ? [{ key: "PgUp/PgDn", verb: "scroll", critical: false }] : [];
		if (state.mode === "text") {
			// Esc means two different things depending on what is behind the field.
			// A question with options has a list to fall back to, so the key goes
			// back; a question without one has nothing behind it and the key still
			// leaves the interview. The footer says which one this is.
			const escVerb: OverlayEscVerb = questionHasOptions(question) ? "back" : "close";
			const entries: HintEntry[] = [];
			if (this.deps.tui)
				entries.push({
					key: formatKeyLabel(getKeybindings().getKeys("tui.input.newLine")[0], "Ctrl+J"),
					verb: "newline",
					critical: false,
				});
			entries.push(...scroll);
			if (this.questions.length > 1)
				entries.push({ key: "Tab/Shift+Tab", verb: "question", short: "next", critical: false });
			entries.push(record);
			return { entries, escVerb };
		}
		const entries: HintEntry[] = [{ key: "?", verb: "details" }];
		if (this.ledgerEntries().length > 0) entries.push({ key: "a", verb: "answers" });
		entries.push({ key: "n", verb: "note on option", short: "note" });
		entries.push({ key: "t", verb: "other answer", short: "other" });
		entries.push(...scroll);
		if (this.questions.length > 1) entries.push({ key: "←/→", verb: "question" });
		if (question.multi_select === true) entries.push({ key: "Space", verb: "toggle" });
		entries.push(record);
		return { entries, escVerb: "close" };
	}

	footerHint(): string {
		const { entries, escVerb } = this.hintEntries();
		return buildHint(entries, escVerb);
	}

	/** The rail's order: the last entry always survives a narrow rail, and that must be the key that records. */
	private railEntries(): HintEntry[] {
		const { entries, escVerb } = this.hintEntries();
		const record = entries.at(-1);
		if (!record) return [{ key: "Esc", verb: escVerb }];
		return [...entries.slice(0, -1), { key: "Esc", verb: escVerb }, record];
	}

	/** The rail hint for a rail of `cells`; the legend in the body draws what this drops. */
	railHint(cells: number): string {
		const entries = this.railEntries();
		const fitted = fitHintEntries(entries, cells);
		const withDrag = `${fitted} · drag to select/copy`;
		return visibleWidth(withDrag) <= cells ? withDrag : fitted;
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
			const requested = theme.fg("annotation", `requested by ${this.presentation.requestedByCopy}`);
			lines.push(fitRow(`${tier}${dotSep(theme)}${requested}`, width));
		}
		if (this.detailsExpanded) {
			lines.push(
				...wrapTextWithAnsi(
					`${theme.fg("annotation", "Effect:")} ${theme.fg("decisionExplanation", this.presentation.authorizationCopy)}`,
					width,
				),
				...wrapTextWithAnsi(theme.fg("decisionConsequence", this.presentation.reversibilityCopy), width),
				"",
			);
		}
		return lines;
	}

	private finish(result: AskUserResult): void {
		this.countdown?.cancel();
		this.countdown = null;
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
			titleRow(theme, "Interview", width, {
				meta: this.history.length > 0 ? "answer sent · waiting for the next question" : "waiting for the first question",
			}),
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

	/**
	 * `t`: the answer is what the operator types and nothing else. A single choice
	 * drops whatever was chosen, focus never selects, and only boxes the operator
	 * checked themselves stay with a multi-select answer.
	 */
	private openOtherField(question: AskUserQuestion, state: QuestionState): void {
		this.rememberSelection(state);
		if (question.multi_select !== true) state.selected = new Set();
		this.openTextInput();
	}

	/**
	 * `n`, or Enter on an option whose label says the operator will type: the
	 * focused option and the text are recorded together, and the field shows the
	 * composed answer before Enter. Choosing an option used to be the whole answer,
	 * so a model that offered "Exact number - I'll type it" gave the operator a
	 * label and nowhere to put the number (issue #228).
	 */
	private openNoteField(question: AskUserQuestion, state: QuestionState): void {
		const current = this.list?.getSelectedItem();
		const optionIndex = current && current.value !== "other" ? optionIndexFromValue(current.value) : null;
		if (optionIndex === null) {
			this.openOtherField(question, state);
			return;
		}
		this.rememberSelection(state);
		if (question.multi_select === true) state.selected.add(optionIndex);
		else state.selected = new Set<number>([optionIndex]);
		state.focusedValue = `option:${optionIndex}`;
		this.openTextInput();
	}

	private rememberSelection(state: QuestionState): void {
		state.selectedBeforeText = new Set(state.selected);
	}

	/** What the field is for, read from the choices that will be recorded with it. */
	private textCaption(question: AskUserQuestion, state: QuestionState): string {
		if (!questionHasOptions(question)) return "Your answer";
		const labels = selectedOptionLabels(question, state.selected);
		return labels.length > 0 ? `Your answer, with ${labels.map((label) => `"${label}"`).join(", ")}` : OTHER_CAPTION;
	}

	/** The composed answer under the field, because Enter records more than the field holds. */
	private textPreview(question: AskUserQuestion, state: QuestionState, width: number): string[] {
		if (!questionHasOptions(question) || state.selected.size === 0) return [];
		const typed = this.text?.getText().trim() ?? "";
		const answer = answerText(question, state.selected, typed).replace(/\s*\n\s*/g, " ");
		const theme = clioTheme();
		return wrapLabeledValue(
			`${theme.fg("annotation", "Records:")} `,
			theme.fg("decisionExplanation", answer),
			width,
		).slice(0, 2);
	}

	/**
	 * The row above the question: its header, and the round for a phased
	 * interview. `Question 1/1` was a counter over a set of one, printed on every
	 * confirmation; a round of several questions names them in the strip instead.
	 */
	private renderQuestionHeader(question: AskUserQuestion, width: number, stripNamesIt = false): string[] {
		const theme = clioTheme();
		const parts: string[] = [theme.fg("pendingAnswer", "Clio-Coder asks you")];
		// The strip above already carries the active question's name with the
		// cursor on it; the header repeats it only when there is no strip.
		if (question.header && !stripNamesIt) parts.push(screenTitle(theme, question.header));
		if (this.questions.length <= 1 && this.roundsAnswered > 0) {
			parts.push(theme.fg("annotation", `Round ${this.roundsAnswered + 1}`));
		}
		if (this.currentState()?.answer.trim()) parts.push(theme.fg("menuDescription", "answered"));
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
	private renderQuestionStrip(width: number, spacing = true): string[] {
		const theme = clioTheme();
		if (this.questions.length <= 1) return [];
		const parts = this.questions.map((question, index) => {
			const state = this.states[index];
			const active = index === this.index;
			const answered = Boolean(state?.answer.trim());
			const mark = answered ? `${theme.fg("success", GLYPH.ok)} ` : "";
			const name = `Q${index + 1} ${compactTitle(question)}`;
			const title = active
				? `${theme.fg("selectedOption", GLYPH.cursor)} ${theme.style("selectedOption", name, { bold: true })}`
				: theme.fg(answered ? "menuDescription" : "annotation", name);
			return `${mark}${title}`;
		});
		const round = this.roundsAnswered > 0 ? [theme.fg("annotation", `Round ${this.roundsAnswered + 1}`)] : [];
		const strip = wrapTextWithAnsi([...round, ...parts].join(dotSep(theme)), width).slice(0, 2);
		return spacing ? [...strip, ""] : strip;
	}

	private renderControlLines(width: number, rowBudget: number, detail: OptionDetail = "all"): string[] {
		this.ensureControl();
		const state = this.currentState();
		const question = this.currentQuestion();
		if (state?.mode === "text" && question) {
			return [...(this.text?.render(width) ?? [""]), ...this.textPreview(question, state, width)];
		}
		return this.renderSelectControl(width, rowBudget, detail);
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
	private renderAnswerLedger(width: number, rowBudget: number, fit: BodyFit = FULL_FIT): string[] {
		const theme = clioTheme();
		const entries = this.ledgerEntries();
		if (entries.length === 0) return [];
		const count = `${entries.length} earlier answer${entries.length === 1 ? "" : "s"}`;
		// The rail names the key that opens the ledger; the row carries the count.
		if (!this.ledgerExpanded) {
			// A body without headers counts answers on its position row.
			if (!fit.headers) return [];
			return [...(fit.spacing ? [""] : []), fitRow(theme.fg("annotation", count), width)];
		}
		const rows: string[] = [];
		for (const entry of entries) {
			rows.push(
				...wrapLabeledValue(
					`${theme.fg("annotation", entry.label)} `,
					theme.fg("decisionExplanation", entry.answer),
					width,
				),
			);
		}
		const head = ["", sectionRule(theme, width, "Answers", { meta: count })];
		const budget = Math.max(1, rowBudget - head.length);
		if (rows.length <= budget) return [...head, ...rows];
		const kept = rows.slice(0, Math.max(0, budget - 1));
		return [
			...head,
			...kept,
			fitRow(theme.fg("annotation", `${GLYPH.ellipsis} ${rows.length - kept.length} more on /decisions`), width),
		];
	}

	private renderSelectControl(width: number, rowBudget: number, detail: OptionDetail): string[] {
		const question = this.currentQuestion();
		const state = this.currentState();
		const selectedItem = this.list?.getSelectedItem();
		if (!question || !state || !selectedItem) return [""];
		const items = optionItems(question, state.selected);
		const focusedIndex = Math.max(
			0,
			items.findIndex((item) => item.value === selectedItem.value),
		);
		const layout = layoutOptionRows(items, focusedIndex, width, this.recommendedIndex(question), detail);
		const totalRows = layout.rows.reduce((sum, rows) => sum + rows.length, 0);
		this.controlWindowed = totalRows > rowBudget;
		if (totalRows + items.length <= rowBudget) {
			for (const rows of layout.rows) rows.push("");
		}
		if ((layout.rows[focusedIndex]?.length ?? 0) >= rowBudget) {
			this.optionDetailRows = [
				"",
				...wrapTextWithAnsi(`Option details: ${selectedItem.label}`, width),
				...wrapTextWithAnsi(selectedItem.description ?? "", width),
			];
			layout.rows[focusedIndex] = wrapTextWithAnsi(
				`${GLYPH.cursor} ${selectedItem.label} (details above; PgUp/PgDn)`,
				width,
			);
		}
		return windowOptionRows(layout, focusedIndex, rowBudget, width);
	}

	private ensureControl(): void {
		const question = this.currentQuestion();
		const state = this.currentState();
		if (!question || !state) return;
		if (state.mode === "text" && !this.text) this.rebuildTextInput(question, state);
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
		if (state.mode === "text") this.rebuildTextInput(question, state);
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

	private rebuildTextInput(question: AskUserQuestion, state: QuestionState): void {
		// A question with options keeps its typed text only: prefilling the recorded
		// answer would type a chosen label into the field as if the operator had.
		const initial = state.inputValue || state.customAnswer || (questionHasOptions(question) ? "" : state.answer);
		const caption = this.textCaption(question, state);
		if (this.deps.tui) {
			const editor = new AnswerEditor(this.deps.tui);
			editor.caption = caption;
			editor.setText(initial);
			editor.onSubmit = (value) => this.submitText(question, state, value);
			this.text = editor;
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
				this.openOtherField(question, state);
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
				this.openNoteField(question, state);
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
		state.selected = new Set(state.selectedBeforeText ?? state.committedSelected);
		state.selectedBeforeText = null;
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

	private openTextInput(): void {
		const state = this.currentState();
		const question = this.currentQuestion();
		if (!state || !question) return;
		this.syncActiveControl();
		state.mode = "text";
		this.status = "";
		this.rebuildTextInput(question, state);
		this.deps.requestRender();
	}

	private toggleCurrentSelection(question: AskUserQuestion, state: QuestionState): void {
		const current = this.list?.getSelectedItem();
		if (!current) return;
		if (current.value === "other") {
			this.openOtherField(question, state);
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

	private commitMultiSelectOrOpenOther(question: AskUserQuestion, state: QuestionState): void {
		const current = this.list?.getSelectedItem();
		if (current?.value === "other") {
			this.openOtherField(question, state);
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
		const current = this.currentState();
		if (current) {
			current.committedSelected = new Set(current.selected);
			current.selectedBeforeText = null;
		}
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
			const options = selectedOptionLabels(question, state.committedSelected);
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
	ask(
		questions: ReadonlyArray<AskUserQuestion>,
		presentation?: DecisionPresentation,
		round?: AskUserRoundOptions,
	): Promise<AskUserResult>;
	render(width: number): string[];
	handleInput(data: string): void;
	footerHint(innerWidth?: number): string;
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
		ask: (questions, presentation, round) => view.begin(questions, presentation, round),
		render: (width) => view.render(width),
		handleInput: (data) => view.handleInput(data),
		footerHint: () => view.footerHint(),
		cancel: () => view.cancel(),
	};
}

/** Keep one docked interview mounted across questions and background work. */
export function openAskUserOverlay(tui: TUI, deps: OpenAskUserOverlayDeps): AskUserOverlaySession {
	let closed = false;

	const view = new AskUserOverlayView({
		...deps,
		// The dock's growth ceiling, spelled as the terminal height the body subtracts its frame rows from.
		getTerminalRows: () => dockGrowthRows(tui) + ASK_USER_FRAME_AND_MARGIN_ROWS,
		requestRender: () => tui.requestRender(),
		tui,
	});

	const handle = showClioOverlayFrame(tui, view, {
		anchor: "top-left",
		width: "100%",
		margin: 0,
		// Not derived from the title: this modal swaps between a waiting title
		// and a classified decision title without ever changing hands.
		markerId: "ask-user",
		// Option-heavy interviews grow toward half the terminal; a short question stays compact.
		adaptiveHeight: true,
		// The interview names waiting, sent and between-rounds in its own body.
		ownsStatus: true,
		title: () =>
			view.interviewTitle() ??
			(view.isDecisionPending() ? `Clio-Coder interview · ${view.decisionTitle()}` : "Clio-Coder interview"),
		tone: () => (view.isDecisionPending() ? view.decisionTone() : undefined),
		awaitingInput: () => view.isDecisionPending(),
		footerHint: (innerWidth) => view.railHint(Math.max(1, innerWidth - 3)),
	});
	const selectionTui = tui as TUI & { useTerminalSelection?: () => () => void };
	let releaseSelection = selectionTui.useTerminalSelection?.();

	const close = (): void => {
		if (closed) return;
		closed = true;
		view.close();
		releaseSelection?.();
		releaseSelection = undefined;
		handle.hide();
	};
	return {
		setHidden: (hidden) => {
			if (closed) return;
			if (hidden) {
				releaseSelection?.();
				releaseSelection = undefined;
			} else releaseSelection ??= selectionTui.useTerminalSelection?.();
			handle.setHidden(hidden);
		},
		isHidden: () => (closed ? true : handle.isHidden()),
		focus: () => handle.focus(),
		unfocus: (options) => (options ? handle.unfocus(options) : handle.unfocus()),
		isFocused: () => (closed ? false : handle.isFocused()),
		getBounds: () => (closed ? undefined : handle.getBounds()),
		ask: (questions, presentation, round) => view.begin(questions, presentation, round),
		cancel: () => view.cancel(),
		close,
		hide: close,
		isWaiting: () => view.isWaiting(),
	};
}
