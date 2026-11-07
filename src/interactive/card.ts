/**
 * The card primitive: one geometry for every block the TUI draws about a
 * piece of work (a tool call, an approval, a question, a diff, a notice).
 * The contract, with the per-tier table, is "Cards" in
 * docs/architecture/tui-design.md.
 *
 * Inline card:
 *
 *   <mark> <verb> <object> · <facts>  <status>   head: hanging wrap, status atomic
 *     │ <section rows>                           body: rail + budgeted sections
 *     │ … 12 more lines · /view                  cut hint inside the rail
 */
import { visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import { clioTheme, releaseSpaces } from "./theme/index.js";
import type { SemanticRole } from "./theme/tokens.js";

/** The gutter: a mark cell and a space. */
const CARD_GUTTER_WIDTH = 2;
/** The body rail `  │ `: the gutter's width of indent, the bar and a space. */
const CARD_RAIL_WIDTH = 4;
const GUTTER = " ".repeat(CARD_GUTTER_WIDTH);

/** The body rail, red on a failed card so the whole block reads as the failure. */
export function cardRail(error = false): string {
	return `${GUTTER}${clioTheme().fg(error ? "error" : "gutter", "│ ")}`;
}

/** Columns a body row has after the rail. */
function cardBodyWidth(width: number): number {
	return Math.max(1, width - CARD_RAIL_WIDTH);
}

/** One logical body line, wrapped inside the rail. */
export function cardRows(line: string, width: number, error = false, token: SemanticRole = "toolSummary"): string[] {
	const theme = clioTheme();
	const rail = cardRail(error);
	return wrapTextWithAnsi(line, cardBodyWidth(width)).map((row) => `${rail}${theme.base(token, releaseSpaces(row))}`);
}

/**
 * A head row with a hanging indent: the mark keeps the gutter and every
 * continuation starts in the content column, so a long command never wraps
 * back to column 0 where it would read as the next card.
 */
function hangingRows(lead: string, width: number, token: SemanticRole): string[] {
	const theme = clioTheme();
	if (visibleWidth(lead) <= width) return [theme.base(token, releaseSpaces(lead))];
	return wrapTextWithAnsi(lead, Math.max(1, width - CARD_GUTTER_WIDTH)).map((row, index) =>
		theme.base(token, releaseSpaces(index === 0 ? row : `${GUTTER}${row}`)),
	);
}

/**
 * The head of a card: `lead` (mark, verb, object, facts) wraps; `tail`
 * (status glyph, duration, offload) is one unit that never splits. It joins
 * the lead's last row when it fits there and takes its own row only when it
 * cannot. `tail` begins with its joining space.
 */
export function cardHead(lead: string, tail: string, width: number, token: SemanticRole = "toolSummary"): string[] {
	if (tail.length === 0) return hangingRows(lead, width, token);
	if (visibleWidth(`${lead}${tail}`) <= width) return [releaseSpaces(`${lead}${tail}`)];
	const rows = hangingRows(lead, width, token);
	const last = rows[rows.length - 1];
	if (last !== undefined && visibleWidth(`${last}${tail}`) <= width) {
		rows[rows.length - 1] = releaseSpaces(`${last}${tail}`);
		return rows;
	}
	const own = wrapTextWithAnsi(tail.replace(/^ +/u, ""), Math.max(1, width - CARD_GUTTER_WIDTH));
	return [...rows, ...own.map((row) => `${GUTTER}${releaseSpaces(row)}`)];
}
