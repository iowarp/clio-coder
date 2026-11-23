import type { OutputStyle } from "../core/defaults.js";
import { tierPolicy } from "../core/presentation-tier.js";
import {
	Editor,
	getKeybindings,
	renderFakeCursor,
	stripTerminalSequences,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../engine/tui.js";
import type { TurnPreparationPhase } from "../session-control/turn-state.js";
import { type DockEntry, decisionRows, dockAdaptiveRows, dockBodyRows, dockGrowthRows, dockTop } from "./dock.js";
import { guardPastedEditorOperator } from "./editor-bash.js";
import { type EditorRailState, renderEditorRail } from "./editor-rails.js";
import { steerDraftToken } from "./editor-steer.js";
import { type ContextOccupancyFacts, contextRailGroup, contextRailUnit } from "./footer/context-rail.js";
import { centeredWindow, fitHintEntries } from "./overlay-frame.js";
import { type PermissionInspectionHint, type PermissionTermsHint, permissionHintEntries } from "./permission-hint.js";
import type { SlashCompletionItem } from "./slash-autocomplete.js";
import type { ClioTheme, ClioToken } from "./theme/index.js";
import {
	activityCue,
	clioTheme,
	editorTheme,
	GLYPH,
	padAnsi,
	projectsYolo,
	rule,
	withThemeContext,
} from "./theme/index.js";
import { modelNickname, statusRailLabelRoom, type TargetIdentity } from "./theme/labels.js";
import { skinEpoch } from "./theme/tokens.js";
import { createComposerSurfacePainter } from "./theme/yolo-surface.js";

/**
 * The slice of Pi's Editor the suggestion list needs and keeps private. Pi
 * requests suggestions asynchronously and leaves the previous list in place
 * until the new one lands, so Clio reads the list to tell whether it still
 * describes the line.
 */
interface SuggestionEngine {
	autocompleteList?: { getSelectedItem(): unknown };
	autocompleteState: unknown;
	updateAutocomplete?(): void;
	tryTriggerAutocomplete?(): void;
	cancelAutocomplete?(): void;
}

/**
 * Pi's edits that remove text without asking the suggestion list to follow.
 * Insertion, Backspace and Delete already refresh it.
 */
const KILL_ACTIONS = [
	"tui.editor.deleteToLineStart",
	"tui.editor.deleteToLineEnd",
	"tui.editor.deleteWordBackward",
	"tui.editor.deleteWordForward",
] as const;

// Since Pi 1.4 (4f2422c16) the Editor draws its cursor cell between zero-width
// markers the TUI resolves to reverse video only when it paints, so the composer
// finds the cursor by those markers rather than by an SGR sequence.
const FAKE_CURSOR_BLANK = renderFakeCursor(" ");
const FAKE_CURSOR_START = FAKE_CURSOR_BLANK.slice(0, FAKE_CURSOR_BLANK.indexOf(" "));
const EMPTY_PROMPT = `Ask CLIO Coder${GLYPH.ellipsis}  / for commands`;
const CONFIRM_PROMPT = "A parked call is waiting for your decision";
const PREPARING_PROMPT = "CLIO Coder has your prompt and is preparing the turn";
const COMPACTING_PROMPT = "CLIO Coder is compacting the session context";
/** Rows the suggestion detail panel may take: the breadcrumb and one description line. */
const SUGGESTION_PANEL_ROWS = 2;
/** Most list rows the suggestion popup shows at once; the count row pages the rest. */
const SUGGESTION_MAX_LIST_ROWS = 8;
/** Fewest list rows kept visible when the panel has to share a short dock. */
const SUGGESTION_MIN_LIST_ROWS = 3;

export interface EditorChrome {
	/** Raw route fields from presentation; startup/legacy labels remain opaque strings. */
	getModelLabel: () => TargetIdentity | string;
	/** Effective label plus whether the model actually has an effort range. */
	getThinkingLabel: () => string;
	/** The board's active task for the rail, fitted to `room`; null when no task is active. */
	getTaskRail?: (room: number) => string | null;
	/** Session-scoped loop status from the cached job feed, fitted to the composer rail. */
	getLoopRail?: (width: number) => string | null;
	getThinking?: () => {
		label: string;
		hasLevels: boolean;
		supportedLevels?: readonly string[];
		note?: string;
		/** The rail has nothing worth a permanent slot to say about this route right now. */
		quiet?: boolean;
	};
	getHarnessStatus?: (
		width: number,
		/** Cells the rail has already given to what sits beside the state. */
		reserved?: number,
	) => {
		label: string;
		glyph: string;
		token: ClioToken;
		live: boolean;
		subject?: string;
		/** Whether the subject kept its place in front of the label; absent means the rail decides by room. */
		subjectShown?: boolean;
		detail?: string;
		namesRoute?: boolean;
	} | null;
	/**
	 * The live run's short state for a focused surface's top rule: cue, state and elapsed, then the actor (units 3 and 4
	 * of the overlay rule). `room` bounds the quoted object of the fullest form. Null when nothing runs.
	 */
	getBesideCard?: (room: number) => OverlayRunState | null;
	/** An active extension workspace's rail segment, painted in place of the model nickname. */
	getWorkspaceRail?: (width: number) => string | null;
	/** Published context accounting; rendering never refreshes the estimate. */
	getContextUsage?: () => ContextOccupancyFacts | undefined;
	getOutputStyle?: () => OutputStyle;
	/** Effective session autonomy, including live overrides. */
	getAutonomy?: () => string;
	/** The operator's yolo confinement; the rail marks unconfined yolo. */
	getYoloConfinement?: () => string;
	/** Monotonic animation clock, injectable for deterministic rendering tests. */
	getAnimationTime?: () => number;
	/** Optional motion override; terminal accessibility preferences always apply. */
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
	getPermissionTerms?: () => PermissionTermsHint;
	/**
	 * Where a consumed prompt is between the editor and the stream. The editor
	 * is cleared before admission, so without this the composer went straight
	 * back to `MESSAGE` and a 77-second pre-submit compaction was
	 * indistinguishable from a dropped Enter (issue #251).
	 */
	getTurnPreparation?: () => TurnPreparationPhase;
	/** How long the prompt has been held and the step taking the time, once either is worth a word. */
	getPreparationDetail?: () => string | null;
	/** A running compaction's stage, clock and way out, fitted to the room given; null when nothing reports. */
	getCompactionLabel?: (room: number) => string | null;
	/** Whether the current draft will actually steer Clio or live dispatch work on Enter. */
	willEnterSteer?: (text: string) => boolean;
	/** The draft is a command or a shell line, which Enter never queues for the run. */
	getDraftOperator?: (text: string) => "command" | "shell" | null;
	/** The worker a draft's `@target` resolves to, by agent name, and whether it still waits for a slot; null when none. */
	getSteerRecipient?: (token: string) => { agentId: string; queued: boolean } | null;
	/** Resolved submit binding, formatted for display. */
	getSubmitKeyLabel?: () => string;
	/** Resolved multiline binding, formatted for display. */
	getNewlineKeyLabel?: () => string;
}

type ComposerMode = "MESSAGE" | "FOLLOW-UP" | "STEER" | "CONFIRM" | "PREPARING" | "COMPACTING";

/** The run's state as an overlay rule shows it right of the title, after the surface's own pending state. */
export interface OverlayRunState {
	/** The state words and elapsed after the cue, fullest first: `running `pytest -q` · 13s`, then `running · 13s`. */
	forms: readonly string[];
	/** Work that is moving takes the animated cue; anything else holds `glyph` still. */
	live: boolean;
	glyph: string;
	token: ClioToken;
	/** Who the state belongs to, when the words do not already say it (`GPT-6-luna`); null for a worker count. */
	actor: string | null;
}

/** One unit of an overlay rule's right end: plain text for fitting, painted when drawn. */
interface RuleUnit {
	text: string;
	paint: (text: string) => string;
}

/**
 * Cells an overlay rule spends around its labels: `━ ` and a space around the title, at least one cell of fill, and a
 * space and `━` on each side of the right units. Without right units the title keeps `━ `, its space and one fill cell.
 */
const OVERLAY_RULE_CHROME = 7;
/** Draft rows a decision card leaves visible under itself. */
const APPROVAL_DRAFT_ROWS = 2;
const OVERLAY_RULE_BARE = 4;

/**
 * The shell unit that leads the bottom rail while the draft is a shell line, fullest first. The distinguishing word
 * comes first, so every shorter form keeps it.
 */
const SHELL_RAIL_FORMS: Readonly<Record<"shared" | "private", readonly string[]>> = {
	shared: [
		`$ shared shell ${GLYPH.sep} Enter runs ${GLYPH.sep} CLIO Coder sees the output`,
		`$ shared shell ${GLYPH.sep} Enter runs`,
		`$ shared ${GLYPH.sep} Enter runs`,
		"$ shared",
	],
	private: [
		`$ private shell ${GLYPH.sep} Enter runs ${GLYPH.sep} output stays with you`,
		`$ private shell ${GLYPH.sep} Enter runs`,
		`$ private ${GLYPH.sep} Enter runs`,
		"$ private",
	],
};

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
 * The status rail with its `Esc stops` clause made true for the next press.
 * While a suggestion list is open, Esc closes the list and the run goes on; while
 * the draft is a worker steer, Esc backs out of the steer, which the hint row
 * names. The rail used to promise a stop the key would not make.
 */
type HarnessRailStatus = ReturnType<NonNullable<EditorChrome["getHarnessStatus"]>>;

function escapeTakenBy(
	status: HarnessRailStatus | undefined,
	owner: "list" | "steer" | null,
): HarnessRailStatus | undefined {
	if (status == null || owner === null || !status.label.includes("Esc stops")) return status;
	const label =
		owner === "list"
			? status.label.replace("Esc stops", "Esc closes list")
			: status.label.replace(/ · Esc stops|Esc stops · |Esc stops/u, "");
	return { ...status, label };
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
	terms: PermissionTermsHint = "closed",
): string {
	// The terms state rides along so an open terms view reads `[Esc] hide terms` here too, never `deny`.
	return theme.fg(
		"decisionKey",
		fitHintEntries(permissionHintEntries(hasDraft, inspection, terms), Math.max(1, width - 3)),
	);
}

/** Under this the current task's title is a stub, and the rail says nothing rather than half a name. */
const TASK_RAIL_MIN_ROOM = 20;

/** The line the empty composer shows for the mode it is in. */
function emptyPromptFor(mode: ComposerMode): string {
	if (mode === "CONFIRM") return CONFIRM_PROMPT;
	if (mode === "PREPARING") return PREPARING_PROMPT;
	if (mode === "COMPACTING") return COMPACTING_PROMPT;
	return EMPTY_PROMPT;
}

function renderEmptyPrompt(line: string, width: number, theme: ClioTheme, text = EMPTY_PROMPT): string {
	const cursorAt = line.indexOf(FAKE_CURSOR_BLANK);
	if (cursorAt < 0) return line;
	const afterCursorAt = cursorAt + FAKE_CURSOR_BLANK.length;
	const available = Math.max(0, width - 1);
	const invitation =
		text === EMPTY_PROMPT
			? `${theme.fg("inputPlaceholder", `Ask CLIO Coder${GLYPH.ellipsis}  `)}${theme.fg("commandHint", "/ for commands")}`
			: theme.fg("inputPlaceholder", text);
	const prompt = truncateToWidth(invitation, available, GLYPH.ellipsis, false);
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
	private renderedSkinEpoch = skinEpoch();
	private readonly surfacePainters = new Map<string, (line: string) => string>();
	private renderedBottomRail = "";
	private renderedTopHidden = 0;
	private renderedBottomHidden = 0;
	private autocompleteDockOpen = false;
	private autocompleteRowMap: number[] | null = null;
	private autocompleteSourceStart = 0;
	/** The line a suggestion list was built for, stamped when the list first shows. */
	private suggestionStamp: { list: unknown; text: string; line: number; col: number } | null = null;
	/**
	 * Whether the open list has a selected row. A list that opened by itself for
	 * an argument nobody must give starts unarmed, so Enter cannot insert
	 * `/context compact` or `/doctor deep` that the operator never chose (E-08). A list of
	 * commands found only by their descriptions starts unarmed too, so an unknown `/tools`
	 * is sent as typed and named as unknown instead of becoming `/skill`.
	 */
	private suggestionArmed = true;
	/** The next list to show was asked for by an auto-open site, not by a key the operator aimed at the list. */
	private autoOpenPending = false;
	/** The list `suggestionArmed` was decided for; a new list from a later key is armed. */
	private armingList: unknown = null;
	private pastedOperatorTokens = new Set<string>();
	/**
	 * The text is untouched since it came back from the queue. The next key is the
	 * one that can run it together with a command: `/settings` then `/usage` once
	 * reached the model as `/settings/usage`.
	 */
	private restoredDraft = false;
	/** A restored draft set aside for the command being typed; it returns when the composer empties. */
	private parkedDraft: string | null = null;
	/**
	 * The run the board addressed this draft to. The address stays out of the
	 * text because a run id is nothing the operator typed or can read; the rail
	 * names the worker and the address goes back on the line at submit.
	 */
	private boardSteer: { runId: string; agentId: string } | null = null;
	/** The address on the line just submitted, so a refused steer comes back with its address still hidden. */
	private sentSteer: { runId: string; agentId: string } | null = null;

	get draftRevision(): number {
		return this.revision;
	}

	/** Restored queues and external buffers are literal editor content. */
	setLiteralText(text: string): void {
		this.setText(text);
		this.pastedBangOffsets = new Set([...text.matchAll(/!/gu)].map((match) => match.index));
	}

	setRestoredText(text: string): void {
		this.setLiteralText(text);
		this.restoredDraft = text.length > 0;
	}

	/** Everything typed and not sent, including a draft set aside for a command. */
	unsentDraft(): string {
		return [this.parkedDraft ?? "", this.getExpandedText()].filter((part) => part.trim().length > 0).join("\n\n");
	}

	private cursorAtEnd(): boolean {
		const lines = this.getLines();
		const cursor = this.getCursor();
		return cursor.line === lines.length - 1 && cursor.col === (lines[cursor.line] ?? "").length;
	}

	/** Remember which run the board addressed this draft to. */
	markSteerTarget(run: { runId: string; agentId: string }): void {
		this.boardSteer = run;
	}

	/** Who this draft goes to if it steers a worker, and whether that worker is still running. */
	steerTarget(text = this.getText()): { agentId: string; live: boolean; queued: boolean } | null {
		if (this.boardSteer !== null) {
			// A slash command or shell line runs as itself, so it never reads as addressed.
			if (this.chrome.getDraftOperator?.(text)) return null;
			const recipient = this.chrome.getSteerRecipient?.(this.boardSteer.runId) ?? null;
			return { agentId: this.boardSteer.agentId, live: recipient !== null, queued: recipient?.queued === true };
		}
		const token = steerDraftToken(text);
		if (token === null) return null;
		const recipient = this.chrome.getSteerRecipient?.(token) ?? null;
		return recipient !== null ? { agentId: recipient.agentId, live: true, queued: recipient.queued } : null;
	}

	/** The line a submit hands on: a board-addressed draft gets its address back, and anything else passes untouched. */
	addressSubmission(text: string): string {
		const run = this.boardSteer;
		if (run === null || this.steerTarget(text) === null) return text;
		this.boardSteer = null;
		this.sentSteer = run;
		return `@${run.runId} ${text}`;
	}

	/** The worker a just-submitted line was addressed to from the board, when `target` is that address. */
	sentSteerAgent(target: string): string | null {
		return this.sentSteer?.runId === target ? this.sentSteer.agentId : null;
	}

	/**
	 * Take the worker address off the draft and keep whatever was typed, so
	 * backing out of a steer costs no text. Returns the worker it was addressed
	 * to, or null when the draft was not steering anyone.
	 */
	dropSteerTarget(): string | null {
		const text = this.getText();
		const target = this.steerTarget(text);
		if (target === null) return null;
		if (this.boardSteer !== null) {
			this.boardSteer = null;
			this.revision += 1;
			return target.agentId;
		}
		this.setText(text.trimStart().replace(/^@\S+\s*/u, ""));
		return target.agentId;
	}

	/** Rail words for a draft that is not what the composer would normally hold, or empty. */
	private draftNote(width: number): string {
		if (this.parkedDraft !== null) return width >= 80 ? "DRAFT KEPT · back after this command" : "DRAFT KEPT";
		// Enter queues during a run, and the STEER beside this note already says so.
		if (this.restoredDraft) {
			if (width < 80) return "RESTORED";
			return this.chrome.isStreaming?.() === true
				? "RESTORED · / keeps it aside"
				: "RESTORED · Enter sends · / keeps it aside";
		}
		return "";
	}

	override applyEdit(operation: Parameters<Editor["applyEdit"]>[0]): void {
		const before = this.getText();
		this.suggestionsAreStale();
		super.applyEdit(operation);
		if (operation !== "undo" && operation !== "deleteCharBackward" && operation !== "deleteCharForward") {
			this.followSuggestionsAfterKill(before);
		}
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

	/** Rows the suggestion list may show: the dock's growth ceiling less the input, rule and detail panel, at most eight. */
	private static suggestionListRows(tui: TUI): number {
		return Math.min(SUGGESTION_MAX_LIST_ROWS, Math.max(3, dockGrowthRows(tui) - 3 - SUGGESTION_PANEL_ROWS));
	}

	/** The row the list has selected. The engine keeps its list private and the dock already reads its rendered rows. */
	private selectedSuggestion(): SlashCompletionItem | null {
		if (!this.syncSuggestionArming()) return null;
		const list = (this as unknown as { autocompleteList?: { getSelectedItem(): unknown } }).autocompleteList;
		const item = list?.getSelectedItem() as SlashCompletionItem | null | undefined;
		return item?.path ? item : null;
	}

	private suggestionEngine(): SuggestionEngine {
		return this as unknown as SuggestionEngine;
	}

	/**
	 * Whether the open list was built for a line that has since changed. The
	 * list is replaced only when the provider answers, which is after the input
	 * that changed the line. Enter or Tab in that window would apply a row
	 * against the old token range: `/context refresh` typed in one burst became
	 * `/context compact refresh`. Every entry point calls this before it edits,
	 * so a list that appeared since the last call was built for the current line.
	 */
	private suggestionsAreStale(): boolean {
		const engine = this.suggestionEngine();
		const list = engine.autocompleteList;
		if (list === undefined || engine.autocompleteState === null) {
			this.suggestionStamp = null;
			return false;
		}
		const { line, col } = this.getCursor();
		const text = this.getText();
		const stamp = this.suggestionStamp;
		if (stamp === null || stamp.list !== list) {
			this.suggestionStamp = { list, text, line, col };
			return false;
		}
		return stamp.text !== text || stamp.line !== line || stamp.col !== col;
	}

	/**
	 * A kill leaves the open list describing text that is gone: Ctrl+U on
	 * `/context ` emptied the line under a palette that stayed up. Ask the
	 * provider again so the list closes or narrows with the line.
	 */
	private followSuggestionsAfterKill(textBefore: string): void {
		if (this.getText() === textBefore) return;
		const engine = this.suggestionEngine();
		if (engine.autocompleteState !== null) engine.updateAutocomplete?.();
	}

	/** Decide arming once per list, and report whether the open list has a selected row. */
	private syncSuggestionArming(): boolean {
		const engine = this.suggestionEngine();
		const list = engine.autocompleteList;
		if (list === undefined || engine.autocompleteState === null) return true;
		if (list !== this.armingList) {
			this.armingList = list;
			const items = (list as { items?: ReadonlyArray<SlashCompletionItem> }).items ?? [];
			const unchosen =
				items.length > 0 &&
				(items.every((item) => item.describedOnly === true || item.lettersOnly === true) ||
					(this.autoOpenPending && items.every((item) => item.required === false)));
			this.suggestionArmed = !unchosen;
			this.autoOpenPending = false;
		}
		return this.suggestionArmed;
	}

	/** Ask the provider for the next argument without the forced Tab path, which auto-applies a lone row. */
	private reopenSuggestions(autoOpen = false): void {
		this.autoOpenPending = autoOpen;
		const request = (this as unknown as { tryTriggerAutocomplete?: () => void }).tryTriggerAutocomplete;
		request?.call(this);
	}

	/** Breadcrumb, effect and next action for the selected suggestion, drawn under the list. */
	private suggestionPanel(item: SlashCompletionItem, width: number, theme: ClioTheme): string[] {
		const gutter = `${theme.fg("border", GLYPH.rail)} `;
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
		// A sentence that outgrows the rows under the breadcrumb ends in an ellipsis rather than a silent cut.
		const bodyRows = SUGGESTION_PANEL_ROWS - 1;
		const wrapClamped = (text: string, paint: (line: string) => string): string[] => {
			const wrapped = wrapTextWithAnsi(text, room);
			const shown = wrapped.slice(0, bodyRows);
			if (wrapped.length > bodyRows)
				shown[bodyRows - 1] = truncateToWidth(
					`${shown[bodyRows - 1] ?? ""} ${wrapped[bodyRows] ?? ""}`,
					room,
					GLYPH.ellipsis,
					false,
				);
			return shown.map((line) => `${gutter}${paint(line)}`);
		};
		const effect = item.effectDescription ?? item.description ?? "";
		const effectRows = effect ? wrapClamped(effect, (line) => theme.base("menuOption", line)) : [];
		const nextRows = item.nextAction ? wrapClamped(item.nextAction, (line) => theme.fg("keyboardHint", line)) : [];
		// A refused row's reason is why Enter did nothing, so a short panel keeps it over the description.
		rows.push(...(item.disabledReason ? [...nextRows, ...effectRows] : [...effectRows, ...nextRows]));
		const shown = rows.slice(0, SUGGESTION_PANEL_ROWS);
		// The usage example belongs to the full detail pane, so it joins the detail rows only at detailed, and only
		// when it says more than the breadcrumb.
		if (item.usage && tierPolicy().pickerDetail === "pane" && item.usage !== parts.join(" ")) {
			const usage = `${theme.fg("annotation", "usage ")}${theme.fg("commandHint", item.usage)}`;
			shown.push(`${gutter}${truncateToWidth(usage, room, GLYPH.ellipsis, false)}`);
		}
		return shown;
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
			...(mode === "CONFIRM" ? { tone: "attentionRail" as const } : {}),
		};
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		this.renderedTopHidden = hiddenLineCount;
		const theme = clioTheme();
		const text = this.getText();
		const mode = composerMode(this.chrome, text);
		const rail = this.railState(mode);
		const steer = this.steerTarget(text);
		// A shell draft says so on the bottom rail, so the top rail keeps the run's state, wait cause and Esc.
		const draftLabel = steer
			? theme.style(
					steer.live && !steer.queued ? "draftState" : "warning",
					!steer.live
						? `${steer.agentId} ended`
						: steer.queued
							? `${steer.agentId} is queued`
							: `STEER ${GLYPH.next} ${steer.agentId}`,
					{
						bold: true,
					},
				)
			: mode === "STEER"
				? theme.fg("draftState", mode)
				: mode === "FOLLOW-UP" && this.chrome.getDraftOperator?.(text) === "command"
					? theme.fg("draftState", "COMMAND")
					: "";
		const join = (parts: readonly string[]): string =>
			parts.filter(Boolean).join(theme.fg("separator", ` ${GLYPH.dot} `));
		const note = this.draftNote(width);
		const position = hiddenLineCount > 0 ? theme.fg("positionCount", `${GLYPH.up}${hiddenLineCount}`) : "";
		let suffix = join([position, draftLabel, note ? theme.fg("draftState", note) : ""]);
		const yoloCols = rail.yolo ? 7 : 0;
		const suffixCols = visibleWidth(suffix) + (suffix ? 3 : 0);
		const reserved = yoloCols + suffixCols;
		const status = escapeTakenBy(
			this.chrome.getHarnessStatus?.(width, reserved),
			this.isShowingAutocomplete() ? "list" : mode !== "CONFIRM" && this.steerTarget(text) !== null ? "steer" : null,
		);
		const spinner = activityCue(this.railAnimationTime, this.chrome.getMotionEnabled?.() ?? true);
		let lead = "";
		let activity = "";
		// The state when no name stands in front of it to read `is writing` with.
		let stateAlone = "";
		if (mode === "CONFIRM") {
			// The operator owns this wait, so the mark holds still: motion is for work that is moving.
			lead = theme.fg("attentionRail", GLYPH.phaseBlocked);
			activity = theme.style("decisionCue", "needs approval", { bold: true });
			stateAlone = activity;
		} else if (mode === "COMPACTING") {
			lead = theme.fg("harnessAction", spinner);
			// The stage, its clock and Esc are the claim here, so they get the room before the name does (J2-F04).
			// The status rail's own room: the composer-shaped stretch cost a 40-column compaction its Esc (R5).
			const room = statusRailLabelRoom(width) - reserved - 2;
			const named = this.chrome.getCompactionLabel?.(room - Math.max(4, Math.min(24, Math.floor(width / 3))) - 1) ?? null;
			const alone = this.chrome.getCompactionLabel?.(room) ?? null;
			// The name is the first thing to go: a rail that cannot hold it beside the clock and Esc drops it, not them.
			const facts = (label: string | null): number => (label ?? "").split(" · ").length;
			const keepsName = named !== null && facts(named) >= facts(alone);
			activity = theme.fg("harnessAction", (keepsName ? named : alone) ?? "is compacting context");
			stateAlone = theme.fg("harnessAction", (alone ?? "compacting context").replace(/^is /u, ""));
		} else if (mode === "PREPARING") {
			lead = theme.fg("harnessAction", spinner);
			const preparing = this.chrome.getPreparationDetail?.() ?? null;
			const beside = preparing === null ? "" : ` · ${preparing}`;
			activity = theme.fg("harnessAction", `is preparing${beside}`);
			stateAlone = theme.fg("harnessAction", `preparing${beside}`);
		} else if (status) {
			lead = theme.fg(status.token, status.live ? spinner : status.glyph);
			activity = theme.fg(status.token, status.label);
			stateAlone = theme.fg(status.token, status.label.replace(/^(?:is|has|was) /u, ""));
		} else if (mode !== "MESSAGE") {
			lead = theme.fg("harnessAction", spinner);
			activity = theme.fg("harnessAction", "is working");
			stateAlone = theme.fg("harnessAction", "working");
		}
		const statusRail = mode !== "CONFIRM" && mode !== "PREPARING" && mode !== "COMPACTING" && status != null;
		const route = this.chrome.getModelLabel();
		const nickname = modelNickname(typeof route === "string" ? route.split("·").at(-1) : route.modelId);
		// The approval cue keeps the rail; a workspace replaces only the identity segment.
		const workspace =
			mode === "CONFIRM" ? null : (this.chrome.getWorkspaceRail?.(Math.max(4, Math.floor(width / 2))) ?? null);
		// A rail stating who else is acting names them, not the model, which is idle meanwhile.
		const actor = mode === "CONFIRM" ? undefined : status?.subject;
		const nameCap = Math.max(4, Math.min(24, Math.floor(width / 3)));
		const labelRoom = statusRail || mode === "COMPACTING" ? statusRailLabelRoom(width) : this.railLabelRoom(width);
		const netRoom = labelRoom - reserved;
		const separator = theme.fg("separator", ` ${GLYPH.dot} `);
		const facts = statusRail ? (status.detail?.split(" · ") ?? []).map((fact) => theme.fg("annotation", fact)) : [];
		const quietState = status?.live === false && status.glyph === GLYPH.queued;
		const phrased = (state: string): string => [state, ...facts].filter(Boolean).join(separator);
		const named = (who: string, state = activity): string =>
			[lead, who && theme.fg("activeModelIdentity", who), phrased(state)].filter(Boolean).join(" ");
		const pickLabel = (): string => {
			const who = actor ?? nickname;
			if (!statusRail) {
				const whole =
					actor === undefined && workspace !== null
						? [lead, workspace, activity].filter(Boolean).join(" ")
						: who.length > 0 && visibleWidth(who) <= nameCap
							? named(who)
							: `${lead} ${stateAlone}`;
				// The name is whole or absent: `Judge-mod…` named nothing and cost the state its room (R1).
				return !activity || visibleWidth(whole) <= netRoom ? whole : `${lead} ${stateAlone}`;
			}
			// The fitter already weighed the subject against the state, its clock and the way out; it is the one name the
			// session gives this actor, so it never alternates with a longer spelling of the route (R6).
			const shown = status.subjectShown ?? visibleWidth(who) <= nameCap;
			if (actor === undefined && workspace !== null && shown && visibleWidth(workspace) <= visibleWidth(who)) {
				const withWorkspace = [lead, workspace, phrased(activity)].join(" ");
				if (visibleWidth(withWorkspace) <= netRoom) return withWorkspace;
			}
			// Work beside the state rewords itself every few seconds; its facts leave whole from their end, and a quiet state
			// yields to the work it would crowd off the rail.
			const shorter = facts.map((_, index) => facts.slice(0, facts.length - index));
			const withSubject = (parts: readonly string[]): string =>
				[lead, theme.fg("activeModelIdentity", who), [activity, ...parts].join(separator)].join(" ");
			const subjectLed = shown ? [...shorter.map(withSubject), withSubject([])] : [];
			const candidates = [
				...subjectLed,
				...shorter.map((parts) => `${lead} ${[stateAlone, ...parts].join(separator)}`),
				...(quietState ? shorter.map((parts) => `${lead} ${parts.join(separator)}`) : []),
				`${lead} ${stateAlone}`,
			];
			return candidates.find((candidate) => visibleWidth(candidate) <= netRoom) ?? `${lead} ${stateAlone}`;
		};
		const label = pickLabel();
		// A draft typed while Clio holds a consumed prompt is accepted and sent in
		// order once preparation or compaction ends, so the rail says what Enter
		// does. The mode's own words outrank it on a narrow rail.
		if ((mode === "PREPARING" || mode === "COMPACTING") && text.length > 0) {
			const held = join([position, theme.fg("draftState", "HOLD")]);
			const room = this.railLabelRoom(width) - (rail.yolo ? 7 : 0);
			if (visibleWidth(label) + visibleWidth(held) + 3 <= room) suffix = held;
		}
		return this.topRail(width, theme, rail, label, suffix, labelRoom);
	}

	/** The top rail holds harness activity or the active menu's title. */
	private topRail(
		width: number,
		theme: ClioTheme,
		rail: EditorRailState,
		label: string,
		suffix = "",
		labelRoom = this.railLabelRoom(width),
	): string {
		const left = rail.yolo
			? `${theme.fg(rail.tone ?? "composerRail", GLYPH.laneRule)} ${theme.style("yoloLabel", this.chrome.getYoloConfinement?.() === "unconfined" ? "YOLO!" : "YOLO", { bold: true })}`
			: "";
		const room = Math.max(0, labelRoom - (left ? visibleWidth(left) + 1 : 0));
		const fitted = Math.max(0, room - visibleWidth(suffix) - (label && suffix ? 3 : 0));
		const right = [truncateToWidth(label, fitted, GLYPH.ellipsis, false), suffix]
			.filter(Boolean)
			.join(theme.fg("separator", ` ${GLYPH.dot} `));
		return renderEditorRail(theme, width, { left, leftRaw: true, right, rightRaw: true }, rail);
	}

	/**
	 * Thinking and context stay together; permission and menu keys have priority.
	 * An approval passes its own `room` and the rail then carries its keys alone.
	 * `lead` is the draft's own units at the rail's left end: the shell unit's forms, fullest first, and the line count
	 * of a draft taller than the editor.
	 */
	private bottomRail(
		width: number,
		theme: ClioTheme,
		rail: EditorRailState,
		right = "",
		keysOnlyRoom?: number,
		lead?: { shell: readonly string[]; lines: string | null },
	): string {
		const separator = theme.fg("separator", ` ${GLYPH.dot} `);
		const context = this.chrome.getContextUsage?.();
		const facts = {
			context,
			thinking: this.chrome.getThinking?.() ?? { label: this.chrome.getThinkingLabel(), hasLevels: false },
		};
		// The group draws context first; with no context reading it is the thinking unit alone.
		const hasContext = context !== undefined && contextRailUnit(context, theme, { bar: 0, pair: false }) !== "";
		const group = (room: number): { hint: string; thinking: string; usage: string } => {
			const fittedRight = truncateToWidth(right, Math.max(0, room), GLYPH.ellipsis, false);
			const groupRoom =
				keysOnlyRoom !== undefined ? 0 : Math.max(0, room - visibleWidth(fittedRight) - (fittedRight ? 3 : 0));
			// The status after the keys fits whole or is dropped whole, and its units leave in the group's own order.
			const status = groupRoom > 0 ? contextRailGroup(theme, facts, groupRoom, width) : "";
			const cut = status.indexOf(separator);
			const usage = cut >= 0 ? status.slice(0, cut) : hasContext ? status : "";
			const thinking = cut >= 0 ? status.slice(cut + separator.length) : hasContext ? "" : status;
			return { hint: [fittedRight, status].filter(Boolean).join(separator), thinking, usage };
		};
		if (lead !== undefined && keysOnlyRoom === undefined && (lead.shell.length > 0 || lead.lines !== null)) {
			const leftOf = (shell: string | undefined): string =>
				[shell === undefined ? "" : this.paintShellUnit(theme, shell), lead.lines ?? ""].filter(Boolean).join(separator);
			// The right side's units leave in their own order; the shell unit gives up one step before each of them does.
			// A unit that changes form has given up one piece, and one that leaves the rail whole has given up two: its
			// lesser form and its last.
			const full = group(Number.MAX_SAFE_INTEGER);
			const cost = (shown: string, whole: string): number => (shown === whole ? 0 : !shown && whole ? 2 : 1);
			const dropped = (shown: { thinking: string; usage: string }): number =>
				cost(shown.thinking, full.thinking) + cost(shown.usage, full.usage);
			const forms = lead.shell.length > 0 ? lead.shell : [undefined];
			let chosen: { left: string; hint: string } | null = null;
			for (const [step, form] of forms.entries()) {
				const left = leftOf(form);
				const room = width - OVERLAY_RULE_CHROME - visibleWidth(left);
				if (room < 0) continue;
				const shown = group(room);
				chosen = { left, hint: shown.hint };
				if (dropped(shown) <= step) break;
			}
			if (chosen !== null) {
				const left = `${theme.fg(rail.tone ?? "composerRail", GLYPH.laneRule)} ${chosen.left}`;
				return renderEditorRail(theme, width, { left, leftRaw: true, right: chosen.hint, rightRaw: true }, rail);
			}
		}
		const hint = group(keysOnlyRoom ?? this.railLabelRoom(width)).hint;
		const loopRoom = Math.max(0, width - visibleWidth(hint) - (hint ? 7 : 4));
		const loop = loopRoom > 0 ? this.chrome.getLoopRail?.(loopRoom) : null;
		// The current task takes only what the rail's state left over, and an active loop outranks it.
		const task = !loop && loopRoom >= TASK_RAIL_MIN_ROOM ? this.chrome.getTaskRail?.(loopRoom) : null;
		const leftText = loop ?? task;
		const left = leftText ? `${theme.fg(rail.tone ?? "composerRail", GLYPH.laneRule)} ${leftText}` : "";
		return renderEditorRail(theme, width, { left, leftRaw: true, right: hint, rightRaw: true }, rail);
	}

	/** `$ shared shell · Enter runs · CLIO Coder sees the output`: the kind of shell first, then the key, then who sees it. */
	private paintShellUnit(theme: ClioTheme, form: string): string {
		const [kind = "", key, disclosure] = form.split(` ${GLYPH.sep} `);
		return [
			theme.style("draftState", kind, { bold: true }),
			key === undefined ? "" : theme.fg("keyboardHint", key),
			disclosure === undefined ? "" : theme.fg("annotation", disclosure),
		]
			.filter(Boolean)
			.join(theme.fg("separator", ` ${GLYPH.sep} `));
	}

	/** The draft's own units for the bottom rail: which shell a `!` line runs in, and how tall a draft is that overflows. */
	private draftRailLead(
		text: string,
		hidden: number,
		theme: ClioTheme,
	): { shell: readonly string[]; lines: string | null } {
		const shell =
			this.chrome.getDraftOperator?.(text) === "shell"
				? SHELL_RAIL_FORMS[text.trimStart().startsWith("!!") ? "private" : "shared"]
				: [];
		const count = this.getLines().length;
		return { shell, lines: hidden > 0 ? theme.fg("positionCount", `${count} lines`) : null };
	}

	private railLabelRoom(width: number): number {
		// A clear left stretch preserves the composer's shape, even on narrow terminals.
		return Math.max(1, width - Math.min(16, Math.floor(width / 3)) - 3);
	}

	/** An approval's title and keys take the rail to a three-column stretch: at 60 columns the shared room cut the queue count. */
	private approvalLabelRoom(width: number): number {
		return Math.max(1, width - 6);
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		this.renderedBottomHidden = hiddenLineCount;
		const theme = clioTheme();
		const text = this.getText();
		const mode = composerMode(this.chrome, text);
		const rail = this.railState(mode);
		const scroll = hiddenLineCount > 0 ? `${GLYPH.down}${hiddenLineCount}` : "";
		const room = this.railLabelRoom(width);
		const steer = mode === "CONFIRM" ? null : this.steerTarget(text);
		const hint =
			mode === "CONFIRM"
				? confirmRailHint(
						theme,
						Math.max(1, room - (scroll ? visibleWidth(scroll) + 3 : 0)) + 3,
						text.length > 0,
						this.chrome.getPermissionInspection?.() ?? "none",
						this.chrome.getPermissionTerms?.() ?? "closed",
					)
				: steer
					? fitHintEntries(
							[
								// Sending is what a typed steer is for, so a narrow rail keeps it before it keeps the way out.
								...(steer.live && !steer.queued
									? [{ key: "Enter", verb: `send to ${steer.agentId}`, short: "send", critical: true }]
									: []),
								// A bare `cancel` beside a worker's name reads as stopping the worker, so the short form says back.
								{ key: "Esc", verb: "cancel steer, keep text", short: "back" },
							],
							// The steer's keys take the approval's stretch: the composer's clear left cost them the send key at 40 columns.
							Math.max(1, this.approvalLabelRoom(width) - (scroll ? visibleWidth(scroll) + 3 : 0)),
						)
					: this.isShowingAutocomplete()
						? // An open list owns Tab and Esc; a bare rail left the way out of it unnamed.
							fitHintEntries(
								!this.syncSuggestionArming()
									? [
											{ key: "Tab", verb: "complete", critical: true },
											{ key: "Enter", verb: "run as typed", short: "run" },
											{ key: "Esc", verb: "close list, keep text", short: "close list" },
										]
									: // After a bare `/` Enter only completes the first row, so the rail must not promise a run.
										this.selectedSuggestion()?.kind === "command" &&
											this.selectedSuggestion()?.runsBare === true &&
											/^\/\S/u.test(this.getText().trimStart())
										? [
												{ key: "Enter", verb: "run", critical: true },
												{ key: "Tab", verb: "complete" },
												{ key: "Esc", verb: "close list" },
											]
										: [
												{ key: "Tab", verb: "complete", critical: true },
												{ key: "Esc", verb: "close list, keep text", short: "close list" },
											],
								Math.max(1, this.approvalLabelRoom(width) - (scroll ? visibleWidth(scroll) + 3 : 0)),
							)
						: "";
		const right = [scroll ? theme.fg("positionCount", scroll) : "", theme.base("keyboardHint", hint)]
			.filter(Boolean)
			.join(theme.fg("separator", ` ${GLYPH.dot} `));
		this.renderedBottomRail = this.bottomRail(
			width,
			theme,
			rail,
			right,
			(steer || this.isShowingAutocomplete()) && mode !== "CONFIRM" ? this.approvalLabelRoom(width) : undefined,
			mode === "CONFIRM" ? undefined : this.draftRailLead(text, this.renderedTopHidden + hiddenLineCount, theme),
		);
		return this.renderedBottomRail;
	}

	/**
	 * The top rule of a focused surface: its title at the left (`━ Models ━`), and at the right, fitted from what is
	 * left and dropped from the end, the surface's own pending state, the live run's cue, state and elapsed, and the
	 * actor. The title never drops; it shortens only once every right unit but the pending state is gone. The rule never
	 * carries the run's Esc: the surface owns Esc while it is focused, and its key rail says what Esc does.
	 */
	private overlayRule(
		width: number,
		theme: ClioTheme,
		rail: EditorRailState,
		title: { plain: (room: number) => string; paint: (text: string) => string },
		pending: RuleUnit | null,
	): string {
		const run = this.chrome.getBesideCard?.(width) ?? null;
		const cue =
			run === null
				? ""
				: run.live
					? activityCue(this.railAnimationTime, this.chrome.getMotionEnabled?.() ?? true)
					: run.glyph;
		const separator = theme.fg("separator", ` ${GLYPH.sep} `);
		const runUnits: RuleUnit[] =
			run?.forms.map((form) => ({
				text: `${cue} ${form}`,
				paint: (text) => {
					const [state = "", ...facts] = text.split(` ${GLYPH.sep} `);
					return [theme.fg(run.token, state), ...facts.map((fact) => theme.fg("annotation", fact))].join(separator);
				},
			})) ?? [];
		const actor: RuleUnit | null =
			run?.actor != null ? { text: run.actor, paint: (text) => theme.fg("activeModelIdentity", text) } : null;
		const head = pending === null ? [] : [pending];
		const withActor = actor === null ? [] : runUnits.map((unit) => [...head, unit, actor]);
		const withoutActor = [...runUnits.map((unit) => [...head, unit]), head];
		const cells = (units: readonly RuleUnit[]): number =>
			units.reduce((sum, unit, index) => sum + visibleWidth(unit.text) + (index === 0 ? 0 : 3), 0);
		const chrome = (units: readonly RuleUnit[]): number => (units.length > 0 ? OVERLAY_RULE_CHROME : OVERLAY_RULE_BARE);
		const whole = title.plain(Math.max(1, width - OVERLAY_RULE_BARE));
		let fitted: { title: string; units: readonly RuleUnit[] } | null = null;
		for (const units of [...withActor, ...withoutActor, []]) {
			if (visibleWidth(whole) + cells(units) + chrome(units) <= width) {
				fitted = { title: whole, units };
				break;
			}
		}
		// Past that the title shortens to keep the pending state, and is cut only when nothing else is left on the rule.
		if (fitted === null) {
			for (const units of [head, []]) {
				const room = width - cells(units) - chrome(units);
				const shorter = room > 0 ? title.plain(room) : "";
				if (room > 0 && visibleWidth(shorter) <= room) {
					fitted = { title: shorter, units };
					break;
				}
			}
		}
		const room = Math.max(1, width - OVERLAY_RULE_BARE);
		const shown = fitted ?? { title: truncateToWidth(title.plain(room), room, GLYPH.ellipsis, false), units: [] };
		const right = shown.units.map((unit) => unit.paint(unit.text)).join(separator);
		return renderEditorRail(
			theme,
			width,
			{ left: title.paint(shown.title), leftRaw: true, leftLead: 1, right, rightRaw: true },
			rail,
		);
	}

	/** A docked command or menu: its title and keys on the composer's rails, its body between them. */
	private renderDock(
		entry: DockEntry,
		width: number,
		theme: ClioTheme,
		rail: EditorRailState,
	): { lines: string[]; bodyEnd: number } {
		const gutter = ClioEditor.DOCK_GUTTER;
		const contentWidth = Math.max(1, width - gutter * 2);
		const adaptive = entry.adaptive === true;
		const grows = adaptive || entry.frame.dockWantsGrowth?.() === true;
		// An adaptive surface waiting on the operator's answer (the interview) may fill the screen, so its question reads whole.
		const fill = adaptive && entry.frame.dockAwaitingInput?.() === true;
		const bodyRows = grows ? dockGrowthRows(this.dockHost, fill) : dockBodyRows(this.dockHost);
		// The body learns the rail's room first, so a list can draw in its own
		// rows every key the rail below will have to drop. The rail is the keys'
		// alone: thinking and context describe the composer, which is not open (F07).
		const room = this.approvalLabelRoom(width);
		entry.frame.setRailRoom?.(room);
		let body = entry.frame.renderDockBody(contentWidth, Math.max(1, bodyRows));
		// The frame pads to its budget, and blank rows above the keys say nothing. A short surface keeps the rows its content
		// has used so far, so a filter that narrows a list or a tab with less to show does not make the rails jump.
		let used = body.length;
		while (used > 1 && stripTerminalSequences(body[used - 1] ?? "").trim() === "") used -= 1;
		entry.rowsUsed = Math.max(entry.rowsUsed ?? 0, used);
		// A body that stops asking to grow returns to the shared height, so the slice is also capped at what it was given.
		body = body.slice(0, adaptive ? dockAdaptiveRows(this.dockHost, used, fill) : Math.min(entry.rowsUsed, bodyRows));
		const pad = " ".repeat(gutter);
		// A title that can shorten itself is told the room it may take.
		const tone = entry.frame.dockTone() ?? "sectionHeading";
		// A question holds the keyboard like a card does, so the rule says it waits for the operator.
		const pending: RuleUnit | null = entry.frame.dockAwaitingInput?.()
			? {
					text: `${GLYPH.phaseBlocked} waiting for you`,
					paint: () =>
						`${theme.fg("attentionRail", GLYPH.phaseBlocked)} ${theme.style("decisionCue", "waiting for you", { bold: true })}`,
				}
			: null;
		const hint = entry.frame.dockHint(room + 4);
		const lines = [
			this.overlayRule(
				width,
				theme,
				rail,
				{
					plain: (titleRoom) => entry.frame.dockTitle({ room: titleRoom, actor: "" }),
					paint: (text) => theme.style(tone, text, { bold: true }),
				},
				pending,
			),
			...body.map((row) => padAnsi(`${pad}${row}${pad}`, width)),
			// The dock's keys get the hint role like every other rail; unpainted, they took the terminal's own
			// foreground, which a light scheme such as Solarized sets below 4.5:1.
			this.bottomRail(width, theme, rail, hint?.trim().length ? theme.base("keyboardHint", hint) : "", room),
		];
		// The run's state rides on the top rule, so nothing joins the dock under its key rail.
		return { lines, bodyEnd: lines.length - 1 };
	}

	/**
	 * A permission card inside the editor's own rails, decisions first (7.4). The top rule is titled `Approval` and its
	 * right end says what waits and its clock (`‖ needs approval · 3:32 · <actor>`); the bottom rail carries the card's
	 * keys once. The card gets every row the rails, the footer and a sliver of transcript leave, with no shared ceiling.
	 * The operator's draft stays editable under it, at most 2 rows and its divider, because Enter is inert while it
	 * exists (#186).
	 */
	private renderApproval(
		entry: DockEntry,
		width: number,
		theme: ClioTheme,
		draft: { rows: string[]; hiddenAbove: number; hiddenBelow: number },
	): { card: string[]; composer: string[] } {
		const gutter = ClioEditor.DOCK_GUTTER;
		const contentWidth = Math.max(1, width - gutter * 2);
		const pad = " ".repeat(gutter);
		const rail: EditorRailState = { ...this.railState("CONFIRM"), tone: "attentionRail" };
		const room = this.approvalLabelRoom(width);
		const route = this.chrome.getModelLabel();
		const cue = GLYPH.phaseBlocked;
		const tone = entry.frame.dockTone() ?? "decisionCue";
		const actor = modelNickname(typeof route === "string" ? route.split("·").at(-1) : route.modelId);
		// The draft's rows and its divider come out of the card's budget, so the whole surface keeps its height.
		const draftRows = draft.rows.length > 0 ? draft.rows.length + 1 : 0;
		const down = draft.hiddenBelow > 0 ? theme.fg("positionCount", `${GLYPH.down}${draft.hiddenBelow}`) : "";
		entry.frame.setRailRoom?.(room - (down ? visibleWidth(down) + 3 : 0));
		// The body renders before the rule reads its title, so the rule states the clock this frame draws.
		const rendered = entry.frame.renderDockBody(contentWidth, Math.max(1, decisionRows(this.dockHost) - draftRows));
		// The frame pads every body to its budget; a card owes no blank rows above its keys.
		let bodyEnd = rendered.length;
		while (bodyEnd > 1 && stripTerminalSequences(rendered[bodyEnd - 1] ?? "").trim() === "") bodyEnd -= 1;
		const title = "Approval";
		const label = {
			plain: (titleRoom: number) =>
				visibleWidth(title) <= titleRoom ? title : truncateToWidth(title, titleRoom, GLYPH.ellipsis, false),
			paint: (text: string) => theme.style(tone, text, { bold: true }),
		};
		// The decision keeps its unit on the rule: it shortens to the clock alone before the title gives way.
		const decisionRoom = Math.max(1, width - OVERLAY_RULE_CHROME - visibleWidth(title) - visibleWidth(cue) - 1);
		const decision = entry.frame.dockTitle({ room: decisionRoom, actor });
		const pending: RuleUnit = {
			text: `${cue} ${decision}`,
			paint: (text) =>
				`${theme.fg("attentionRail", cue)} ${theme.style(tone, text.slice(cue.length + 1), { bold: true })}`,
		};
		const hint = entry.frame.dockHint(room - (down ? visibleWidth(down) + 3 : 0) + 4);
		const keys = [down, hint?.trim().length ? theme.fg("decisionKey", hint) : ""]
			.filter(Boolean)
			.join(theme.fg("separator", ` ${GLYPH.dot} `));
		// Draft rows hidden above the two shown are the divider's own position.
		const up = draft.hiddenAbove > 0 ? `${GLYPH.up}${draft.hiddenAbove}` : "";
		return {
			card: [
				this.overlayRule(width, theme, rail, label, pending),
				...rendered.slice(0, bodyEnd).map((row) => padAnsi(`${pad}${row}${pad}`, width)),
				...(draft.rows.length > 0
					? [
							padAnsi(
								`${pad}${rule(theme, contentWidth, { left: "Your draft", leftToken: "annotation", ...(up ? { right: up } : {}) })}`,
								width,
							),
						]
					: []),
			],
			composer: [...draft.rows, this.bottomRail(width, theme, rail, keys, room)],
		};
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
			input.findIndex((line) => line.includes(FAKE_CURSOR_START)),
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
		const engineItems = hasCount ? suggestions.slice(0, -1) : suggestions;
		const selectedItem = this.selectedSuggestion();
		const panel = selectedItem ? this.suggestionPanel(selectedItem, width, theme) : [];
		const wanted = rows.length + engineItems.length + (hasCount ? 1 : 0) + panel.length;
		const bodyRows = dockAdaptiveRows(this.dockHost, wanted - 1);
		const room = Math.max(1, bodyRows + 1 - rows.length);
		// A short dock keeps a few list rows and gives the panel what is left.
		const panelRows = Math.min(
			panel.length,
			Math.max(0, room - Math.min(engineItems.length + (hasCount ? 1 : 0), SUGGESTION_MIN_LIST_ROWS)),
		);
		const listRoom = room - panelRows;
		// Slash rows are composed here from the engine's own list, so the tier applies on the next frame, the group word
		// sits at the row end where room allows, and a cut description ends in an ellipsis instead of a silent cut.
		const policy = tierPolicy();
		const list = this.suggestionEngine().autocompleteList as
			| {
					filteredItems?: ReadonlyArray<Partial<SlashCompletionItem>>;
					selectedIndex?: number;
					getVisibleRange?(): { startIndex: number; endIndex: number };
					getPrimaryColumnWidth?(): number;
			  }
			| undefined;
		// An unarmed list has no focused row: the engine drew its window with no selection, so the range is read the same way.
		const armed = this.syncSuggestionArming();
		const keptIndex = list?.selectedIndex;
		if (!armed && list !== undefined) list.selectedIndex = -1;
		let range: { startIndex: number; endIndex: number } | undefined;
		try {
			range = list?.getVisibleRange?.();
		} finally {
			if (!armed && list !== undefined && keptIndex !== undefined) list.selectedIndex = keptIndex;
		}
		const focused = armed ? keptIndex : undefined;
		const visible = range ? (list?.filteredItems ?? []).slice(range.startIndex, range.endIndex) : [];
		const composed =
			range !== undefined &&
			visible.length > 0 &&
			visible.length === engineItems.length &&
			visible.every((item) => item.kind !== undefined && typeof item.value === "string");
		const rowRoom = Math.max(1, width - 4);
		const column = list?.getPrimaryColumnWidth?.() ?? 32;
		const minDescription = 10;
		// The group words share one right-hand slot, shown on every row or none: descriptions keep this many cells first.
		const groupFloor = 40;
		const groupSlot =
			policy.listDescriptions === "all" ? Math.max(0, ...visible.map((item) => visibleWidth(item.group ?? ""))) : 0;
		const groupsFit = groupSlot > 0 && rowRoom - 2 - Math.min(column, rowRoom - 4) - groupSlot - 2 >= groupFloor;
		const fit = (text: string, cells: number): string => {
			if (visibleWidth(text) <= cells) return text;
			const cut = truncateToWidth(text, Math.max(0, cells - visibleWidth(GLYPH.ellipsis)), "", false).trimEnd();
			return `${cut}${GLYPH.ellipsis}`;
		};
		// The focused row states its description inline at compact only when the detail rows cannot carry it.
		const focusedInline = panelRows < SUGGESTION_PANEL_ROWS;
		const slashRow = (item: Partial<SlashCompletionItem>, selected: boolean): string => {
			const lead = selected ? `${GLYPH.cursor} ` : "  ";
			const cells = Math.max(1, rowRoom - visibleWidth(lead));
			// A refused row keeps its reason at every tier, and a row without detail rows keeps its own description.
			const described =
				policy.listDescriptions === "all" ||
				item.disabledReason !== undefined ||
				item.path === undefined ||
				(selected && focusedInline);
			const description = described ? (item.description ?? "").replace(/[\r\n]+/gu, " ").trim() : "";
			const group = groupsFit ? (item.group ?? "") : "";
			const cell = Math.max(1, Math.min(column, cells - 2));
			const name = item.label || item.value || "";
			let label = fit(name, cells);
			let gap = "";
			let shown = "";
			let showGroup = false;
			const groupCells = group ? visibleWidth(group) + 2 : 0;
			if (description && cells - cell >= minDescription) {
				label = fit(name, Math.max(1, cell - 2));
				gap = " ".repeat(Math.max(1, cell - visibleWidth(label)));
				let descriptionRoom = cells - visibleWidth(label) - gap.length;
				showGroup = group !== "" && descriptionRoom - groupCells >= minDescription;
				if (showGroup) descriptionRoom -= groupCells;
				shown = fit(description, descriptionRoom);
			} else if (description && item.disabledReason !== undefined) {
				// Too narrow for the description column: a refused row keeps its reason right after its name.
				const reasonCells = Math.min(visibleWidth(description), Math.max(minDescription, cells - visibleWidth(name) - 2));
				label = fit(name, Math.max(1, cells - 2 - reasonCells));
				gap = "  ";
				shown = fit(description, Math.max(1, cells - visibleWidth(label) - 2));
			}
			const head = shown ? `${label}${gap}${shown}` : label;
			const tail = showGroup
				? `${" ".repeat(Math.max(2, cells - visibleWidth(head) - visibleWidth(group)))}${theme.fg("annotation", group)}`
				: "";
			if (selected) return `${theme.style("selectedOption", `${lead}${head}`, { bold: true })}${tail}`;
			return `${lead}${label}${shown ? theme.fg("menuDescription", `${gap}${shown}`) : ""}${tail}`;
		};
		const items = composed
			? visible.map((item, index) => slashRow(item, range !== undefined && range.startIndex + index === focused))
			: engineItems;
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
		// The count row exists only when the list overflows, which is when the page keys move it.
		if (hasCount && listRoom > 1 && last !== undefined)
			appendSuggestion(`${last.trimEnd()}${theme.fg("keyboardHint", ` ${GLYPH.sep} PgUp/PgDn page`)}`, lines.length - 1);
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
		this.suggestionsAreStale();
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
		bodyStart = 1,
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
		return lines.map((line, index) => (paintRails || (index >= bodyStart && index < bodyEnd) ? paint(line) : line));
	}

	override render(width: number): string[] {
		if (this.renderedSkinEpoch !== skinEpoch()) {
			this.renderedSkinEpoch = skinEpoch();
			this.surfacePainters.clear();
			this.invalidate();
		}
		// The border and wrap need a few columns; narrower would overflow the stack.
		if (width < 3) return [" ".repeat(Math.max(0, width))];
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
				...(docked.approval ? { tone: "attentionRail" as const } : {}),
			};
			const { lines, bodyEnd } = this.renderDock(docked, safeWidth, theme, rail);
			this.autocompleteRowMap = lines.map(() => -1);
			return this.paintComposerBody(lines, safeWidth, bodyEnd, "menuOption");
		}
		const list = this.syncSuggestionArming()
			? undefined
			: (this.suggestionEngine().autocompleteList as { selectedIndex?: number } | undefined);
		const keptIndex = list?.selectedIndex;
		// An unarmed list draws no cursor mark; the engine marks the row at its selected index.
		if (list !== undefined) list.selectedIndex = -1;
		let lines: string[];
		try {
			lines = super.render(width);
		} finally {
			if (list !== undefined && keptIndex !== undefined) list.selectedIndex = keptIndex;
		}
		if (lines.length === 0) return lines;

		if (text.length === 0 && lines[1]) {
			const addressed = mode === "CONFIRM" ? null : this.steerTarget(text);
			const prompt = addressed
				? !addressed.live
					? `${addressed.agentId} ended. Esc returns this composer to CLIO Coder.`
					: addressed.queued
						? `${addressed.agentId} is queued and can take a message once it starts.`
						: `Message for ${addressed.agentId}${GLYPH.ellipsis}`
				: emptyPromptFor(mode);
			lines[1] = renderEmptyPrompt(lines[1], safeWidth, theme, prompt);
		}

		if (docked !== null) {
			const border = lines.indexOf(this.renderedBottomRail, 1);
			if (border < 1) return lines;
			const input = lines.slice(1, border);
			const cursor = Math.max(
				0,
				input.findIndex((line) => line.includes(FAKE_CURSOR_START)),
			);
			// The draft under a decision card shows at most 2 rows (7.4); the rest is counted on its divider and rail.
			const [start, end] = centeredWindow(input.length, cursor, APPROVAL_DRAFT_ROWS);
			// An empty composer has nothing to show under the card; its draft returns with the normal rails.
			const { card, composer } = this.renderApproval(docked, safeWidth, theme, {
				rows: text.length > 0 ? input.slice(start, end) : [],
				hiddenAbove: text.length > 0 ? this.renderedTopHidden + start : 0,
				hiddenBelow: text.length > 0 ? this.renderedBottomHidden + input.length - end : 0,
			});
			this.autocompleteSourceStart = Number.POSITIVE_INFINITY;
			this.autocompleteRowMap = [
				...card.map(() => -1),
				...composer.slice(0, -1).map((_, index) => start + index + 1),
				border,
			];
			return [
				...this.paintComposerBody(card, safeWidth, card.length, "menuOption"),
				...this.paintComposerBody(composer, safeWidth, composer.length - 1, "inputText", 0),
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
		if (this.restoredDraft && !this.bracketedPasteActive && (data === "/" || data === "!") && this.cursorAtEnd()) {
			this.parkedDraft = this.getExpandedText();
			this.restoredDraft = false;
			this.pastedBangOffsets.clear();
			this.pastedOperatorTokens.clear();
			super.setText("");
		}
		const parkedBeforeInput = this.parkedDraft;
		const openedPaste = data.includes("\x1b[200~");
		const closedPaste = data.includes("\x1b[201~");
		const pasteMutation = this.bracketedPasteActive || openedPaste;
		const textBeforeInput = this.getText();
		const keybindings = getKeybindings();
		const armed = this.syncSuggestionArming();
		this.autoOpenPending = false;
		if (!armed && super.isShowingAutocomplete()) {
			const moves = (["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown"] as const).some(
				(action) => keybindings.matches(data, action),
			);
			// Down moves into the list: it selects the first row rather than skipping it.
			if (moves) {
				this.suggestionArmed = true;
				return;
			}
			if (keybindings.matches(data, "tui.input.tab")) this.suggestionArmed = true;
			else if (keybindings.matches(data, "tui.select.confirm")) {
				// Nothing is selected, so Enter submits the line as typed.
				this.suggestionEngine().cancelAutocomplete?.();
				this.autocompleteDockOpen = false;
			}
		}
		const acceptsSuggestion =
			keybindings.matches(data, "tui.input.tab") || keybindings.matches(data, "tui.select.confirm");
		if (acceptsSuggestion && this.suggestionsAreStale()) {
			// Enter then submits the line as typed and Tab asks again, instead of applying a row to text it was not built for.
			this.suggestionEngine().cancelAutocomplete?.();
			this.autocompleteDockOpen = false;
			if (keybindings.matches(data, "tui.input.tab") && this.getText().trimStart().startsWith("/")) {
				this.reopenSuggestions();
				return;
			}
		} else if (acceptsSuggestion && this.isShowingAutocomplete() && this.selectedSuggestion()?.disabledReason) {
			// A row that refuses keeps the list and the reason under it. Closing would strand a partial `/co` on the composer.
			return;
		} else this.suggestionsAreStale();
		const killsText = KILL_ACTIONS.some((action) => keybindings.matches(data, action));
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
		const slashRow =
			completingDirectory && keybindings.matches(data, "tui.select.confirm") && this.getText().trimStart().startsWith("/")
				? this.selectedSuggestion()
				: null;
		const completesSlashRow = slashRow !== null;
		// A command row that runs bare is the one row Enter runs: `/con` Enter opens the context view.
		// A bare `/` typed no command, so its first row is not a choice: Enter only completes it.
		const typedCommand = /^\/(\S*)/u.exec(textBeforeCompletion.trimStart())?.[1] ?? "";
		const runsCommandRow = slashRow?.kind === "command" && slashRow.runsBare === true && typedCommand.length > 0;
		super.handleInput(completesSlashRow ? "\t" : data);
		// A row that left the line as typed (`/model claude-sonnet-5.5` typed in full) has nothing for
		// the operator to confirm, so the same Enter submits instead of being swallowed by the list.
		const submitsUnchanged =
			completesSlashRow && (runsCommandRow || (this.getText() === textBeforeCompletion && !this.isShowingAutocomplete()));
		if (submitsUnchanged) super.handleInput(data);
		if (killsText) this.followSuggestionsAfterKill(textBeforeInput);
		if (completingDirectory && !submitsUnchanged && this.getText() !== textBeforeCompletion) {
			if (cursorEndsDirectoryPath(this)) {
				// Directory rows are submenus on the same provider. Re-open immediately
				// after acceptance so ↑/↓ continues in the child tree without requiring
				// a second Tab. Pi's provider request remains the only completion path.
				super.handleInput("\t");
			} else if (cursorAwaitsSlashArgument(this)) {
				this.reopenSuggestions(true);
			}
		} else if (data === " " && !pasteMutation && !super.isShowingAutocomplete() && cursorAwaitsSlashArgument(this)) {
			// A space after a command or subcommand asks what comes next.
			this.reopenSuggestions(true);
		}
		const textAfterInput = this.getText();
		// A parked draft that came back during this key is still untouched.
		if (textAfterInput !== textBeforeInput && this.parkedDraft === parkedBeforeInput) this.restoredDraft = false;
		this.pastedBangOffsets = remapPastedBangOffsets(
			textBeforeInput,
			textAfterInput,
			this.pastedBangOffsets,
			pasteMutation,
		);
		if (openedPaste) this.bracketedPasteActive = true;
		if (closedPaste) this.bracketedPasteActive = false;
		if (this.parkedDraft !== null && this.getText().length === 0) this.setText("");
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
		this.autoOpenPending = false;
		this.autocompleteDockOpen = false;
		this.pastedOperatorTokens.clear();
		this.pastedBangOffsets.clear();
		this.bracketedPasteActive = false;
		this.restoredDraft = false;
		this.boardSteer = null;
		const sent = this.sentSteer;
		this.sentSteer = null;
		// A refused steer comes back with the address it was sent with, and it hides again.
		if (sent !== null && text.trimStart().startsWith(`@${sent.runId}`)) {
			this.boardSteer = sent;
			super.setText(
				text
					.trimStart()
					.slice(sent.runId.length + 1)
					.trimStart(),
			);
			return;
		}
		if (text.length === 0 && this.parkedDraft !== null) {
			const parked = this.parkedDraft;
			this.parkedDraft = null;
			this.setRestoredText(parked);
			return;
		}
		super.setText(text);
	}
}
