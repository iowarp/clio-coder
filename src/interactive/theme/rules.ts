import { truncateToWidth, visibleWidth } from "../../engine/tui.js";
import { GLYPH } from "./glyphs.js";
import type { ClioTheme, ClioToken } from "./tokens.js";

/**
 * Pad or clip a styled string to exactly `width` visible columns.
 *
 * `truncateToWidth(…, pad = true)` already returns a string of exactly `width`
 * columns on both its paths: it appends the shortfall on the fits path and pads
 * through its own finalizer on the cut path. Measuring the result again to
 * compute a repeat count that is always zero cost ~24 µs per line whenever the
 * string missed pi-tui's width cache, which is every footer line that carries a
 * spinner frame or an elapsed time.
 */
export function padAnsi(text: string, width: number, ellipsis = ""): string {
	return truncateToWidth(text, Math.max(0, width), ellipsis, true);
}

/**
 * Join `units` onto `prefix` with the ` · ` separator, fitting the result to
 * `maxWidth` without cutting a unit mid-glyph. A unit that would overflow is
 * dropped whole, along with every later unit, and the line closes with one
 * space plus a dim ellipsis. Two columns are reserved for that marker while
 * placing every unit except the last. When even the first unit cannot fit,
 * `prefix + first unit` is hard-truncated with an ellipsis so a one-unit line
 * still marks its cut. Width accounting is ANSI-aware via visibleWidth.
 */
export function fitUnits(theme: ClioTheme, prefix: string, units: readonly string[], maxWidth: number): string {
	const sep = " · ";
	let line = prefix;
	for (let index = 0; index < units.length; index += 1) {
		const candidate = index === 0 ? `${line}${units[index]}` : `${line}${sep}${units[index]}`;
		// Reserve two columns for the ` …` marker unless this is the last unit.
		const reserve = index < units.length - 1 ? 2 : 0;
		if (visibleWidth(candidate) + reserve > maxWidth) {
			if (index === 0) return truncateToWidth(candidate, Math.max(0, maxWidth), "…", false);
			return `${line} ${theme.fg("dim", "…")}`;
		}
		line = candidate;
	}
	return line;
}

export interface RuleOptions {
	left?: string;
	right?: string;
	fillToken?: ClioToken;
	rightToken?: ClioToken;
	rightRaw?: boolean;
	rightTail?: string;
}

export function rule(theme: ClioTheme, width: number, options: RuleOptions = {}): string {
	const safeWidth = Math.max(0, width);
	if (safeWidth === 0) return "";
	// A left label starts flush at column 0, with a single trailing space before
	// the fill. There is no leading space, so labeled rules align with the frame.
	const left = options.left ? `${theme.style("accent", options.left, { bold: true })} ` : "";
	const rightBody = options.rightRaw ? options.right : theme.fg(options.rightToken ?? "muted", options.right ?? "");
	const right = options.right ? ` ${rightBody} ${options.rightTail ?? ""}` : "";
	const labelsWidth = visibleWidth(left) + visibleWidth(right);
	if (labelsWidth >= safeWidth) return truncateToWidth(`${left}${right}`.trim(), safeWidth, "", true);
	const fill = theme.style(options.fillToken ?? "frame", "─".repeat(safeWidth - labelsWidth), {
		bold: options.fillToken === "frameStrong",
	});
	return `${left}${fill}${right}`;
}

export interface FrameOptions {
	/**
	 * Dim right-hand metadata placed just before the closing corner with one
	 * space on each side. The dispatch cards pass a run's elapsed time here.
	 */
	rightMeta?: string;
}

/**
 * The one framed-island recipe for every in-flow block: the welcome dashboard,
 * the task island, the steering queue, and the dispatch cards.
 *
 * ```
 * ┌─ Title ──────────────────── meta ─┐
 * │ body line                         │
 * └───────────────────────────────────┘
 * ```
 *
 * Corners and fills carry the `frame` token. A plain `title` is drawn bold in
 * the `title` token with exactly one space on each side. A title that already
 * carries its own styling, such as the welcome header's composite of a brand
 * glyph and a dim version, is placed verbatim so its escape sequences are never
 * re-wrapped. The optional `rightMeta` renders dim before the closing corner.
 */
export function frame(
	theme: ClioTheme,
	title: string,
	lines: readonly string[],
	width: number,
	opts: FrameOptions = {},
): string[] {
	const safeWidth = Math.max(4, width);
	const contentWidth = Math.max(0, safeWidth - 4);
	const frameFg = (text: string): string => theme.fg("frame", text);

	const hasTitle = title.length > 0;
	// A title that already carries escape sequences is a pre-styled composite
	// (the welcome header's brand glyph and dim version); place it verbatim. A
	// plain title is styled here as bold in the `title` token.
	const styledTitle = !hasTitle ? "" : title.includes("\u001b") ? title : theme.style("title", title, { bold: true });
	const titleWidth = visibleWidth(title);

	const meta = opts.rightMeta ?? "";
	const hasMeta = meta.length > 0;
	const metaWidth = hasMeta ? visibleWidth(meta) : 0;

	// `┌─`, plus ` Title ` when titled, on the left; `┐`, or ` meta ─┐` when a
	// right meta is present, on the right. The fill is whatever keeps the total
	// width exact.
	const leftVisible = 2 + (hasTitle ? titleWidth + 2 : 0);
	const rightVisible = hasMeta ? metaWidth + 4 : 1;
	const fillWidth = Math.max(0, safeWidth - leftVisible - rightVisible);

	const leftStr = hasTitle ? `${frameFg("┌─")} ${styledTitle} ` : frameFg("┌─");
	const rightStr = hasMeta ? ` ${theme.fg("dim", meta)} ${frameFg("─┐")}` : frameFg("┐");
	const top = `${leftStr}${frameFg("─".repeat(fillWidth))}${rightStr}`;

	const body = lines.map((line) => `${frameFg("│")} ${padAnsi(line, contentWidth)} ${frameFg("│")}`);
	const bottom = `${frameFg("└")}${frameFg("─".repeat(safeWidth - 2))}${frameFg("┘")}`;
	return [top, ...body, bottom];
}

/**
 * A full-width run of the inner-divider glyph in the `frame` token, drawn
 * between rows inside an island. Callers pass the island's inner content width.
 */
export function innerDivider(theme: ClioTheme, width: number): string {
	return theme.fg("frame", GLYPH.innerDivider.repeat(Math.max(0, width)));
}
