import type { OutputStyle } from "../core/defaults.js";
import { colorDisabled, nerdFontEnabled } from "../core/terminal-preferences.js";
import {
	Editor,
	getKeybindings,
	stripTerminalSequences,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../engine/tui.js";
import { type DockEntry, dockAdaptiveRows, dockBodyRows, dockGrowthRows, dockTop } from "./dock.js";
import { guardPastedEditorOperator } from "./editor-bash.js";
import { type EditorRailState, renderEditorRail } from "./editor-rails.js";
import { type ContextOccupancyFacts, contextRailHint } from "./footer/context-rail.js";
import { centeredWindow, fitHintEntries } from "./overlay-frame.js";
import { type PermissionInspectionHint, permissionHintEntries } from "./permission-hint.js";
import type { SlashCompletionItem } from "./slash-autocomplete.js";
import type { ClioTheme, ClioToken } from "./theme/index.js";
import {
	attentionCue,
	clioTheme,
	editorTheme,
	GLYPH,
	padAnsi,
	projectsYolo,
	rule,
	withThemeContext,
} from "./theme/index.js";
import { modelNickname, type TargetIdentity } from "./theme/labels.js";
import { createComposerSurfacePainter } from "./theme/yolo-surface.js";
import type { TurnPreparationPhase } from "./turn-state.js";

const REVERSE_VIDEO = `${String.fromCharCode(27)}[7m`;
const REVERSE_VIDEO_BLANK = `${REVERSE_VIDEO} ${String.fromCharCode(27)}[0m`;
const EMPTY_PROMPT = "Ask Clio…  / for commands";
const CONFIRM_PROMPT = "A parked call is waiting for your decision";
const PREPARING_PROMPT = "Clio has your prompt and is preparing the turn";
const COMPACTING_PROMPT = "Clio is compacting the session context";
/** Rows the suggestion detail panel may take: breadcrumb, two effect lines, two next-action lines. */
const SUGGESTION_PANEL_ROWS = 5;
/** Fewest list rows kept visible when the panel has to share a short dock. */
const SUGGESTION_MIN_LIST_ROWS = 3;

export interface EditorChrome {
	/** Raw route fields from presentation; startup/legacy labels remain opaque strings. */
	getModelLabel: () => TargetIdentity | string;
	/** Effective label plus whether the model actually has an effort range. */
	getThinkingLabel: () => string;
	getThinking?: () => { label: string; hasLevels: boolean; supportedLevels?: readonly string[] };
	getHarnessStatus?: (width: number) => { label: string; glyph: string; token: ClioToken; live: boolean } | null;
	/** Published context accounting; rendering never refreshes the estimate. */
	getContextUsage?: () => ContextOccupancyFacts | undefined;
	getOutputStyle?: () => OutputStyle;
	/** Effective session autonomy, including live overrides. */
	getAutonomy?: () => string;
	/** Monotonic animation clock, injectable for deterministic rendering tests. */
	getAnimationTime?: () => number;
	/** Demo-off keeps optional attention motion static. */
	getMotionEnabled?: () => boolean;
	/** Whether Enter currently targets the active Clio response. */
	isStreaming?: () => boolean;
	/**
	 * Whether a permission prompt owns the keyboard. The dialog once sat at the
	 * vertical center of a tall viewport, far from the composer. It now anchors
	 * above that composer, while the rail still says CONFIRM and carries the
	 * dialog's keys whenever the prompt owns input (issues #186 and #194).
	 */
	isAwaitingApproval?: () => boolean;
	/**
	 * Whether that prompt is a mutation the operator can read locally, and
	 * whether it is open. The rail carries the dialog's keys, so it names the
	 * inspect key on exactly the cards that have one (issue #254).
	 */
	getPermissionInspection?: () => PermissionInspectionHint;
	/**
	 * Where a consumed prompt is between the editor and the stream. The editor
	 * is cleared before admission, so without this the composer went straight
	 * back to `MESSAGE` and a 77-second pre-submit compaction was
	 * indistinguishable from a dropped Enter (issue #251).
	 */
	getTurnPreparation?: () => TurnPreparationPhase;
	/** Whether the current draft will actually steer Clio or live dispatch work on Enter. */
	willEnterSteer?: (text: string) => boolean;
	/** Resolved submit binding, formatted for display. */
	getSubmitKeyLabel?: () => string;
	/** Resolved multiline binding, formatted for display. */
	getNewlineKeyLabel?: () => string;
}

type ComposerMode = "MESSAGE" | "FOLLOW-UP" | "STEER" | "CONFIRM" | "PREPARING" | "COMPACTING";

function composerMode(chrome: EditorChrome, text: string): ComposerMode {
	if (chrome.isAwaitingApproval?.() ?? false) return "CONFIRM";
	if (!(chrome.isStreaming?.() ?? false)) {
		// A prompt Clio is holding is not an idle composer. Streaming outranks it
		// because a steer typed during a live run is what the rail is for, and a
		// steer's own submit passes through this window on its way to the queue.
		const preparation = chrome.getTurnPreparation?.() ?? "idle";
		if (preparation === "compacting") return "COMPACTING";
		if (preparation === "preparing") return "PREPARING";
		return "MESSAGE";
	}
	const willSteer = chrome.willEnterSteer?.(text) ?? text.trim().length > 0;
	return willSteer ? "STEER" : "FOLLOW-UP";
}

/**
 * The permission keys on the composer rail, fitted like the dialog footer so
 * both surfaces narrow in the same order and never drop allow or stop first.
 * The rule spends three columns around a right label, hence the subtraction.
 */
function confirmRailHint(
	theme: ClioTheme,
	width: number,
	hasDraft: boolean,
	inspection: PermissionInspectionHint,
): string {
	return theme.fg("decisionKey", fitHintEntries(permissionHintEntries(hasDraft, inspection), Math.max(1, width - 3)));
}

// Stable meaning across providers: ordinary effort occupies one through four
// brains; an admitted maximum is four brains with explicit attention ink.
// Minimal shares the lowest graphical step; settings retain the exact choice.
const THINKING_BRAINS: Readonly<Record<string, number>> = {
	off: 0,
	minimal: 1,
	low: 1,
	medium: 2,
	high: 3,
	xhigh: 4,
	max: 4,
	ultra: 4,
};
const THINKING_BRAIN_SLOTS = 4;

/** Four static marks; textual fallback preserves exact state when graphics cannot. */
function thinkingRailHint(
	theme: ClioTheme,
	thinking: ReturnType<NonNullable<EditorChrome["getThinking"]>>,
	width: number,
): string {
	const level = thinking.label;
	const levels = thinking.supportedLevels ?? [];
	const count = Object.hasOwn(THINKING_BRAINS, level) ? THINKING_BRAINS[level] : undefined;
	const glyph = nerdFontEnabled() ? GLYPH.brain : "●";
	const glyphWidth = visibleWidth(glyph);
	const graphicalWidth = THINKING_BRAIN_SLOTS * glyphWidth + THINKING_BRAIN_SLOTS - 1;
	if (
		!thinking.hasLevels ||
		levels.length === 0 ||
		count === undefined ||
		(level !== "off" && !levels.includes(level)) ||
		process.env.CLIO_CODER_SCREEN_READER === "1" ||
		colorDisabled() ||
		width < graphicalWidth
	)
		return theme.fg("thinkingLevel", `think ${level}`);
	const activeRole = level === "max" || level === "ultra" ? "thinkingMaximum" : "thinkingActive";
	return Array.from({ length: THINKING_BRAIN_SLOTS }, (_, index) =>
		theme.fg(index < count ? activeRole : "thinkingInactive", index < count || nerdFontEnabled() ? glyph : "○"),
	).join(" ");
}

/** The line the empty composer shows for the mode it is in. */
function emptyPromptFor(mode: ComposerMode): string {
	if (mode === "CONFIRM") return CONFIRM_PROMPT;
	if (mode === "PREPARING") return PREPARING_PROMPT;
	if (mode === "COMPACTING") return COMPACTING_PROMPT;
	return EMPTY_PROMPT;
}

function renderEmptyPrompt(line: string, width: number, theme: ClioTheme, text = EMPTY_PROMPT): string {
	const cursorAt = line.indexOf(REVERSE_VIDEO_BLANK);
	if (cursorAt < 0) return line;
	const afterCursorAt = cursorAt + REVERSE_VIDEO_BLANK.length;
	const available = Math.max(0, width - 1);
	const invitation =
		text === EMPTY_PROMPT
			? `${theme.fg("inputPlaceholder", "Ask Clio…  ")}${theme.fg("commandHint", "/ for commands")}`
			: theme.fg("inputPlaceholder", text);
	const prompt = truncateToWidth(invitation, available, "…", false);
	const consumed = visibleWidth(prompt);
	return `${line.slice(0, afterCursorAt)}${prompt}${line.slice(afterCursorAt + consumed)}`;
}

/** A one-line slash command whose cursor sits after a space, ready for the next argument. */
function cursorAwaitsSlashArgument(editor: Editor): boolean {
	const lines = editor.getLines();
	const cursor = editor.getCursor();
	const line = lines[0] ?? "";
	return lines.length === 1 && cursor.line === 0 && cursor.col === line.length && /^\s*\/\S*\s(?:.*\s)?$/u.test(line);
}

function cursorEndsDirectoryPath(editor: Editor): boolean {
	const cursor = editor.getCursor();
	const line = editor.getLines()[cursor.line] ?? "";
	return line.slice(0, cursor.col).endsWith("/");
}

function remapPastedBangOffsets(
	before: string,
	after: string,
	offsets: ReadonlySet<number>,
	markInsertedAsPasted: boolean,
): Set<number> {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
	let beforeEnd = before.length;
	let afterEnd = after.length;
	while (beforeEnd > prefix && afterEnd > prefix && before[beforeEnd - 1] === after[afterEnd - 1]) {
		beforeEnd -= 1;
		afterEnd -= 1;
	}

	const next = new Set<number>();
	const shift = afterEnd - prefix - (beforeEnd - prefix);
	for (const offset of offsets) {
		if (offset < prefix) next.add(offset);
		else if (offset >= beforeEnd) next.add(offset + shift);
	}
	if (markInsertedAsPasted) {
		for (let offset = prefix; offset < afterEnd; offset += 1) {
			if (after[offset] === "!") next.add(offset);
		}
	}
	return next;
}

function startsWithPastedOperator(text: string, pastedBangOffsets: ReadonlySet<number>): boolean {
	const first = text.search(/\S/u);
	return first >= 0 && text[first] === "!" && pastedBangOffsets.has(first);
}

export class ClioEditor extends Editor {
	private pastedBangOffsets = new Set<number>();
	private bracketedPasteActive = false;
	private revision = 0;
	private railAnimationTime = 0;
	private readonly surfacePainters = new Map<string, (line: string) => string>();
	private renderedBottomRail = "";
	private renderedTopHidden = 0;
	private renderedBottomHidden = 0;
	private autocompleteDockOpen = false;
	private autocompleteRowMap: number[] | null = null;
	private autocompleteSourceStart = 0;
	private pastedOperatorTokens = new Set<string>();

	get draftRevision(): number {
		return this.revision;
	}

	/** Restored queues and external buffers are literal editor content. */
	setLiteralText(text: string): void {
		this.setText(text);
		this.pastedBangOffsets = new Set([...text.matchAll(/!/gu)].map((match) => match.index));
	}

	override applyEdit(operation: Parameters<Editor["applyEdit"]>[0]): void {
		const before = this.getText();
		super.applyEdit(operation);
		this.revision += 1;
		this.pastedBangOffsets = remapPastedBangOffsets(before, this.getText(), this.pastedBangOffsets, operation === "undo");
	}

	/** The dock registry key; the base class keeps its own reference under a wider type. */
	private readonly dockHost: TUI;

	constructor(
		tui: TUI,
		private readonly chrome: EditorChrome,
	) {
		super(tui, editorTheme(clioTheme()), { autocompleteMaxVisible: ClioEditor.suggestionListRows(tui) });
		this.dockHost = tui;
	}

	/** Rows the suggestion list may show: the dock's growth ceiling less the input, rule and detail panel. */
	private static suggestionListRows(tui: TUI): number {
		return Math.max(3, dockGrowthRows(tui) - 3 - SUGGESTION_PANEL_ROWS);
	}

	/** The row the list has selected. The engine keeps its list private and the dock already reads its rendered rows. */
	private selectedSuggestion(): SlashCompletionItem | null {
		const list = (this as unknown as { autocompleteList?: { getSelectedItem(): unknown } }).autocompleteList;
		const item = list?.getSelectedItem() as SlashCompletionItem | null | undefined;
		return item?.path ? item : null;
	}

	/** Ask the provider for the next argument without the forced Tab path, which auto-applies a lone row. */
	private reopenSuggestions(): void {
		const request = (this as unknown as { tryTriggerAutocomplete?: () => void }).tryTriggerAutocomplete;
		request?.call(this);
	}

	/** Breadcrumb, effect and next action for the selected suggestion, drawn under the list. */
	private suggestionPanel(item: SlashCompletionItem, width: number, theme: ClioTheme): string[] {
		const gutter = `${theme.fg("border", "│")} `;
		const room = Math.max(1, width - 4 - visibleWidth(gutter));
		const parts = item.path?.split(" › ") ?? [];
		const crumb = parts
			.map((part, index) => {
				const last = index === parts.length - 1;
				return theme.style(last ? "selectedOption" : "commandHint", part, { bold: last });
			})
			.join(theme.fg("border", " › "));
		const unavailable = item.disabledReason ? theme.fg("emptyState", "  unavailable") : "";
		const rows = [`${gutter}${truncateToWidth(`${crumb}${unavailable}`, room, GLYPH.ellipsis, false)}`];
		// A sentence that outgrows its two lines ends in an ellipsis rather than a silent cut.
		const wrapClamped = (text: string, paint: (line: string) => string): string[] => {
			const wrapped = wrapTextWithAnsi(text, room);
			const shown = wrapped.slice(0, 2);
			if (wrapped.length > 2)
				shown[1] = truncateToWidth(`${shown[1] ?? ""} ${wrapped[2] ?? ""}`, room, GLYPH.ellipsis, false);
			return shown.map((line) => `${gutter}${paint(line)}`);
		};
		const effect = item.effectDescription ?? item.description ?? "";
		if (effect) rows.push(...wrapClamped(effect, (line) => theme.base("menuOption", line)));
		if (item.nextAction) rows.push(...wrapClamped(item.nextAction, (line) => theme.fg("keyboardHint", line)));
		return rows.slice(0, SUGGESTION_PANEL_ROWS);
	}

	/** Two-column gutter on each side of a docked body, the autocomplete's own indent. */
	private static readonly DOCK_GUTTER = 2;

	private railState(mode: ComposerMode): EditorRailState {
		const working = mode !== "MESSAGE" || this.chrome.getHarnessStatus?.(80)?.live === true;
		return {
			phase: mode === "CONFIRM" ? "attention" : working ? "working" : "idle",
			yolo: this.chrome.getAutonomy?.() === "yolo",
			animate: false,
			now: this.railAnimationTime,
		};
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		this.renderedTopHidden = hiddenLineCount;
		const theme = clioTheme();
		const text = this.getText();
		const mode = composerMode(this.chrome, text);
		const rail = this.railState(mode);
		const status = this.chrome.getHarnessStatus?.(width);
		const spinner = GLYPH.running;
		let lead = "";
		let activity = "";
		if (mode === "CONFIRM") {
			lead = theme.fg("composerRail", attentionCue(this.railAnimationTime, this.chrome.getMotionEnabled?.() ?? true));
			activity = theme.style("decisionCue", "needs approval", { bold: true });
		} else if (mode === "PREPARING" || mode === "COMPACTING") {
			lead = theme.fg("harnessAction", spinner);
			activity = theme.fg("harnessAction", mode === "PREPARING" ? "is preparing" : "is compacting context");
		} else if (status) {
			lead = theme.fg(status.token, status.live ? spinner : status.glyph);
			activity = theme.fg(status.token, status.label);
		} else if (mode !== "MESSAGE") {
			lead = theme.fg("harnessAction", spinner);
			activity = theme.fg("harnessAction", "is working");
		}
		const route = this.chrome.getModelLabel();
		const nickname = modelNickname(typeof route === "string" ? route.split("·").at(-1) : route.modelId);
		const identity = theme.fg(
			"activeModelIdentity",
			truncateToWidth(nickname, Math.max(4, Math.min(24, Math.floor(width / 3))), GLYPH.ellipsis, false),
		);
		const label = [lead, identity, activity].filter(Boolean).join(" ");
		const suffix = [
			hiddenLineCount > 0 ? theme.fg("positionCount", `${GLYPH.up}${hiddenLineCount}`) : "",
			mode === "STEER" || (mode === "FOLLOW-UP" && text.length > 0) ? theme.fg("draftState", mode) : "",
		]
			.filter(Boolean)
			.join(theme.fg("border", " · "));
		return this.topRail(width, theme, rail, label, suffix);
	}

	/** The top rail holds harness activity or the active menu's title. */
	private topRail(width: number, theme: ClioTheme, rail: EditorRailState, label: string, suffix = ""): string {
		const left = rail.yolo ? `${theme.fg("composerRail", "━")} ${theme.style("yoloLabel", "YOLO", { bold: true })}` : "";
		const room = Math.max(0, this.railLabelRoom(width) - (left ? visibleWidth(left) + 1 : 0));
		const labelRoom = Math.max(0, room - visibleWidth(suffix) - (label && suffix ? 3 : 0));
		const right = [truncateToWidth(label, labelRoom, GLYPH.ellipsis, false), suffix]
			.filter(Boolean)
			.join(theme.fg("border", " · "));
		return renderEditorRail(theme, width, { left, leftRaw: true, right, rightRaw: true }, rail);
	}

	/** Thinking and context stay together; permission and menu keys have priority. */
	private bottomRail(width: number, theme: ClioTheme, rail: EditorRailState, right = ""): string {
		const room = this.railLabelRoom(width);
		const fittedRight = truncateToWidth(right, room, GLYPH.ellipsis, false);
		const groupRoom = Math.max(0, room - visibleWidth(fittedRight) - (fittedRight ? 3 : 0));
		const thinking =
			groupRoom > 0
				? truncateToWidth(
						thinkingRailHint(
							theme,
							this.chrome.getThinking?.() ?? { label: this.chrome.getThinkingLabel(), hasLevels: false },
							groupRoom,
						),
						groupRoom,
						GLYPH.ellipsis,
						false,
					)
				: "";
		const context = this.chrome.getContextUsage?.();
		const usage = context
			? contextRailHint(
					context,
					width >= 100 ? 10 : 6,
					Math.max(0, groupRoom - visibleWidth(thinking) - (thinking ? 3 : 0)),
					theme,
				)
			: "";
		const hint = [fittedRight, usage, thinking].filter(Boolean).join(theme.fg("border", " · "));
		return renderEditorRail(theme, width, { right: hint, rightRaw: true }, rail);
	}

	private railLabelRoom(width: number): number {
		// A clear left stretch preserves the composer's shape, even on narrow terminals.
		return Math.max(1, width - Math.min(16, Math.floor(width / 3)) - 3);
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		this.renderedBottomHidden = hiddenLineCount;
		const theme = clioTheme();
		const text = this.getText();
		const mode = composerMode(this.chrome, text);
		const rail = this.railState(mode);
		const scroll = hiddenLineCount > 0 ? `${GLYPH.down}${hiddenLineCount}` : "";
		const room = this.railLabelRoom(width);
		const hint =
			mode === "CONFIRM"
				? confirmRailHint(
						theme,
						Math.max(1, room - (scroll ? visibleWidth(scroll) + 3 : 0)) + 3,
						text.length > 0,
						this.chrome.getPermissionInspection?.() ?? "none",
					)
				: "";
		const right = [scroll ? theme.fg("positionCount", scroll) : "", theme.base("keyboardHint", hint)]
			.filter(Boolean)
			.join(theme.fg("border", " · "));
		this.renderedBottomRail = this.bottomRail(width, theme, rail, right);
		return this.renderedBottomRail;
	}

	/** Commands share the composer rails; permission cards retain the editable draft beneath their body. */
	private renderDock(
		entry: DockEntry,
		width: number,
		theme: ClioTheme,
		rail: EditorRailState,
		composerRows = 0,
	): string[] {
		const gutter = ClioEditor.DOCK_GUTTER;
		const contentWidth = Math.max(1, width - gutter * 2);
		const adaptive = entry.adaptive === true && !entry.keepComposer;
		const bodyRows =
			(adaptive ? dockGrowthRows(this.dockHost) : dockBodyRows(this.dockHost)) -
			(entry.keepComposer ? Math.max(0, composerRows - 1) : 0);
		let rendered = entry.frame.renderDockBody(contentWidth, Math.max(1, bodyRows));
		if (adaptive) {
			// The frame pads to the ceiling; keep only the rows the content used, down to the compact floor.
			let used = rendered.length;
			while (used > 1 && stripTerminalSequences(rendered[used - 1] ?? "").trim() === "") used -= 1;
			rendered = rendered.slice(0, dockAdaptiveRows(this.dockHost, used));
		}
		// The dock pads every body to its full budget so a docked menu keeps its
		// footprint. A card that keeps the composer has the composer's own rows under
		// it, so the padding only leaves blank rows between the card and the rail
		// that carries its keys.
		let bodyEnd = rendered.length;
		if (entry.keepComposer)
			while (bodyEnd > 1 && stripTerminalSequences(rendered[bodyEnd - 1] ?? "").trim() === "") bodyEnd -= 1;
		const body = rendered.slice(0, bodyEnd);
		const pad = " ".repeat(gutter);
		const tone = entry.frame.dockTone();
		const titleText = theme.style(
			entry.keepComposer ? (tone ?? "decisionCue") : (tone ?? "sectionHeading"),
			entry.frame.dockTitle(),
			{
				bold: true,
			},
		);
		const title =
			!entry.keepComposer && entry.frame.dockAwaitingInput?.()
				? `${theme.fg("composerRail", attentionCue(this.railAnimationTime, this.chrome.getMotionEnabled?.() ?? true))} ${titleText}`
				: titleText;
		const labelRoom = this.railLabelRoom(width);
		const top = entry.keepComposer
			? padAnsi(
					`${theme.fg("attentionRail", "┌")}${rule(theme, Math.max(0, width - 2), {
						left: ` ${title}`,
						leftRaw: true,
						fillToken: "attentionRail",
					})}${theme.fg("attentionRail", "┐")}`,
					width,
				)
			: this.topRail(width, theme, rail, title);
		const lines = [
			top,
			...body.map((row) =>
				padAnsi(
					entry.keepComposer
						? `${theme.fg("attentionRail", "│")} ${row} ${theme.fg("attentionRail", "│")}`
						: `${pad}${row}${pad}`,
					width,
				),
			),
		];
		if (entry.keepComposer) return lines;
		const hint = entry.frame.dockHint(labelRoom + 4);
		lines.push(this.bottomRail(width, theme, rail, hint?.trim().length ? hint : ""));
		return lines;
	}

	private renderAutocompleteDock(lines: string[], width: number, theme: ClioTheme): string[] {
		// The border hook identifies the engine's exact row; labels and glyphs are never guessed.
		const border = lines.indexOf(this.renderedBottomRail, 1);
		if (border < 1) return lines;
		// The list opens compact and grows with its rows toward the growth ceiling.
		const ceiling = dockGrowthRows(this.dockHost);
		const input = lines.slice(1, border);
		const cursor = Math.max(
			0,
			input.findIndex((line) => line.includes(REVERSE_VIDEO)),
		);
		const [inputStart, inputEnd] = centeredWindow(input.length, cursor, Math.max(1, ceiling - 2));
		const rows = [this.renderTopBorder(width, this.renderedTopHidden + inputStart)];
		const rowMap = [0];
		for (let index = inputStart; index < inputEnd; index++) {
			rows.push(input[index] ?? "");
			rowMap.push(index + 1);
		}
		rows.push(rule(theme, width));
		rowMap.push(-1);
		this.autocompleteSourceStart = border + 1;
		const suggestions = lines.slice(this.autocompleteSourceStart);
		const last = suggestions.at(-1);
		const hasCount = last !== undefined && /^\s*\(\d+\/\d+\)\s*$/u.test(stripTerminalSequences(last));
		const items = hasCount ? suggestions.slice(0, -1) : suggestions;
		const selectedItem = this.selectedSuggestion();
		const panel = selectedItem ? this.suggestionPanel(selectedItem, width, theme) : [];
		const wanted = rows.length + items.length + (hasCount ? 1 : 0) + panel.length;
		const bodyRows = dockAdaptiveRows(this.dockHost, wanted - 1);
		const room = Math.max(1, bodyRows + 1 - rows.length);
		// A short dock keeps a few list rows and gives the panel what is left.
		const panelRows = Math.min(
			panel.length,
			Math.max(0, room - Math.min(items.length + (hasCount ? 1 : 0), SUGGESTION_MIN_LIST_ROWS)),
		);
		const listRoom = room - panelRows;
		const selected = Math.max(
			0,
			items.findIndex((line) => stripTerminalSequences(line).trimStart().startsWith(`${GLYPH.cursor} `)),
		);
		const [start, end] = centeredWindow(
			items.length,
			selected,
			Math.max(1, listRoom - (hasCount && listRoom > 1 ? 1 : 0)),
		);
		const appendSuggestion = (line: string, sourceRow: number): void => {
			const room = Math.max(1, width - 4);
			// The engine pads each list row to the full width, so only real content past the room earns an ellipsis.
			const overflows = visibleWidth(stripTerminalSequences(line).trimEnd()) > room;
			rows.push(
				padAnsi(
					`  ${truncateToWidth(theme.base("menuOption", line), room, overflows ? GLYPH.ellipsis : "", false)}`,
					width,
				),
			);
			rowMap.push(sourceRow);
		};
		for (let index = start; index < end; index++)
			appendSuggestion(items[index] ?? "", this.autocompleteSourceStart + index);
		if (items.length === 0) appendSuggestion(theme.fg("emptyState", "No suggestions to display"), -1);
		if (hasCount && listRoom > 1 && last !== undefined) appendSuggestion(last, lines.length - 1);
		for (const line of panel.slice(0, panelRows)) {
			rows.push(padAnsi(`  ${line}`, width));
			rowMap.push(-1);
		}
		while (rows.length < bodyRows + 1) {
			rows.push(" ".repeat(width));
			rowMap.push(-1);
		}
		rows.push(this.renderBottomBorder(width, this.renderedBottomHidden + input.length - inputEnd));
		rowMap.push(-1);
		this.autocompleteRowMap = rowMap;
		return rows;
	}

	override handleMouse(event: Parameters<Editor["handleMouse"]>[0]): ReturnType<Editor["handleMouse"]> {
		const rowMap = this.autocompleteRowMap;
		if (rowMap === null) return super.handleMouse(event);
		const sourceRow = rowMap[event.y] ?? -1;
		if (sourceRow < 0) return event.type === "click" ? { handled: true } : undefined;
		const before = this.getText();
		const result = super.handleMouse({
			...event,
			y: sourceRow,
			x: sourceRow >= this.autocompleteSourceStart ? event.x - 2 : event.x,
		});
		if (this.getText() !== before) this.autocompleteDockOpen = super.isShowingAutocomplete();
		return result;
	}

	override isShowingAutocomplete(): boolean {
		return this.autocompleteDockOpen || super.isShowingAutocomplete();
	}

	/** The composer surface includes its rails in yolo, including docked menus and blank padding. */
	private paintComposerBody(
		lines: string[],
		width: number,
		bodyEnd = lines.length - 1,
		baseRole: "inputText" | "menuOption" = "inputText",
	): string[] {
		const theme = clioTheme();
		const key = `${theme.context.mode}:${baseRole}:${width}`;
		let paint = this.surfacePainters.get(key);
		if (paint === undefined) {
			if (this.surfacePainters.size >= 4) this.surfacePainters.clear();
			paint = createComposerSurfacePainter(theme, width, baseRole);
			this.surfacePainters.set(key, paint);
		}
		const paintRails = projectsYolo(theme.context);
		return lines.map((line, index) => (paintRails || (index > 0 && index < bodyEnd) ? paint(line) : line));
	}

	override render(width: number): string[] {
		return withThemeContext(
			{ surface: "composer", mode: this.chrome.getAutonomy?.() === "yolo" ? "yolo" : "normal" },
			() => this.renderSurface(width),
		);
	}

	private renderSurface(width: number): string[] {
		this.autocompleteRowMap = null;
		this.autocompleteSourceStart = Number.POSITIVE_INFINITY;
		this.setAutocompleteMaxVisible(ClioEditor.suggestionListRows(this.dockHost));
		const theme = clioTheme();
		const safeWidth = Math.max(0, width);
		const text = this.getText();
		const mode = composerMode(this.chrome, text);
		const docked = dockTop(this.dockHost);
		this.railAnimationTime = this.chrome.getAnimationTime?.() ?? performance.now();
		if (docked !== null && !docked.keepComposer) {
			this.autocompleteDockOpen = false;
			const rail: EditorRailState = {
				phase: docked.frame.dockAwaitingInput?.() === true ? "attention" : "idle",
				yolo: this.chrome.getAutonomy?.() === "yolo",
				animate: false,
				now: this.railAnimationTime,
			};
			const lines = this.renderDock(docked, safeWidth, theme, rail);
			this.autocompleteRowMap = lines.map(() => -1);
			return this.paintComposerBody(lines, safeWidth, lines.length - 1, "menuOption");
		}
		const lines = super.render(width);
		if (lines.length === 0) return lines;

		if (text.length === 0 && lines[1]) {
			lines[1] = renderEmptyPrompt(lines[1], safeWidth, theme, emptyPromptFor(mode));
		}

		if (docked !== null) {
			const border = lines.indexOf(this.renderedBottomRail, 1);
			if (border < 1) return lines;
			const input = lines.slice(1, border);
			const cursor = Math.max(
				0,
				input.findIndex((line) => line.includes(REVERSE_VIDEO)),
			);
			const [start, end] = centeredWindow(input.length, cursor, Math.max(1, dockBodyRows(this.dockHost) - 3));
			const composer = [
				this.renderTopBorder(safeWidth, this.renderedTopHidden + start),
				...input.slice(start, end),
				this.renderBottomBorder(safeWidth, this.renderedBottomHidden + input.length - end),
			];
			const body = this.renderDock(docked, safeWidth, theme, this.railState(mode), composer.length);
			this.autocompleteSourceStart = Number.POSITIVE_INFINITY;
			this.autocompleteRowMap = [
				...body.map(() => -1),
				0,
				...input.slice(start, end).map((_, index) => start + index + 1),
				border,
			];
			return [
				...this.paintComposerBody(body, safeWidth, body.length, "menuOption"),
				...this.paintComposerBody(composer, safeWidth),
			];
		}
		if (super.isShowingAutocomplete()) this.autocompleteDockOpen = true;
		if (text.length === 0) this.autocompleteDockOpen = false;
		const rendered = this.autocompleteDockOpen ? this.renderAutocompleteDock(lines, safeWidth, theme) : lines;
		return this.paintComposerBody(rendered, safeWidth);
	}

	/**
	 * Preserve paste provenance for every immediate-send binding, including the
	 * alternate paths that invoke the submit controller without an Editor Enter.
	 */
	getTextForSubmit(): string {
		const text = this.getExpandedText();
		return this.startsWithLiteralOperator() ? guardPastedEditorOperator(text) : text;
	}

	private startsWithLiteralOperator(): boolean {
		const visible = this.getText();
		return (
			startsWithPastedOperator(visible, this.pastedBangOffsets) ||
			[...this.pastedOperatorTokens].some((token) => visible.trimStart().startsWith(token))
		);
	}

	/** Paste is always literal; a later deliberate key submits it. */
	override handleInput(data: string): void {
		this.revision += 1;
		const openedPaste = data.includes("\x1b[200~");
		const closedPaste = data.includes("\x1b[201~");
		const pasteMutation = this.bracketedPasteActive || openedPaste;
		const textBeforeInput = this.getText();
		const keybindings = getKeybindings();
		const closesSuggestions =
			keybindings.matches(data, "tui.select.cancel") ||
			keybindings.matches(data, "tui.input.tab") ||
			keybindings.matches(data, "tui.select.confirm");
		if (closesSuggestions) this.autocompleteDockOpen = false;
		// Pi expands and trims the buffer immediately before onSubmit. Envelope a
		// pasted bang draft for that synchronous handoff so the Bash parser can
		// distinguish it from a typed operator; the submit controller unwraps it
		// before sending the literal prompt onward.
		if (this.startsWithLiteralOperator() && keybindings.matches(data, "tui.input.submit")) {
			const pastedText = this.getTextForSubmit();
			this.pastedBangOffsets.clear();
			this.bracketedPasteActive = false;
			super.setText(pastedText);
			super.handleInput(data);
			return;
		}
		const completingDirectory =
			this.isShowingAutocomplete() &&
			(keybindings.matches(data, "tui.input.tab") || keybindings.matches(data, "tui.select.confirm"));
		const textBeforeCompletion = completingDirectory ? this.getText() : "";
		// Enter on a slash suggestion only completes it. Pi's Enter also submits when the completed
		// token begins with "/", which would run `/export /tmp/x` from a path row before the operator
		// confirmed it, so the row is accepted through the Tab route and the line waits for Enter.
		const completesSlashRow =
			completingDirectory &&
			keybindings.matches(data, "tui.select.confirm") &&
			this.getText().trimStart().startsWith("/") &&
			this.selectedSuggestion() !== null;
		super.handleInput(completesSlashRow ? "\t" : data);
		if (completingDirectory && this.getText() !== textBeforeCompletion) {
			if (cursorEndsDirectoryPath(this)) {
				// Directory rows are submenus on the same provider. Re-open immediately
				// after acceptance so ↑/↓ continues in the child tree without requiring
				// a second Tab. Pi's provider request remains the only completion path.
				super.handleInput("\t");
			} else if (cursorAwaitsSlashArgument(this)) {
				this.reopenSuggestions();
			}
		} else if (data === " " && !pasteMutation && !super.isShowingAutocomplete() && cursorAwaitsSlashArgument(this)) {
			// A space after a command or subcommand asks what comes next.
			this.reopenSuggestions();
		}
		const textAfterInput = this.getText();
		this.pastedBangOffsets = remapPastedBangOffsets(
			textBeforeInput,
			textAfterInput,
			this.pastedBangOffsets,
			pasteMutation,
		);
		if (openedPaste) this.bracketedPasteActive = true;
		if (closedPaste) this.bracketedPasteActive = false;
		if (pasteMutation && textAfterInput !== this.getExpandedText()) {
			// A large paste is represented by an opaque visible token. Remember the
			// inserted token through edits and undo, without depending on its format.
			let start = 0;
			while (
				start < textBeforeInput.length &&
				start < textAfterInput.length &&
				textBeforeInput[start] === textAfterInput[start]
			)
				start++;
			let oldEnd = textBeforeInput.length,
				end = textAfterInput.length;
			while (oldEnd > start && end > start && textBeforeInput[oldEnd - 1] === textAfterInput[end - 1]) {
				oldEnd--;
				end--;
			}
			const token = textAfterInput.slice(start, end).trimStart();
			if (token && !token.startsWith("!")) this.pastedOperatorTokens.add(token);
		}
	}

	override setText(text: string): void {
		this.revision += 1;
		this.autocompleteDockOpen = false;
		this.pastedOperatorTokens.clear();
		this.pastedBangOffsets.clear();
		this.bracketedPasteActive = false;
		super.setText(text);
	}
}
