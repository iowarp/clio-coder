import { Editor, type TUI } from "../engine/tui.js";
import { clioTheme, editorTheme, GLYPH, rule } from "./theme/index.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

function isRail(line: string): boolean {
	const stripped = stripAnsi(line).trim();
	return stripped.includes("─") && /^[─↑↓0-9 a-zA-Z]+$/.test(stripped);
}

function hasScrollIndicator(line: string): boolean {
	const stripped = stripAnsi(line);
	return stripped.includes(GLYPH.up) || stripped.includes(GLYPH.down);
}

export interface EditorChrome {
	getModelLabel: () => string;
	getMode: () => string;
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
				right: `${this.chrome.getModelLabel()} · ${this.chrome.getMode()}`,
			});
		}

		return lines;
	}
}

export const __clioEditorTest = { isRail, stripAnsi };
