import {
	Editor,
	getKeybindings,
	stripTerminalSequences,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "../engine/tui.js";
import { guardPastedEditorOperator } from "./editor-bash.js";
import { fitHintEntries } from "./overlay-frame.js";
import { type PermissionInspectionHint, permissionHintEntries } from "./permission-hint.js";
import type { ClioTheme } from "./theme/index.js";
import { clioTheme, editorTheme, GLYPH, rule } from "./theme/index.js";
import type { TurnPreparationPhase } from "./turn-state.js";

const REVERSE_VIDEO_BLANK = `${String.fromCharCode(27)}[7m ${String.fromCharCode(27)}[0m`;
const EMPTY_PROMPT = "Ask Clio…  / for commands";
const CONFIRM_PROMPT = "A parked call is waiting for your decision";
const PREPARING_PROMPT = "Clio has your prompt and is preparing the turn";
const COMPACTING_PROMPT = "Clio has your prompt and is compacting the context first";
const MIN_HINT_WIDTH = 60;

function hasScrollIndicator(line: string): boolean {
	const stripped = stripTerminalSequences(line);
	return stripped.includes(GLYPH.up) || stripped.includes(GLYPH.down);
}

export interface EditorChrome {
	/** Target+model identity, e.g. `node-a·example-coder-model`. */
	getModelLabel: () => string;
	/** Effective thinking level, e.g. `high` / `off`. */
	getThinkingLabel: () => string;
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

function normalizeThinkingHint(value: string): string {
	return value
		.replace(/^think\s+/i, "")
		.trim()
		.toLowerCase();
}

// The thinking-level hint reads on a two-step color scale that survives
// squinting: `off` is dim, the low band (`minimal`/`low`) is muted, and
// everything from `medium` up carries the reason token, going bold for the
// top band (`xhigh`/`max`, and the generic `on`).
function styledThinkingHint(theme: ClioTheme, value: string): string {
	const hint = normalizeThinkingHint(value);
	switch (hint) {
		case "off":
			return theme.fg("dim", hint);
		case "minimal":
		case "low":
			return theme.fg("muted", hint);
		case "xhigh":
		case "max":
		case "on":
			return theme.style("reason", hint, { bold: true });
		default:
			return theme.fg("reason", hint);
	}
}

function styledRailLabel(theme: ClioTheme, chrome: EditorChrome): string {
	return `${theme.fg("dim", chrome.getModelLabel())} ${theme.fg("dim", "·")} ${styledThinkingHint(theme, chrome.getThinkingLabel())}`;
}

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

function lowerRailHint(theme: ClioTheme, chrome: EditorChrome): string {
	return theme.fg(
		"dim",
		`${chrome.getSubmitKeyLabel?.() ?? "Enter"} send · ${chrome.getNewlineKeyLabel?.() ?? "Shift+Enter"} newline`,
	);
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

	constructor(
		tui: TUI,
		private readonly chrome: EditorChrome,
	) {
		super(tui, editorTheme(clioTheme()));
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;
		const theme = clioTheme();
		const safeWidth = Math.max(0, width);
		const text = this.getText();
		const mode = composerMode(this.chrome, text);

		if (hasScrollIndicator(lines[0] ?? "")) {
			// The base editor has already fitted the scroll indicator to this width.
			// Prefix the mode and trim only the indicator rail's trailing fill, keeping
			// its direction/count text and its own narrow-width fallback intact.
			const modeLabel = theme.style(modeToken(mode), mode, { bold: true });
			lines[0] = truncateToWidth(`${modeLabel} ${lines[0] ?? ""}`, safeWidth, "", true);
		} else {
			lines[0] = rule(theme, safeWidth, {
				left: mode,
				leftToken: modeToken(mode),
				right: styledRailLabel(theme, this.chrome),
				fillToken: "frameStrong",
				rightRaw: true,
				rightTail: theme.style("frameStrong", "─", { bold: true }),
			});
		}

		if (text.length === 0 && lines[1]) {
			lines[1] = renderEmptyPrompt(lines[1], safeWidth, theme, emptyPromptFor(mode));
		}

		const bottomRail = findBottomRail(lines, safeWidth);
		// The confirm keys render at every width: the send hint is a convenience
		// that a narrow composer can drop, the allow and deny keys are not.
		if (bottomRail >= 0 && mode === "CONFIRM") {
			lines[bottomRail] = rule(theme, safeWidth, {
				right: confirmRailHint(theme, safeWidth, text.length > 0, this.chrome.getPermissionInspection?.() ?? "none"),
				fillToken: "frameStrong",
				rightRaw: true,
				rightTail: theme.style("frameStrong", "─", { bold: true }),
			});
		} else if (bottomRail >= 0 && safeWidth >= MIN_HINT_WIDTH) {
			lines[bottomRail] = rule(theme, safeWidth, {
				right: lowerRailHint(theme, this.chrome),
				fillToken: "frameStrong",
				rightRaw: true,
				rightTail: theme.style("frameStrong", "─", { bold: true }),
			});
		}

		return lines;
	}

	/**
	 * Preserve paste provenance for every immediate-send binding, including the
	 * alternate paths that invoke the submit controller without an Editor Enter.
	 */
	getTextForSubmit(): string {
		const text = this.getExpandedText();
		return startsWithPastedOperator(this.getText(), this.pastedBangOffsets) ? guardPastedEditorOperator(text) : text;
	}

	/**
	 * pi-tui's bracketed-paste handling inserts pasted text (including a
	 * trailing newline the paste carried) without submitting: a pasted
	 * `/model\n` lands as two lines in the buffer and just sits there. Once
	 * the base handler has applied a chunk that closed a paste, check whether
	 * the buffer now reads as a completed slash command and, if so, submit it
	 * through the same handler the typed-Enter path uses.
	 */
	override handleInput(data: string): void {
		const openedPaste = data.includes("\x1b[200~");
		const closedPaste = data.includes("\x1b[201~");
		const pasteMutation = this.bracketedPasteActive || openedPaste;
		const textBeforeInput = this.getText();
		const keybindings = getKeybindings();
		// Pi expands and trims the buffer immediately before onSubmit. Envelope a
		// pasted bang draft for that synchronous handoff so the Bash parser can
		// distinguish it from a typed operator; the submit controller unwraps it
		// before sending the literal prompt onward.
		if (
			startsWithPastedOperator(textBeforeInput, this.pastedBangOffsets) &&
			keybindings.matches(data, "tui.input.submit")
		) {
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
		if (!closedPaste) return;
		const text = this.getText();
		if (!text.endsWith("\n")) return;
		const command = text.trimEnd();
		if (!command.startsWith("/")) return;
		this.setText("");
		this.onSubmit?.(command);
	}

	override setText(text: string): void {
		this.pastedBangOffsets.clear();
		this.bracketedPasteActive = false;
		super.setText(text);
	}
}
