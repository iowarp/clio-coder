import { Editor, type TUI } from "../engine/tui.js";
import type { ClioTheme } from "./theme/index.js";
import { clioTheme, editorTheme, GLYPH, rule } from "./theme/index.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

function hasScrollIndicator(line: string): boolean {
	const stripped = stripAnsi(line);
	return stripped.includes(GLYPH.up) || stripped.includes(GLYPH.down);
}

export interface EditorChrome {
	/** Target+model identity, e.g. `mini·Qwen3.6-35B`. */
	getModelLabel: () => string;
	/** Effective thinking level, e.g. `high` / `off`. */
	getThinkingLabel: () => string;
}

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

		if (!hasScrollIndicator(lines[0] ?? "")) {
			lines[0] = rule(theme, safeWidth, {
				right: styledRailLabel(theme, this.chrome),
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
