import type { ContextOperation } from "../../core/context-operation.js";
import { wrapTextWithAnsi } from "../../engine/tui.js";
import {
	CONTEXT_KIND_TITLES,
	compactionQualifier,
	factRow,
	outcomeTone,
	outcomeWord,
	plain,
	splitWarnings,
	tokenRow,
} from "../context-operation-view.js";
import { clioTheme, formatCompactMs, frame, GLYPH } from "../theme/index.js";

/**
 * Live and resumed cards share the terminal explanation as well as measured
 * facts, so settling the live rail does not lose an unchanged result (D6g).
 */
export function renderContextOperationResult(operation: ContextOperation, width: number): string[] {
	const theme = clioTheme();
	const outcome = operation.outcome ?? "completed";
	const tone = outcomeTone(outcome);
	const glyph = outcome === "failed" ? GLYPH.error : outcome === "cancelled" ? GLYPH.warn : GLYPH.ok;
	// An operator command is its own reason. An automatic run names why it ran.
	const reason = operation.origin === "automatic" ? ` · ${plain(operation.reason)}` : "";
	const state = outcome === "completed" ? "" : ` · ${outcomeWord(outcome)}`;
	const title = `${theme.fg(tone, glyph)} ${theme.fg("contextAction", CONTEXT_KIND_TITLES[operation.kind])}${theme.fg("annotation", `${reason}${compactionQualifier(operation)}${state}`)}`;

	const room = Math.max(1, width - 4);
	const body: string[] = [];
	const conclusion =
		operation.kind === "compaction"
			? operation.conclusion
					?.replace(
						"summary would not reduce context (usage recorded)",
						"compaction would not reduce context; checkpoint discarded (usage recorded)",
					)
					.replace("nothing to summarize", "no older history can be summarized yet")
			: operation.conclusion;
	// A pre-summary reduction can complete even when the summary itself has no
	// gain. Its discarded-checkpoint receipt still belongs on the card (D6g).
	if (
		conclusion &&
		(outcome === "unchanged" ||
			conclusion.includes("checkpoint discarded (usage recorded)") ||
			conclusion.includes("no older history can be summarized yet"))
	) {
		for (const line of wrapTextWithAnsi(plain(conclusion), room)) body.push(theme.fg("body", line));
	}
	const { cause, warnings } = splitWarnings(operation);
	if (cause) {
		for (const line of wrapTextWithAnsi(cause, room)) body.push(theme.fg(tone, line));
	}
	for (const fact of operation.facts ?? []) {
		const row = factRow(fact, operation.outcome);
		const lines = wrapTextWithAnsi(`${row.head}${row.tail}`, room);
		// Wrapping runs on plain text so a style never spans a break. The dim
		// path tail only applies when the statement stays on one row.
		if (lines.length === 1) body.push(`${theme.fg("body", row.head)}${theme.fg("toolMetadata", row.tail)}`);
		else for (const line of lines) body.push(theme.fg("body", line));
	}
	const tokens = tokenRow(operation);
	if (tokens) body.push(theme.fg("body", tokens));
	for (const warning of warnings) {
		for (const [index, line] of wrapTextWithAnsi(warning, Math.max(1, room - 2)).entries()) {
			body.push(
				index === 0 ? `${theme.fg("warning", GLYPH.warn)} ${theme.fg("body", line)}` : `  ${theme.fg("body", line)}`,
			);
		}
	}
	if (body.length === 0) body.push(theme.fg("annotation", "No changes."));
	return frame(theme, title, body, width, {
		...(operation.elapsedMs !== undefined ? { rightMeta: formatCompactMs(operation.elapsedMs) } : {}),
	});
}
