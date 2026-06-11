import type { ClioTheme, ClioToken } from "./tokens.js";

/**
 * Presentational primitives for the welcome/footer dashboards. These keep raw
 * ANSI inside the theme module: every colored separator, chip, and section tag
 * is produced here so interactive render code only ever composes already-styled
 * strings. Helpers are pure and width-agnostic; callers fit/truncate with the
 * engine helpers after composition.
 */

function present(parts: ReadonlyArray<string | null | undefined>): string[] {
	return parts.filter((part): part is string => typeof part === "string" && part.length > 0);
}

/** Dim middot used to separate chips inside a single section. */
export function dotSep(theme: ClioTheme): string {
	return theme.fg("dim", " · ");
}

/** Frame-colored vertical bar used to separate sections on one row. */
export function barSep(theme: ClioTheme): string {
	return theme.fg("frame", " │ ");
}

/**
 * A bold, color-tagged section label (PERCEIVE / target / …). Pad to align a
 * column of tags; padding inherits the tag color but stays invisible.
 */
export function sectionTag(theme: ClioTheme, token: ClioToken, label: string, pad = 0): string {
	const text = pad > 0 ? label.padEnd(pad) : label;
	return theme.style(token, text, { bold: true });
}

/** A single colored chip. */
export function chip(theme: ClioTheme, token: ClioToken, text: string): string {
	return theme.fg(token, text);
}

/** A key=value chip: a dim key glued to a colored value (e.g. `git main`). */
/** Subtle keybinding affordance, e.g. `⌃U dashboard`. */
/** Join chips within a section with a dim middot, dropping empties. */
export function joinChips(theme: ClioTheme, parts: ReadonlyArray<string | null | undefined>): string {
	return present(parts).join(dotSep(theme));
}

/** Join sections on one row with a frame bar, dropping empties. */
export function joinSections(theme: ClioTheme, parts: ReadonlyArray<string | null | undefined>): string {
	return present(parts).join(barSep(theme));
}
