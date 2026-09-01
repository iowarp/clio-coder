import {
	classifyDecisionPresentation,
	type DecisionPresentation,
	decisionFactsForAnswer,
} from "../../domains/safety/decision-presentation.js";
import {
	type Component,
	Input,
	matchesKey,
	type OverlayHandle,
	type OverlayOptions,
	type SelectItem,
	SelectList,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../../engine/tui.js";
import type { AskUserAnswer, AskUserQuestion, AskUserResult } from "../../tools/ask-user.js";
import { ASK_USER_OTHER_LABEL, cancelledAskUserResult } from "../../tools/ask-user.js";
import {
	buildHint,
	DEFAULT_SELECT_THEME,
	type HintEntry,
	type OverlayEscVerb,
	showClioOverlayFrame,
} from "../overlay-frame.js";
import { type ClioToken, clioTheme, dotSep, GLYPH, screenTitle } from "../theme/index.js";
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
 * The shape a request draws itself in.
 *
 * One overlay served three interactions through one centered full-height modal,
 * so a two-option confirmation arrived as a thirty-five-row box with twenty-five
 * blank rows under the options. The surfaces differ in size and placement:
 *
 * - `compact` is a small bar low on the screen, where the operator's eyes
 *   already are, for one question with a handful of choices.
 * - `panel` is a medium centered box for one question whose option list is too
 *   long to read in a bar.
 * - `interview` is the full surface with the round strip and the answer ledger,
 *   for a round of several questions or any round after the first.
 */
export type AskUserSurface = "compact" | "panel" | "interview";

/** Options a single question may carry and still be answered in the bar. */
export const ASK_USER_COMPACT_MAX_OPTIONS = 3;

/** The surface an overlay waits on before its first round decides one. */
export const ASK_USER_DEFAULT_SURFACE: AskUserSurface = "panel";

interface AskUserSurfaceGeometry {
	/** Box width in columns; zero fills the row. The frame clamps to the terminal. */
	width: number;
	/** Rows the body may use, before the borders. Zero means every row the frame has. */
	maxInnerRows: number;
	anchor: NonNullable<OverlayOptions["anchor"]>;
	margin: NonNullable<OverlayOptions["margin"]>;
}

/**
 * Where each surface sits and how big it is allowed to get.
 *
 * The compact bar anchors to the bottom because a decision that has taken the
 * keyboard should appear where the operator was already typing, not in the
 * middle of the transcript. It covers the composer, which is honest: the
 * composer accepts nothing while a decision is pending.
 *
 * Every surface's margin is one row top and bottom, which is what
 * `ASK_USER_FRAME_AND_MARGIN_ROWS` counts alongside the two border rows.
 */
export const ASK_USER_SURFACE_GEOMETRY: Record<AskUserSurface, AskUserSurfaceGeometry> = {
	compact: { width: 68, maxInnerRows: 14, anchor: "bottom-center", margin: { top: 1, right: 2, bottom: 1, left: 2 } },
	panel: { width: 88, maxInnerRows: 18, anchor: "center", margin: 1 },
	// The interview is a workspace, not a modal. A cap of 42 turned a 66-row
	// terminal into a centered box with twenty blank rows around it, so the
	// interview takes every row the frame has and lays its own chrome out inside
	// them. The one-row margin keeps the border off the top row and the footer.
	interview: { width: 0, maxInnerRows: 0, anchor: "center", margin: 1 },
};

const ASK_USER_FRAME_ROWS = 2;
const ASK_USER_FRAME_AND_MARGIN_ROWS = 4;
const MIN_VISIBLE_OPTIONS = 3;
/** Interview rows spent on chrome before an option row: strip, header, blanks, status, one question row. */
const INTERVIEW_CHROME_ROWS = 7;
const MAX_VISIBLE_OPTIONS = 12;
/** Below this the second column is too narrow to wrap a sentence into. */
const MIN_DESCRIPTION_COLUMN = 28;
const ELLIPSIS = "…";

/**
 * The surface a request renders on, from the request shape alone.
 *
 * `priorRounds` is what makes an interview an interview. The tool's `mode`
 * cannot answer this: `single_question` is the mode an interview asks its
 * rounds in, and a first single question is exactly the confirmation that
 * should not take the screen. A round that follows an answered one has captured
 * answers to keep on screen, which is the full surface's whole job.
 */
export function askUserSurface(questions: ReadonlyArray<AskUserQuestion>, priorRounds = 0): AskUserSurface {
	if (priorRounds > 0 || questions.length !== 1) return "interview";
	const question = questions[0];
	if (!question) return "interview";
	return (question.options?.length ?? 0) <= ASK_USER_COMPACT_MAX_OPTIONS ? "compact" : "panel";
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

interface AskUserOverlayViewDeps extends OpenAskUserOverlayDeps {
	getTerminalRows: () => number;
	requestRender: () => void;
	/** Called when the request shape moves the body to a differently sized box. */
	onSurface: (surface: AskUserSurface) => void;
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

function isOtherOption(label: string): boolean {
	const normalized = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
	return (
		normalized === "other" ||
		normalized === "custom" ||
		normalized === "something else" ||
		normalized.startsWith("other ")
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
		items.push(item);
	}
	if (explicitOtherIndex === -1) {
		items.push({
			value: "other",
			label: question.multi_select === true ? `[ ] ${ASK_USER_OTHER_LABEL}` : ASK_USER_OTHER_LABEL,
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
	return wrapTextWithAnsi(value, valueWidth).map((line, index) =>
		fitLine(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`, safeWidth),
	);
}

function compactTitle(question: AskUserQuestion): string {
	return (question.header ?? question.question).replace(/\s+/g, " ").trim();
}

class AskUserOverlayView implements Component {
	private phase: InterviewPhase = "waiting";
	private surface: AskUserSurface = ASK_USER_DEFAULT_SURFACE;
	private index = 0;
	private status = "";
	private questions: ReadonlyArray<AskUserQuestion> = [];
	private states: QuestionState[] = [];
	private history: AskUserAnswer[] = [];
	private list: SelectList | null = null;
	private input: Input | null = null;
	private resolveCurrent: ((result: AskUserResult) => void) | null = null;
	/** Rows of the interview's scrollable middle already scrolled past. */
	private contentScrollOffset = 0;
	/** Whether the last interview render had more content than the region held. */
	private contentOverflows = false;
	/** Rows the scroll region drew on the last render, for a page-sized jump. */
	private contentRegionHeight = 1;
	/** Rows the scroll region wanted on the last render. */
	private contentTotalRows = 0;
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
		this.input = null;
		this.resetContentScroll();
		// Before the controls, because how many option rows fit is a property of
		// the box this round is about to be drawn in.
		this.setSurface(askUserSurface(this.questions, this.history.length));
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

	currentSurface(): AskUserSurface {
		return this.surface;
	}

	decisionTitle(): string {
		return this.presentation.title;
	}

	decisionTone(): ClioToken {
		return this.presentation.semanticToken;
	}

	invalidate(): void {
		this.list?.invalidate();
		this.input?.invalidate();
	}

	handleInput(data: string): void {
		if (this.phase !== "asking") return;
		const question = this.currentQuestion();
		const state = this.currentState();
		if (!question || !state) return;

		// Scrolling the transcript must not cost the operator their place in the
		// options, so the region has keys of its own that neither control claims.
		if (this.handleScrollInput(data, state.mode)) return;

		if (state.mode === "text") {
			if (this.isTextModePreviousKey(data)) {
				this.goToRelativeQuestion(-1);
				return;
			}
			if (this.isTextModeNextKey(data)) {
				this.goToRelativeQuestion(1);
				return;
			}
			this.input?.handleInput(data);
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
		this.list?.handleInput(data);
	}

	/**
	 * The body, sized to what it has to say.
	 *
	 * Nothing pads to a target height any more. A two-option confirmation is six
	 * rows and draws six rows; the round strip and the answer ledger are what
	 * make an interview tall, not filler. The trailing slice is the guarantee the
	 * compact bar rests on: whatever the question and its options come to, the
	 * body never returns more rows than its surface owns.
	 */
	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const maxRows = this.maxInnerRows();
		if (this.phase !== "asking") return this.renderWaiting(safeWidth, maxRows);
		const question = this.currentQuestion();
		if (!question) return [clioTheme().fg("muted", "No questions.")];

		if (this.surface === "interview") return this.renderInterview(question, safeWidth, maxRows);

		this.contentOverflows = false;
		const controlLines = this.renderControlLines(safeWidth);
		const statusLines =
			this.status.length > 0 ? ["", ...wrapTextWithAnsi(clioTheme().fg("dim", this.status), safeWidth)] : [];
		const headerLine = this.renderQuestionHeader(question, safeWidth);
		const headerLines = headerLine.length > 0 ? [headerLine] : [];
		const bottom = [...statusLines, "", ...controlLines];
		const topBudget = Math.max(1, maxRows - bottom.length);
		const contextLines = this.renderDecisionContext(safeWidth);
		const top = [
			contextLines[0] ?? "",
			...headerLines,
			...wrapTextWithAnsi(question.question, safeWidth),
			...contextLines.slice(1),
		].slice(0, topBudget);

		return [...top, ...bottom].slice(0, maxRows);
	}

	/**
	 * The interview, as a workspace with fixed chrome and a scrolling middle.
	 *
	 * The round strip and the question header hold the top; the status line and
	 * the active control hold the bottom, at their full row cost, so the thing the
	 * operator has to act on is never the thing that gets clipped. The question
	 * text and the answer ledger share whatever is left and scroll through it.
	 * Everything is re-derived per render, so a resize is just the next frame.
	 */
	private renderInterview(question: AskUserQuestion, width: number, maxRows: number): string[] {
		const theme = clioTheme();
		const controlLines = this.renderControlLines(width);
		const statusLines = this.status.length > 0 ? ["", ...wrapTextWithAnsi(theme.fg("dim", this.status), width)] : [];
		const headerLine = this.renderQuestionHeader(question, width);
		const headerLines = headerLine.length > 0 ? [headerLine] : [];
		const stripLines = [this.renderQuestionStrip(width), ""];
		const content = [
			...wrapTextWithAnsi(question.question, width),
			"",
			...this.renderDecisionContext(width),
			...this.renderAnswerLedger(width),
		];

		// Chrome sheds from the outside in when the terminal is too short to carry
		// all of it: the round strip first, then the header, then the status, and
		// the control only if a terminal is short enough that nothing else is left.
		let top = [...stripLines, ...headerLines];
		let bottom = [...statusLines, "", ...controlLines];
		const region = (): number => maxRows - top.length - bottom.length;
		if (region() < 1) top = [...headerLines];
		if (region() < 1) top = [];
		if (region() < 1) bottom = ["", ...controlLines];
		if (region() < 1) bottom = [...controlLines];
		const regionRows = Math.max(1, region());

		const overflows = content.length > regionRows;
		this.contentOverflows = overflows;
		this.contentTotalRows = content.length;
		// One row of the region pays for the indicator when there is more than the
		// region holds, so the marker never covers a row it is reporting on.
		const viewRows = overflows ? Math.max(1, regionRows - 1) : regionRows;
		this.contentRegionHeight = viewRows;
		this.contentScrollOffset = Math.max(0, Math.min(this.contentScrollOffset, Math.max(0, content.length - viewRows)));

		const visible = content.slice(this.contentScrollOffset, this.contentScrollOffset + viewRows);
		const middle = [...visible];
		if (overflows) middle.push(fitLine(theme.fg("dim", this.scrollIndicator(content.length, viewRows)), width));
		while (middle.length < regionRows) middle.push("");

		return [...top, ...middle, ...bottom].slice(0, maxRows);
	}

	private scrollIndicator(total: number, viewRows: number): string {
		const above = this.contentScrollOffset;
		const below = Math.max(0, total - viewRows - above);
		const parts: string[] = [];
		if (above > 0) parts.push(`↑ ${above} more`);
		if (below > 0) parts.push(`↓ ${below} more`);
		parts.push(`(${Math.min(total, above + viewRows)}/${total})`);
		return parts.join("  ");
	}

	/** True when the key belonged to the scroll region rather than to a control. */
	private handleScrollInput(data: string, mode: Mode): boolean {
		if (this.surface !== "interview") return false;
		const action = this.scrollAction(data, mode);
		if (!action) return false;
		const next = nextContentScrollOffset(
			this.contentScrollOffset,
			this.contentTotalRows,
			this.contentRegionHeight,
			action,
		);
		if (next !== this.contentScrollOffset) {
			this.contentScrollOffset = next;
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

	private resetContentScroll(): void {
		this.contentScrollOffset = 0;
	}

	footerHint(): string {
		if (this.phase !== "asking") {
			return buildHint([]);
		}
		const question = this.currentQuestion();
		const state = this.currentState();
		if (!question || !state) return buildHint([]);
		const recordAnswer =
			this.presentation.requiredActions.find((action) => action.id === "record-answer")?.label.toLowerCase() ??
			"record answer";
		if (state.mode === "text") {
			// Esc means two different things depending on what is behind the field.
			// A question with options has a list to fall back to, so the key goes
			// back; a question without one has nothing behind it and the key still
			// leaves the interview. The footer says which one this is.
			const escapeVerb: OverlayEscVerb = questionHasOptions(question) ? "back" : "close";
			return this.questions.length > 1
				? this.withScrollHint(
						[
							{ key: "Enter", verb: recordAnswer },
							{ key: "Alt+Left/Right", verb: "question" },
						],
						escapeVerb,
					)
				: this.withScrollHint([{ key: "Enter", verb: recordAnswer }], escapeVerb);
		}
		// The classified action label distinguishes recording an answer from
		// granting authority. Esc on the option list is the way out of the whole
		// interview, which is the one place the product spells `close`.
		// `t` is on every select footer because the operator cannot tell from a
		// label whether the option needs a figure attached until they read it.
		const addText: HintEntry = { key: "t", verb: "add text", short: "text" };
		if (question.multi_select === true) {
			return this.questions.length > 1
				? this.withScrollHint([
						{ key: "Left/Right", verb: "question" },
						{ key: "Space", verb: "toggle" },
						addText,
						{ key: "Enter", verb: recordAnswer },
					])
				: this.withScrollHint([{ key: "Space", verb: "toggle" }, addText, { key: "Enter", verb: recordAnswer }]);
		}
		return this.questions.length > 1
			? this.withScrollHint([{ key: "Left/Right", verb: "question" }, addText, { key: "Enter", verb: recordAnswer }])
			: this.withScrollHint([addText, { key: "Enter", verb: recordAnswer }]);
	}

	private renderDecisionContext(width: number): string[] {
		const theme = clioTheme();
		const tier = theme.style(this.presentation.semanticToken, this.presentation.tierLabel, { bold: true });
		const requested = theme.fg("dim", `requested by ${this.presentation.requestedByCopy}`);
		const effect = `${theme.fg("dim", "Effect:")} ${theme.fg("muted", this.presentation.authorizationCopy)}`;
		return [
			fitLine(`${tier}${dotSep(theme)}${requested}`, width),
			...wrapTextWithAnsi(effect, width).map((line) => fitLine(line, width)),
			...wrapTextWithAnsi(theme.fg("muted", this.presentation.reversibilityCopy), width).map((line) =>
				fitLine(line, width),
			),
		];
	}

	/**
	 * The keys for this question, plus the scroll keys when there is something to
	 * scroll. A footer that always advertised PgUp would be advertising a key that
	 * does nothing on most rounds.
	 */
	private withScrollHint(entries: ReadonlyArray<HintEntry>, esc: OverlayEscVerb = "close"): string {
		if (this.surface !== "interview" || !this.contentOverflows) return buildHint(entries, esc);
		return buildHint([...entries, { key: "PgUp/PgDn", verb: "scroll" }], esc);
	}

	private setSurface(next: AskUserSurface): void {
		if (this.surface === next) return;
		this.surface = next;
		this.deps.onSurface(next);
	}

	private finish(result: AskUserResult): void {
		const resolve = this.resolveCurrent;
		this.resolveCurrent = null;
		this.list = null;
		this.input = null;
		this.status = "";
		if (result.cancelled !== true) this.history.push(...result.answers);
		if (this.phase !== "closed") this.phase = "waiting";
		// A round that follows an answered one is an interview, so the box grows
		// here rather than at the next `begin`. The waiting frame between rounds
		// is then already the size of the round it is waiting for.
		if (this.history.length > 0) this.setSurface("interview");
		this.deps.requestRender();
		resolve?.(result);
	}

	private renderWaiting(width: number, maxRows: number): string[] {
		const theme = clioTheme();
		const lines = [
			screenTitle(theme, "Interview"),
			"",
			...wrapTextWithAnsi(
				theme.fg(
					"muted",
					this.history.length > 0
						? "Answer sent. Waiting for Clio to prepare the next interview question."
						: "Waiting for Clio to prepare the interview.",
				),
				width,
			),
		];
		if (this.history.length > 0) {
			lines.push("", theme.fg("dim", "── Collected answers"));
			for (let index = 0; index < this.history.length; index += 1) {
				const answer = this.history[index];
				if (!answer) continue;
				lines.push(
					...wrapLabeledValue(`${theme.fg("dim", `${index + 1}.`)} `, theme.fg("muted", answer.answer), width),
				);
			}
		}
		return lines.map((line) => fitLine(line, width)).slice(0, maxRows);
	}

	/**
	 * Rows the body may draw on this surface.
	 *
	 * The frame budgets the same number, because its `maxHeight` is this cap plus
	 * the two border rows and both clamp to the terminal the same way. That is
	 * what keeps `fitBody`'s "… N more rows" off the compact bar: the body never
	 * hands the frame more than the frame is prepared to draw.
	 */
	private maxInnerRows(): number {
		const cap = ASK_USER_SURFACE_GEOMETRY[this.surface].maxInnerRows;
		const rows = this.deps.getTerminalRows();
		// A zero cap is the interview's "every row the frame has", which is the
		// same number the frame budgets itself when the mount passes no maxHeight.
		if (!Number.isFinite(rows) || rows <= 0) return cap > 0 ? cap : 1;
		const available = Math.max(1, Math.floor(rows) - ASK_USER_FRAME_AND_MARGIN_ROWS);
		return cap > 0 ? Math.min(cap, available) : available;
	}

	private maxVisibleOptions(): number {
		const inner = this.maxInnerRows();
		// The interview's option list is budgeted off the live row count rather
		// than a fixed heuristic: the strip, header, blank, status, blank and one
		// row of question are what the control shares the workspace with.
		if (this.surface === "interview") {
			return Math.max(MIN_VISIBLE_OPTIONS, Math.min(MAX_VISIBLE_OPTIONS, inner - INTERVIEW_CHROME_ROWS));
		}
		return Math.max(1, Math.min(MAX_VISIBLE_OPTIONS, inner - 4));
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
		if (optionIndex !== null) {
			if (question.multi_select === true) state.selected.add(optionIndex);
			else state.selected = new Set<number>([optionIndex]);
			state.focusedValue = `option:${optionIndex}`;
		}
		this.openTextInput(state.selected.size > 0 ? "Add your answer to the chosen option" : "Other answer");
	}

	/**
	 * The row above the question, or nothing.
	 *
	 * `Question 1/1` was a counter over a set of one, printed on every single
	 * confirmation. A one-question surface shows the question's own header if it
	 * has one and skips the row entirely if it does not.
	 */
	private renderQuestionHeader(question: AskUserQuestion, width: number): string {
		const theme = clioTheme();
		const parts: string[] = [];
		if (this.questions.length > 1) parts.push(theme.fg("dim", `Question ${this.index + 1}/${this.questions.length}`));
		if (question.header) parts.push(screenTitle(theme, question.header));
		if (this.currentState()?.answer.trim()) parts.push(theme.fg("muted", "answered"));
		return parts.length > 0 ? fitLine(parts.join(dotSep(theme)), width) : "";
	}

	private renderQuestionStrip(width: number): string {
		const theme = clioTheme();
		const total = this.questions.length;
		// A single-question interview round is the phased shape: one question per
		// round, several rounds. Its position is the round number, since there is
		// no set of siblings to draw a strip across.
		if (total <= 1) {
			const round = theme.fg("dim", `Round ${this.history.length + 1}`);
			return fitLine(`${screenTitle(theme, "Interview")}${dotSep(theme)}${round}`, width);
		}
		const gap = "  ";
		const slotWidth = Math.max(10, Math.floor((width - visibleWidth(gap) * (total - 1)) / total));
		const parts = this.questions.map((question, index) => {
			const state = this.states[index];
			const active = index === this.index;
			const marker = active ? theme.fg("accent", `${GLYPH.cursor} `) : "  ";
			const answerState = state?.answer.trim() ? theme.fg("muted", "answered") : theme.fg("dim", "pending");
			const title = active
				? theme.style("accent", compactTitle(question), { bold: true })
				: theme.fg("muted", compactTitle(question));
			return fitLine(`${marker}${theme.fg("dim", `Q${index + 1}`)} ${answerState} ${title}`, slotWidth);
		});
		return fitLine(parts.join(gap), width);
	}

	private renderControlLines(width: number): string[] {
		this.ensureControl();
		const state = this.currentState();
		if (state?.mode === "text") return this.renderTextInput(width);
		return this.renderSelectControl(width);
	}

	/**
	 * Everything this interview has captured, rounds already answered first.
	 *
	 * The ledger used to read only the current round's states, so a phased
	 * interview asking one question per round showed nothing at all: each round
	 * was a set of one and the summary bailed out. What the operator has already
	 * told Clio is the reason the full surface exists.
	 */
	private renderAnswerLedger(width: number): string[] {
		const theme = clioTheme();
		const rows: string[] = [];
		for (let index = 0; index < this.history.length; index += 1) {
			const answer = this.history[index];
			if (!answer) continue;
			rows.push(
				...wrapLabeledValue(`${theme.fg("dim", `${index + 1}.`)} `, theme.fg("muted", answer.answer), width),
			);
		}
		// A round of one question needs no per-question roll: the strip already
		// names the round and the question is on screen above this.
		if (this.questions.length > 1) {
			for (let index = 0; index < this.questions.length; index += 1) {
				const answer = this.states[index]?.answer.trim();
				const value = answer && answer.length > 0 ? theme.fg("muted", answer) : theme.fg("dim", "pending");
				rows.push(...wrapLabeledValue(`${theme.fg("dim", `Q${index + 1}`)} `, value, width));
			}
		}
		if (rows.length === 0) return [];
		return ["", fitLine(theme.fg("dim", "── Answers"), width), ...rows];
	}

	private renderTextInput(width: number): string[] {
		const theme = clioTheme();
		return (this.input?.render(width) ?? [""]).map((line) =>
			fitLine(line.startsWith("> ") ? `${theme.fg("accent", `${GLYPH.cursor} `)}${line.slice(2)}` : line, width),
		);
	}

	private renderSelectControl(width: number): string[] {
		const question = this.currentQuestion();
		const state = this.currentState();
		const selectedItem = this.list?.getSelectedItem();
		if (!question || !state || !selectedItem) return [""];
		const theme = clioTheme();
		const items = optionItems(question, state.selected);
		const selectedIndex = Math.max(
			0,
			items.findIndex((item) => item.value === selectedItem.value),
		);
		const primaryColumnWidth = this.primaryColumnWidth(items, width);
		const acceptKey = question.multi_select === true ? "Space" : "Enter";
		// The focused option's description wraps in full, so the rows it needs come
		// out of the list rather than out of the sentence. Options the operator
		// cannot currently read are what a windowed list is for, and one arrow key
		// brings any of them back; a cut explanation has no such recovery.
		const focusedRows = this.renderOptionRow(
			items[selectedIndex] as SelectItem,
			true,
			width,
			primaryColumnWidth,
			acceptKey,
		).length;
		const budget = Math.max(1, this.maxVisibleOptions() - (focusedRows - 1));
		const visibleCount = Math.min(budget, Math.max(1, items.length));
		const start = Math.max(0, Math.min(selectedIndex - Math.floor(visibleCount / 2), items.length - visibleCount));
		const end = Math.min(items.length, start + visibleCount);
		const lines: string[] = [];

		for (let index = start; index < end; index += 1) {
			const item = items[index];
			if (!item) continue;
			lines.push(...this.renderOptionRow(item, index === selectedIndex, width, primaryColumnWidth, acceptKey));
		}

		if (start > 0 || end < items.length) {
			lines.push(fitLine(theme.fg("dim", `  (${selectedIndex + 1}/${items.length})`), width));
		}
		return lines;
	}

	private primaryColumnWidth(items: ReadonlyArray<SelectItem>, width: number): number {
		const widest = items.reduce((max, item) => Math.max(max, visibleWidth(item.label) + 2), 0);
		const bounded = Math.max(24, Math.min(38, widest));
		return Math.max(1, Math.min(bounded, Math.max(1, width - 4)));
	}

	/**
	 * One option, as the rows it needs.
	 *
	 * The focused option's description wraps under its own column and is never
	 * cut: a description is what the operator is choosing between, and half of
	 * one reads as the whole thing. An unfocused row stays a one-line table cell
	 * whose ellipsis says there is more, which the operator reads by moving to
	 * it.
	 */
	private renderOptionRow(
		item: SelectItem,
		selected: boolean,
		width: number,
		primaryColumnWidth: number,
		acceptKey: string,
	): string[] {
		const theme = clioTheme();
		const prefix = selected ? theme.fg("accent", `${GLYPH.cursor} `) : "  ";
		// The key that answers rides on the focused row. An operator whose eyes are
		// already on the option they want should not have to travel to the footer
		// to learn what commits it.
		const affordance = selected ? ` ${theme.style("accent", `[${acceptKey}]`, { bold: true })}` : "";
		const available = Math.max(1, width - 2 - visibleWidth(affordance));
		const description = item.description?.replace(/[\r\n]+/g, " ").trim();

		if (!description || width <= 40) {
			const label = truncateToWidth(item.label, available, ELLIPSIS, false);
			const body = selected ? theme.style("accent", label, { bold: true }) : label;
			return [fitLine(`${prefix}${body}${affordance}`, width)];
		}

		const labelWidth = Math.max(1, Math.min(primaryColumnWidth - 2, available - 4));
		const label = truncateToWidth(item.label, labelWidth, ELLIPSIS, false);
		const spacing = " ".repeat(Math.max(1, primaryColumnWidth - visibleWidth(label)));
		const descriptionWidth = Math.max(1, available - visibleWidth(label) - visibleWidth(spacing));
		if (!selected) {
			const desc = truncateToWidth(description, descriptionWidth, ELLIPSIS, false);
			return [fitLine(`${prefix}${label}${theme.fg("muted", `${spacing}${desc}`)}`, width)];
		}
		// A gutter this narrow wraps a sentence into slivers and breaks words, so
		// below the floor the description drops to its own full-width lines under
		// the label instead of squeezing into the second column.
		if (descriptionWidth < MIN_DESCRIPTION_COLUMN) {
			const indent = "    ";
			const body = theme.style("accent", label, { bold: true });
			return [
				fitLine(`${prefix}${body}${affordance}`, width),
				...wrapTextWithAnsi(description, Math.max(1, width - indent.length)).map((line) =>
					fitLine(`${indent}${theme.style("accent", line, { bold: true })}`, width),
				),
			];
		}
		const wrapped = wrapTextWithAnsi(description, descriptionWidth);
		const head = wrapped[0] ?? "";
		const indent = " ".repeat(visibleWidth(prefix) + visibleWidth(label) + visibleWidth(spacing));
		return [
			fitLine(`${prefix}${theme.style("accent", `${label}${spacing}${head}`, { bold: true })}${affordance}`, width),
			...wrapped.slice(1).map((line) => fitLine(`${indent}${theme.style("accent", line, { bold: true })}`, width)),
		];
	}

	private ensureControl(): void {
		const question = this.currentQuestion();
		const state = this.currentState();
		if (!question || !state) return;
		if (state.mode === "text" && !this.input) this.rebuildTextInput(question, state);
		if (state.mode === "select" && !this.list) this.rebuildSelectList(question, state);
	}

	private rebuildControl(): void {
		const question = this.currentQuestion();
		const state = this.currentState();
		if (!question || !state) {
			this.input = null;
			this.list = null;
			return;
		}
		if (state.mode === "text") this.rebuildTextInput(question, state);
		else this.rebuildSelectList(question, state);
	}

	private rebuildTextInput(question: AskUserQuestion, state: QuestionState): void {
		const activeInput = new Input();
		activeInput.setValue(state.inputValue || state.customAnswer || state.answer);
		activeInput.onSubmit = (value) => {
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
			state.answer = questionHasOptions(question) ? answerText(question, state.selected, state.customAnswer) : answer;
			this.finishIfCompleteOrAdvance();
		};
		activeInput.onEscape = () => this.escapeFromTextInput(question, state);
		this.input = activeInput;
		this.list = null;
	}

	private rebuildSelectList(question: AskUserQuestion, state: QuestionState): void {
		const items = optionItems(question, state.selected);
		const activeList = new SelectList(
			items,
			Math.min(this.maxVisibleOptions(), Math.max(1, items.length)),
			DEFAULT_SELECT_THEME,
			{
				minPrimaryColumnWidth: 24,
				maxPrimaryColumnWidth: 38,
			},
		);
		activeList.onSelect = (item) => {
			if (item.value === "other") {
				this.openTextInput("Other answer");
				return;
			}
			const optionIndex = optionIndexFromValue(item.value);
			if (optionIndex === null) return;
			if (question.multi_select === true) {
				this.toggleSelectionIndex(question, state, optionIndex);
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
		this.input = null;
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

	private openTextInput(nextStatus: string): void {
		const state = this.currentState();
		const question = this.currentQuestion();
		if (!state || !question) return;
		this.syncActiveControl();
		state.mode = "text";
		this.status = nextStatus;
		this.rebuildTextInput(question, state);
		this.deps.requestRender();
	}

	private toggleCurrentSelection(question: AskUserQuestion, state: QuestionState): void {
		const current = this.list?.getSelectedItem();
		if (!current) return;
		if (current.value === "other") {
			this.openTextInput("Other answer");
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
			this.openTextInput("Other answer");
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
			this.resetContentScroll();
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
		this.resetContentScroll();
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
		if (this.input) state.inputValue = this.input.getValue();
	}
}

/**
 * Show the ask_user overlay, on whichever surface the request calls for.
 *
 * A box's anchor, width, and height budget are fixed when the engine mounts it,
 * so moving between surfaces means mounting a new frame around the same body and
 * dropping the old one. That happens at most once per round, when the shape of
 * the request actually changes; the new frame is shown before the old one is
 * hidden so the keyboard passes straight across instead of returning to the
 * composer for a frame.
 */
export function openAskUserOverlay(tui: TUI, deps: OpenAskUserOverlayDeps): AskUserOverlaySession {
	let handle: OverlayHandle | null = null;
	let mounted: AskUserSurface | null = null;
	let closed = false;

	const view = new AskUserOverlayView({
		...deps,
		getTerminalRows: () => tui.terminal?.rows ?? 0,
		requestRender: () => tui.requestRender(),
		onSurface: (surface) => mount(surface),
	});

	const mount = (surface: AskUserSurface): void => {
		if (closed || mounted === surface) return;
		const geometry = ASK_USER_SURFACE_GEOMETRY[surface];
		const previous = handle;
		handle = showClioOverlayFrame(tui, view, {
			anchor: geometry.anchor,
			width: geometry.width,
			// A zero cap means the frame keeps its own budget, which is every row
			// the terminal has left after the margins.
			...(geometry.maxInnerRows > 0 ? { maxHeight: geometry.maxInnerRows + ASK_USER_FRAME_ROWS } : {}),
			margin: geometry.margin,
			// Not derived from the title: this modal swaps between a waiting title
			// and a classified decision title without ever changing hands.
			markerId: "ask-user",
			title: () => (view.isDecisionPending() ? view.decisionTitle() : ASK_USER_WAITING_TITLE),
			tone: () => (view.isDecisionPending() ? view.decisionTone() : undefined),
			footerHint: () => view.footerHint(),
		});
		mounted = surface;
		previous?.hide();
	};

	mount(view.currentSurface());

	const close = (): void => {
		closed = true;
		view.close();
		handle?.hide();
		handle = null;
	};
	return {
		setHidden: (hidden) => handle?.setHidden(hidden),
		isHidden: () => handle?.isHidden() ?? true,
		focus: () => handle?.focus(),
		unfocus: (options) => (options ? handle?.unfocus(options) : handle?.unfocus()),
		isFocused: () => handle?.isFocused() ?? false,
		ask: (questions, presentation) => view.begin(questions, presentation),
		cancel: () => view.cancel(),
		close,
		hide: close,
		isWaiting: () => view.isWaiting(),
	};
}
