import { wrapTextWithAnsi } from "../../engine/tui.js";
import type { PromptReferenceCard } from "../slash-commands.js";
import { clioTheme, GLYPH } from "../theme/index.js";

/** Matches the transcript's prose gutter so the card's body aligns with turns. */
const CARD_GUTTER = "  ";
const TAB_WIDTH = 4;

/**
 * An operator card: a header naming the command and where it came from, then
 * the body wrapped to the width with nothing cut. Box-drawing rows that outrun
 * the width fold onto a second row rather than losing their tail, which is the
 * one rendering rule the card exists for: the words that carry the information
 * are at the ends of the sentences.
 */
export function renderReferenceCard(card: PromptReferenceCard, width: number): string[] {
	const theme = clioTheme();
	const safeWidth = Math.max(8, width);
	const header = `${theme.fg("dim", GLYPH.user)} ${theme.style("title", `/${card.command}`, { bold: true })}  ${theme.fg(
		"dim",
		`reference · ${card.source}`,
	)}`;
	const lines = wrapTextWithAnsi(header, safeWidth);
	const bodyWidth = Math.max(4, safeWidth - CARD_GUTTER.length);
	for (const raw of card.text.split("\n")) {
		const expanded = raw.replace(/\t/g, " ".repeat(TAB_WIDTH)).trimEnd();
		if (expanded.length === 0) {
			lines.push("");
			continue;
		}
		for (const wrapped of wrapTextWithAnsi(expanded, bodyWidth)) lines.push(`${CARD_GUTTER}${wrapped}`);
	}
	lines.push("");
	return lines;
}
