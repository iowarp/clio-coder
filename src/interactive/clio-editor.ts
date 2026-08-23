import { Editor, stripTerminalSequences, type TUI, truncateToWidth, visibleWidth } from "../engine/tui.js";
import { fitHintEntries } from "./overlay-frame.js";
import { permissionHintEntries } from "./permission-overlay.js";
import type { ClioTheme } from "./theme/index.js";
import { clioTheme, editorTheme, GLYPH, rule } from "./theme/index.js";

const REVERSE_VIDEO_BLANK = `${String.fromCharCode(27)}[7m ${String.fromCharCode(27)}[0m`;
const EMPTY_PROMPT = "Ask Clio…  / for commands";
const CONFIRM_PROMPT = "A parked call is waiting for your decision";
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
	 * Whether a permission prompt owns the keyboard. The dialog that renders
	 * it sits at the vertical center of the viewport, which on a tall terminal
	 * with a long transcript is forty rows from the composer, and the composer
	 * rail is what the operator reads before pressing Enter (issue #186). In
	 * that state the rail says CONFIRM and carries the dialog's keys.
	 */
	isAwaitingApproval?: () => boolean;
	/** Whether the current draft will actually steer Clio or live dispatch work on Enter. */
	willEnterSteer?: (text: string) => boolean;
	/** Resolved submit binding, formatted for display. */
	getSubmitKeyLabel?: () => string;
	/** Resolved multiline binding, formatted for display. */
	getNewlineKeyLabel?: () => string;
}

type ComposerMode = "MESSAGE" | "FOLLOW-UP" | "STEER" | "CONFIRM";

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
	if (!(chrome.isStreaming?.() ?? false)) return "MESSAGE";
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
function confirmRailHint(theme: ClioTheme, width: number, hasDraft: boolean): string {
	return theme.fg("warning", fitHintEntries(permissionHintEntries(hasDraft), Math.max(1, width - 3)));
}

function modeToken(mode: ComposerMode): "action" | "accentDeep" | "warning" {
	if (mode === "STEER") return "action";
	if (mode === "CONFIRM") return "warning";
	return "accentDeep";
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

export class ClioEditor extends Editor {
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
			lines[1] = renderEmptyPrompt(lines[1], safeWidth, theme, mode === "CONFIRM" ? CONFIRM_PROMPT : EMPTY_PROMPT);
		}

		const bottomRail = findBottomRail(lines, safeWidth);
		// The confirm keys render at every width: the send hint is a convenience
		// that a narrow composer can drop, the allow and deny keys are not.
		if (bottomRail >= 0 && mode === "CONFIRM") {
			lines[bottomRail] = rule(theme, safeWidth, {
				right: confirmRailHint(theme, safeWidth, text.length > 0),
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
	 * pi-tui's bracketed-paste handling inserts pasted text (including a
	 * trailing newline the paste carried) without submitting: a pasted
	 * `/model\n` lands as two lines in the buffer and just sits there. Once
	 * the base handler has applied a chunk that closed a paste, check whether
	 * the buffer now reads as a completed slash command and, if so, submit it
	 * through the same handler the typed-Enter path uses.
	 */
	override handleInput(data: string): void {
		const closedPaste = data.includes("\x1b[201~");
		super.handleInput(data);
		if (!closedPaste) return;
		const text = this.getText();
		if (!text.endsWith("\n")) return;
		const command = text.trimEnd();
		if (!command.startsWith("/")) return;
		this.setText("");
		this.onSubmit?.(command);
	}
}
