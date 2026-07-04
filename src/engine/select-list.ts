/**
 * Engine wrapper over pi-tui's SelectList. pi-tui hardcodes the rightwards arrow
 * (U+2192) as the selected-row prefix inside its private renderItem, with no
 * theme hook to override it. Clio's design system mandates the ❯ cursor, so the
 * engine exposes the prefix glyph as theme data here and rewrites the leading
 * arrow of the selected row on the way out. Keeping the override at the engine
 * boundary means every raw SelectList picker inherits the design cursor from its
 * theme without a consumer-side adapter.
 */
import {
	SelectList as EngineSelectList,
	type SelectListTheme as EngineSelectListTheme,
	type SelectItem,
	type SelectListLayoutOptions,
} from "@earendil-works/pi-tui";

/** The prefix pi-tui's SelectList.renderItem hardcodes for the selected row. */
const PI_SELECT_CURSOR = "→";

const ESC = String.fromCharCode(0x1b);

/**
 * Match the engine cursor only where pi-tui emits it: as the row's leading
 * glyph, after any SGR color runs the theme wraps the selected line in. Anchoring
 * to the start leaves an arrow that appears inside a label untouched.
 */
const LEADING_CURSOR_PATTERN = new RegExp(`^((?:${ESC}\\[[0-9;]*m)*)${PI_SELECT_CURSOR} `);

/**
 * pi-tui's SelectListTheme plus the Clio design cursor. When `cursor` is set the
 * selected-row prefix renders with that glyph instead of pi-tui's arrow; omitting
 * it preserves the engine default.
 */
export interface SelectListTheme extends EngineSelectListTheme {
	/** Selected-row prefix glyph. Defaults to pi-tui's arrow when omitted. */
	cursor?: string;
}

export class SelectList extends EngineSelectList {
	private readonly designCursor: string | undefined;

	constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme, layout?: SelectListLayoutOptions) {
		super(items, maxVisible, theme, layout);
		this.designCursor = theme.cursor;
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		const cursor = this.designCursor;
		if (!cursor || cursor === PI_SELECT_CURSOR) return lines;
		return lines.map((line) => line.replace(LEADING_CURSOR_PATTERN, `$1${cursor} `));
	}
}
