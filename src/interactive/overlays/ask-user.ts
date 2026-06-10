import {
	type Component,
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
import { ASK_USER_OTHER_LABEL, cancelledAskUserResult } from "../../tools/ask-user.js";
import { DEFAULT_SELECT_THEME, showClioOverlayFrame } from "../overlay-frame.js";

export const ASK_USER_OVERLAY_WIDTH = "94%";
export const ASK_USER_OVERLAY_MIN_WIDTH = 72;
export const ASK_USER_OVERLAY_MAX_HEIGHT = "92%";

const ASK_USER_MIN_INNER_ROWS = 12;
const ASK_USER_FALLBACK_INNER_ROWS = 20;
const ASK_USER_MAX_INNER_ROWS = 42;
const ASK_USER_FRAME_AND_MARGIN_ROWS = 4;
const MIN_VISIBLE_OPTIONS = 3;
const MAX_VISIBLE_OPTIONS = 12;

export interface OpenAskUserOverlayDeps {
	onCancel: () => void;
}

export interface AskUserOverlaySession extends OverlayHandle {
	ask(questions: ReadonlyArray<AskUserQuestion>): Promise<AskUserResult>;
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
	focusedValue?: string;
}

interface AskUserOverlayViewDeps extends OpenAskUserOverlayDeps {
	getTerminalRows: () => number;
	requestRender: () => void;
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

function answerText(question: AskUserQuestion, selected: ReadonlySet<number>, customAnswer: string): string {
	const parts: string[] = [];
	for (const index of [...selected].sort((a, b) => a - b)) {
		const label = question.options?.[index]?.label;
		if (label) parts.push(label);
	}
	const custom = customAnswer.trim();
	if (custom.length > 0) parts.push(custom);
	return parts.join("; ");
}

function fitLine(text: string, width: number): string {
	const safeWidth = Math.max(1, width);
	if (visibleWidth(text) <= safeWidth) return text;
	return truncateToWidth(text, safeWidth, "", true);
}

function compactTitle(question: AskUserQuestion): string {
	return (question.header ?? question.question).replace(/\s+/g, " ").trim();
}

class AskUserOverlayView implements Component {
	private phase: InterviewPhase = "waiting";
	private index = 0;
	private status = "";
	private questions: ReadonlyArray<AskUserQuestion> = [];
	private states: QuestionState[] = [];
	private history: AskUserAnswer[] = [];
	private list: SelectList | null = null;
	private input: Input | null = null;
	private resolveCurrent: ((result: AskUserResult) => void) | null = null;

	constructor(private readonly deps: AskUserOverlayViewDeps) {}

	begin(questions: ReadonlyArray<AskUserQuestion>): Promise<AskUserResult> {
		if (this.phase === "closed") return Promise.resolve(cancelledAskUserResult());
		if (this.resolveCurrent) return Promise.resolve(cancelledAskUserResult());
		this.phase = "asking";
		this.index = 0;
		this.status = "";
		this.questions = [...questions];
		this.states = this.questions.map((question) => createQuestionState(question));
		this.list = null;
		this.input = null;
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

	invalidate(): void {
		this.list?.invalidate();
		this.input?.invalidate();
	}

	handleInput(data: string): void {
		if (this.phase !== "asking") return;
		const question = this.currentQuestion();
		const state = this.currentState();
		if (!question || !state) return;

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
		this.list?.handleInput(data);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const targetRows = this.targetInnerRows();
		if (this.phase !== "asking") return this.renderWaiting(safeWidth, targetRows);
		const question = this.currentQuestion();
		if (!question) return this.padLines(["No questions."], targetRows);

		const controlLines = this.renderControlLines(safeWidth);
		const summaryLines = this.renderAnswerSummary(
			safeWidth,
			this.states.map((state) => state.answer),
		);
		const statusLines = this.status.length > 0 ? ["", fitLine(this.status, safeWidth)] : [];
		const headerLine = this.renderQuestionHeader(question, safeWidth);
		const baseRows = 1 + 1 + 1 + statusLines.length + 1 + controlLines.length + summaryLines.length;
		const questionBudget = Math.max(2, targetRows - baseRows);
		const questionLines = wrapTextWithAnsi(question.question, safeWidth).slice(0, questionBudget);

		const lines = [
			this.renderQuestionStrip(safeWidth),
			"",
			headerLine,
			...questionLines,
			...statusLines,
			"",
			...controlLines,
			...summaryLines,
		];
		return this.padLines(lines, targetRows).slice(0, targetRows);
	}

	footerHint(): string {
		if (this.phase !== "asking") {
			return this.history.length > 0 ? "[Esc] cancel interview" : "[Esc] cancel";
		}
		const question = this.currentQuestion();
		const state = this.currentState();
		if (!question || !state) return "[Esc] cancel";
		if (state.mode === "text") {
			return this.questions.length > 1
				? "[Enter] submit    [Alt+Left/Right] question    [Esc] cancel"
				: "[Enter] submit    [Esc] cancel";
		}
		if (question.multi_select === true) {
			return this.questions.length > 1
				? "[Left/Right] question    [Space] toggle    [Enter] commit    [Esc] cancel"
				: "[Space] toggle    [Enter] commit    [Esc] cancel";
		}
		return this.questions.length > 1
			? "[Left/Right] question    [Enter] select    [Esc] cancel"
			: "[Enter] select    [Esc] cancel";
	}

	private finish(result: AskUserResult): void {
		const resolve = this.resolveCurrent;
		this.resolveCurrent = null;
		this.list = null;
		this.input = null;
		this.status = "";
		if (result.cancelled !== true) this.history.push(...result.answers);
		if (this.phase !== "closed") this.phase = "waiting";
		this.deps.requestRender();
		resolve?.(result);
	}

	private renderWaiting(width: number, targetRows: number): string[] {
		const lines = [
			"Interview",
			"",
			this.history.length > 0
				? "Answer sent. Waiting for Clio to prepare the next interview question."
				: "Waiting for Clio to prepare the interview.",
		];
		if (this.history.length > 0) {
			lines.push("", "Collected answers");
			for (let index = 0; index < this.history.length; index += 1) {
				const answer = this.history[index];
				if (!answer) continue;
				lines.push(fitLine(`${index + 1}. ${answer.answer}`, width));
			}
		}
		return this.padLines(
			lines.map((line) => fitLine(line, width)),
			targetRows,
		).slice(0, targetRows);
	}

	private targetInnerRows(): number {
		const rows = this.deps.getTerminalRows();
		if (!Number.isFinite(rows) || rows <= 0) return ASK_USER_FALLBACK_INNER_ROWS;
		return Math.max(
			ASK_USER_MIN_INNER_ROWS,
			Math.min(ASK_USER_MAX_INNER_ROWS, Math.floor(rows) - ASK_USER_FRAME_AND_MARGIN_ROWS),
		);
	}

	private maxVisibleOptions(): number {
		return Math.max(MIN_VISIBLE_OPTIONS, Math.min(MAX_VISIBLE_OPTIONS, this.targetInnerRows() - 12));
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

	private renderQuestionHeader(question: AskUserQuestion, width: number): string {
		const parts = [`Question ${this.index + 1}/${this.questions.length}`];
		if (question.header) parts.push(question.header);
		if (this.currentState()?.answer.trim()) parts.push("answered");
		return fitLine(parts.join(" - "), width);
	}

	private renderQuestionStrip(width: number): string {
		const total = this.questions.length;
		if (total <= 1) return fitLine("Interview", width);
		const gap = "  ";
		const slotWidth = Math.max(10, Math.floor((width - visibleWidth(gap) * (total - 1)) / total));
		const parts = this.questions.map((question, index) => {
			const state = this.states[index];
			const marker = index === this.index ? ">" : " ";
			const answerState = state?.answer.trim() ? "done" : "todo";
			return fitLine(`${marker} Q${index + 1} ${answerState} ${compactTitle(question)}`, slotWidth);
		});
		return fitLine(parts.join(gap), width);
	}

	private renderControlLines(width: number): string[] {
		this.ensureControl();
		const state = this.currentState();
		if (state?.mode === "text") return this.input?.render(width) ?? [""];
		return this.list?.render(width) ?? [""];
	}

	private renderAnswerSummary(width: number, answers: ReadonlyArray<string>): string[] {
		if (this.questions.length <= 1) return [];
		const lines = ["", fitLine("Answers", width)];
		for (let index = 0; index < this.questions.length; index += 1) {
			const answer = answers[index]?.trim();
			const text = answer && answer.length > 0 ? answer : "pending";
			lines.push(fitLine(`Q${index + 1}: ${text}`, width));
		}
		return lines;
	}

	private padLines(lines: string[], targetRows: number): string[] {
		while (lines.length < targetRows) lines.push("");
		return lines;
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
			if (questionHasOptions(question) && question.multi_select === true) {
				state.customAnswer = answer;
				this.commitCurrentAnswer();
			} else {
				state.customAnswer = questionHasOptions(question) ? answer : "";
				state.answer = answer;
				this.finishIfCompleteOrAdvance();
			}
		};
		activeInput.onEscape = () => this.cancel();
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
			state.answer = question.options?.[optionIndex]?.label ?? item.label;
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

	private answers(): AskUserResult["answers"] {
		const answers: AskUserResult["answers"] = [];
		for (let index = 0; index < this.questions.length; index += 1) {
			const question = this.questions[index];
			const answer = this.states[index]?.answer.trim();
			if (question && answer && answer.length > 0) answers.push({ question: question.question, answer });
		}
		return answers;
	}

	private goToRelativeQuestion(delta: -1 | 1): void {
		if (this.questions.length <= 1) return;
		this.syncActiveControl();
		this.index = (this.index + delta + this.questions.length) % this.questions.length;
		this.status = "";
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

export function openAskUserOverlay(tui: TUI, deps: OpenAskUserOverlayDeps): AskUserOverlaySession {
	const view = new AskUserOverlayView({
		...deps,
		getTerminalRows: () => tui.terminal?.rows ?? 0,
		requestRender: () => tui.requestRender(),
	});
	const handle = showClioOverlayFrame(tui, view, {
		anchor: "center",
		width: ASK_USER_OVERLAY_WIDTH,
		minWidth: ASK_USER_OVERLAY_MIN_WIDTH,
		maxHeight: ASK_USER_OVERLAY_MAX_HEIGHT,
		margin: 1,
		title: "Ask User",
		footerHint: () => view.footerHint(),
	});
	const close = (): void => {
		view.close();
		handle.hide();
	};
	return {
		...handle,
		ask: (questions) => view.begin(questions),
		cancel: () => view.cancel(),
		close,
		hide: close,
		isWaiting: () => view.isWaiting(),
	};
}
