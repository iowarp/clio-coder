import type { OutputStyle } from "../core/defaults.js";
import {
	Editor,
	getKeybindings,
	stripTerminalSequences,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "../engine/tui.js";
import { type DockEntry, dockBodyRows, dockTop } from "./dock.js";
import { guardPastedEditorOperator } from "./editor-bash.js";
import { type EditorRailState, renderEditorRail } from "./editor-rails.js";
import { fitHintEntries } from "./overlay-frame.js";
import { type PermissionInspectionHint, permissionHintEntries } from "./permission-hint.js";
import type { ClioTheme } from "./theme/index.js";
import { ANIMATION_STEP_MS, animationStep, clioTheme, editorTheme, GLYPH, padAnsi } from "./theme/index.js";
import type { TargetIdentity } from "./theme/labels.js";
import type { TurnPreparationPhase } from "./turn-state.js";

const REVERSE_VIDEO_BLANK = `${String.fromCharCode(27)}[7m ${String.fromCharCode(27)}[0m`;
const EMPTY_PROMPT = "Ask Clio…  / for commands";
const CONFIRM_PROMPT = "A parked call is waiting for your decision";
const PREPARING_PROMPT = "Clio has your prompt and is preparing the turn";
const COMPACTING_PROMPT = "Clio is compacting the session context";

function hasScrollIndicator(line: string): boolean {
	const stripped = stripTerminalSequences(line);
	return stripped.includes(GLYPH.up) || stripped.includes(GLYPH.down);
}

export interface EditorChrome {
	/** Raw route fields from presentation; startup/legacy labels remain opaque strings. */
	getModelLabel: () => TargetIdentity | string;
	/** Effective thinking level, e.g. `high` / `off`. */
	getThinkingLabel: () => string;
	getOutputStyle?: () => OutputStyle;
	/** Effective session autonomy, including live overrides. */
	getAutonomy?: () => string;
	/** Monotonic animation clock, injectable for deterministic rendering tests. */
	getAnimationTime?: () => number;
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
	return theme.fg("warning", fitHintEntries(permissionHintEntries(hasDraft, inspection), Math.max(1, width - 3)));
}

function modeToken(mode: ComposerMode): "action" | "accentDeep" | "warning" {
	if (mode === "STEER" || mode === "PREPARING" || mode === "COMPACTING") return "action";
	if (mode === "CONFIRM") return "warning";
	return "accentDeep";
}

/** Five cells map the supported effort range without borrowing footer space. */
function thinkingRailHint(theme: ClioTheme, level: string, style: OutputStyle, width: number): string {
	const steps: Record<string, number> = { off: 0, minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
	if (process.env.CLIO_CODER_SCREEN_READER === "1" || width < 28 || !(level in steps))
		return theme.fg("reason", `think ${level}`);
	const count = steps[level] ?? 0;
	const cells = `${theme.fg("reason", "▰".repeat(count))}${theme.fg("dim", "▱".repeat(5 - count))}`;
	if (style === "compact") return `${theme.fg("reason", "T")} ${cells}`;
	return `${theme.fg("reason", "think")} ${cells}${style === "detailed" ? ` ${theme.fg("reason", level)}` : ""}`;
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
	const prompt = truncateToWidth(theme.fg("dim", text), available, "…", false);
	const consumed = visibleWidth(prompt);
	return `${line.slice(0, afterCursorAt)}${prompt}${line.slice(afterCursorAt + consumed)}`;
}

function findBottomRail(lines: readonly string[], width: number): number {
	const rail = "─".repeat(Math.max(0, width));
	for (let index = 1; index < lines.length; index += 1) {
		if (stripTerminalSequences(lines[index] ?? "") === rail) return index;
	}
	return -1;
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
		super(tui, editorTheme(clioTheme()));
		this.dockHost = tui;
	}

	/** Two-column gutter on each side of a docked body, the autocomplete's own indent. */
	private static readonly DOCK_GUTTER = 2;

	/**
	 * The dock: a modal surface drawn in the composer's slot.
	 *
	 * ```
	 * Title ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	 *   > filter
	 *   ❯ row
	 *     row
	 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ [↑↓] select · [Enter] use · [Esc] close ━
	 * ```
	 *
	 * The title sits where the composer's mode label sits, because the dock is
	 * the composer's mode while it is open. The hint sits where the CONFIRM keys
	 * sit. A frame that keeps the composer (the permission card) draws its body
	 * and then the composer's own rows, whose CONFIRM rail already carries the
	 * decision keys, so the card's hint rail is not drawn twice.
	 */
	private renderDock(entry: DockEntry, width: number, theme: ClioTheme, rail: EditorRailState): string[] {
		const gutter = ClioEditor.DOCK_GUTTER;
		const contentWidth = Math.max(1, width - gutter * 2);
		const body = entry.frame.renderDockBody(contentWidth, dockBodyRows(this.dockHost));
		const pad = " ".repeat(gutter);
		const tone = entry.frame.dockTone();
		const title = entry.frame.dockTitle();
		const top = renderEditorRail(
			theme,
			width,
			{
				...(title.length > 0 ? { left: title, leftToken: tone ?? ("accentDeep" as const) } : {}),
				fillToken: "editor",
			},
			rail,
		);
		const lines = [top, ...body.map((row) => padAnsi(`${pad}${row}${pad}`, width))];
		if (entry.keepComposer) return lines;
		const hint = entry.frame.dockHint(width);
		lines.push(
			renderEditorRail(
				theme,
				width,
				{
					...(hint && hint.trim().length > 0
						? { right: hint, rightRaw: true, rightTail: theme.style("editor", "─", { bold: true }) }
						: {}),
					fillToken: "editor",
				},
				rail,
			),
		);
		return lines;
	}

	override render(width: number): string[] {
		const theme = clioTheme();
		const safeWidth = Math.max(0, width);
		const text = this.getText();
		const mode = composerMode(this.chrome, text);
		const docked = dockTop(this.dockHost);
		if (docked !== null && !docked.keepComposer) {
			return this.renderDock(docked, safeWidth, theme, {
				phase: docked.frame.dockTone() === "warning" ? "attention" : "idle",
				yolo: this.chrome.getAutonomy?.() === "yolo",
				animate: false,
				now: 0,
			});
		}
		const lines = super.render(width);
		if (lines.length === 0) return lines;
		const rail: EditorRailState = {
			phase: mode === "CONFIRM" ? "attention" : mode === "MESSAGE" ? "idle" : "working",
			yolo: this.chrome.getAutonomy?.() === "yolo",
			animate:
				(mode === "CONFIRM" || text.length === 0) &&
				process.env.CLIO_CODER_REDUCE_MOTION !== "1" &&
				process.env.CLIO_CODER_SCREEN_READER !== "1" &&
				process.env.TERM !== "dumb" &&
				process.env.NO_COLOR === undefined,
			// The pulse steps with the footer spinner rather than on every frame, so
			// a frame that only appends streamed text leaves the rail untouched.
			now: this.chrome.getAnimationTime?.() ?? animationStep(performance.now()) * ANIMATION_STEP_MS,
		};

		// The effort meter lives on the composer; permission and preparation retain
		// the left edge, while native scroll indicators keep their own row.
		if (!hasScrollIndicator(lines[0] ?? "")) {
			const exceptional = mode === "CONFIRM" || mode === "PREPARING" || mode === "COMPACTING";
			const thinking = thinkingRailHint(
				theme,
				this.chrome.getThinkingLabel(),
				this.chrome.getOutputStyle?.() ?? "standard",
				safeWidth,
			);
			lines[0] = renderEditorRail(
				theme,
				safeWidth,
				{
					...(exceptional
						? {
								left: rail.yolo ? `${mode} · YOLO` : mode,
								leftToken: rail.yolo ? ("editorDanger" as const) : modeToken(mode),
							}
						: rail.yolo
							? { left: "YOLO", leftToken: "editorDanger" as const }
							: {}),
					right: thinking,
					rightRaw: true,
				},
				rail,
			);
		}

		if (text.length === 0 && lines[1]) {
			lines[1] = renderEmptyPrompt(lines[1], safeWidth, theme, emptyPromptFor(mode));
		}

		const bottomRail = findBottomRail(lines, safeWidth);
		// The confirm keys render at every width: the send hint is a convenience
		// that a narrow composer can drop, the allow and deny keys are not.
		if (bottomRail >= 0 && mode === "CONFIRM") {
			lines[bottomRail] = renderEditorRail(
				theme,
				safeWidth,
				{
					right: confirmRailHint(theme, safeWidth, text.length > 0, this.chrome.getPermissionInspection?.() ?? "none"),
					fillToken: "editor",
					rightRaw: true,
					rightTail: theme.style("editor", "─", { bold: true }),
				},
				rail,
			);
		}

		if (bottomRail >= 0 && mode !== "CONFIRM") lines[bottomRail] = renderEditorRail(theme, safeWidth, {}, rail);
		if (docked !== null) return [...this.renderDock(docked, safeWidth, theme, rail), ...lines];
		return lines;
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
		super.handleInput(data);
		if (completingDirectory && this.getText() !== textBeforeCompletion && cursorEndsDirectoryPath(this)) {
			// Directory rows are submenus on the same provider. Re-open immediately
			// after acceptance so ↑/↓ continues in the child tree without requiring
			// a second Tab. Pi's provider request remains the only completion path.
			super.handleInput("\t");
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
		this.pastedOperatorTokens.clear();
		this.pastedBangOffsets.clear();
		this.bracketedPasteActive = false;
		super.setText(text);
	}
}
