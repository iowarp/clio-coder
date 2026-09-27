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

/** Compact terminal mark: cyan surrounds the copper C of the Clio identity. */
export function brandMark(theme: ClioTheme): string {
	const prompt = GLYPH.brand.slice(0, 1);
	const initial = GLYPH.brand.slice(1, 2);
	const cursor = GLYPH.brand.slice(2, 3);
	return `${theme.fg("wordmark", prompt)}${theme.style("brandCopper", initial, { bold: true })}${theme.fg("wordmark", cursor)}`;
}

/** Quiet structural middot used to separate chips inside a single section. */
export function dotSep(theme: ClioTheme): string {
	return theme.fg("divider", " · ");
}

/** Frame-colored vertical bar used to separate sections on one row. */
export function barSep(theme: ClioTheme): string {
	return theme.fg("border", " │ ");
}

/**
 * A semantic section label (PERCEIVE / target / …). Pad to align a
 * column of tags; padding inherits the tag color but stays invisible.
 */
export function sectionTag(theme: ClioTheme, token: ClioToken, label: string, pad = 0): string {
	const text = pad > 0 ? label.padEnd(pad) : label;
	return theme.style(token, text, { bold: true });
}

/** Concise orange title; machine sections use the stronger harness-heading role. */
export function screenTitle(theme: ClioTheme, label: string): string {
	return theme.style("heading", label, { bold: true });
}

/**
 * A readable list-group heading: `── running (1)`.
 *
 * The leading double dash is a structural rule literal, not a status glyph.
 * Fleet Runs kept a private copy and the generic list overlay inlined the same
 * string, so a change to the group vocabulary had to be made twice and was not.
 */
export function listGroupHeader(theme: ClioTheme, label: string): string {
	return theme.fg("groupHeading", `── ${label}`);
}

/** Join chips with a quiet structural middot, dropping empties. */
export function joinChips(theme: ClioTheme, parts: ReadonlyArray<string | null | undefined>): string {
	return present(parts).join(dotSep(theme));
}

/** A quantity and its unit remain distinct even when they share a compact row. */
export function metricText(theme: ClioTheme, value: string, unit: string): string {
	return `${theme.fg("metricValue", value)} ${theme.fg("metricUnit", unit)}`;
}
