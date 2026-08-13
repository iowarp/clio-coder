import { GLYPH } from "./glyphs.js";
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

/**
 * The Clio logotype: the `>C_` wordmark composed from the tokens the system
 * already assigns to its three characters. `>` and `_` are terminal
 * scaffolding and render dim; `C` is Clio and renders bold accent. GLYPH.brand
 * keeps the plain string for width math and ANSI-stripping tests, and the
 * welcome header and dashboard header stay the only surfaces that paint it.
 */
export function brandMark(theme: ClioTheme): string {
	const prompt = GLYPH.brand.slice(0, 1);
	const initial = GLYPH.brand.slice(1, 2);
	const cursor = GLYPH.brand.slice(2, 3);
	return `${theme.fg("dim", prompt)}${theme.style("accent", initial, { bold: true })}${theme.fg("dim", cursor)}`;
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

/**
 * A screen or overlay title (section 2.4 level 2): bold in the `title` token.
 *
 * The settings lane header, the settings breadcrumb, and the dispatch card
 * title each open-coded `theme.style("title", text, { bold: true })`, so the
 * one rule for what a title looks like lived in as many places as there were
 * titles. `rules.ts:frame` applies the same treatment to an unstyled title it
 * is handed, which is why an island does not call this.
 */
export function screenTitle(theme: ClioTheme, label: string): string {
	return theme.style("title", label, { bold: true });
}

/**
 * A list-group header (section 2.4 level 4): `── running (1)` in dim.
 *
 * The leading double dash is a structural rule literal, not a status glyph.
 * Fleet Runs kept a private copy and the generic list overlay inlined the same
 * string, so a change to the group vocabulary had to be made twice and was not.
 */
export function listGroupHeader(theme: ClioTheme, label: string): string {
	return theme.fg("dim", `── ${label}`);
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
