import type { OutputStyle } from "../../core/defaults.js";
import { wrapTextWithAnsi } from "../../engine/tui.js";
import type { PromptReferenceCard } from "../../session-control/slash-commands.js";
import { CARD_GUTTER, cardHead } from "../card.js";
import { clioTheme, GLYPH } from "../theme/index.js";
import { renderTranscriptReport, transcriptReportFromText } from "./report.js";

const TAB_WIDTH = 4;

/**
 * An operator card: a header naming the command and where it came from, then
 * the body wrapped to the width with nothing cut. Box-drawing rows that outrun
 * the width fold onto a second row rather than losing their tail, which is the
 * one rendering rule the card exists for: the words that carry the information
 * are at the ends of the sentences.
 */
export function renderReferenceCard(
	card: PromptReferenceCard,
	width: number,
	style: OutputStyle = "standard",
	unbounded = false,
): string[] {
	if (card.kind === "result")
		return renderTranscriptReport(
			transcriptReportFromText(card.text, `/${card.command} ${GLYPH.dot} ${card.source}`),
			width,
			style,
			unbounded,
		);
	const theme = clioTheme();
	const safeWidth = Math.max(8, width);
	const header = `${theme.fg("toolMetadata", GLYPH.user)} ${theme.style("toolAction", `/${card.command}`, { bold: true })}  ${theme.fg(
		"toolMetadata",
		`${card.kind ?? "reference"} ${GLYPH.dot} ${card.source}`,
	)}`;
	const lines = cardHead(header, "", safeWidth);
	const bodyWidth = Math.max(4, safeWidth - CARD_GUTTER.length);
	for (const raw of card.text.split("\n")) {
		const expanded = raw.replace(/\t/g, " ".repeat(TAB_WIDTH)).trimEnd();
		if (expanded.length === 0) {
			lines.push("");
			continue;
		}
		for (const wrapped of wrapTextWithAnsi(expanded, bodyWidth))
			lines.push(`${CARD_GUTTER}${theme.base("body", wrapped)}`);
	}
	lines.push("");
	return lines;
}
