import type { ContextOperation } from "../../core/context-operation.js";
import { tierPolicy } from "../../core/presentation-tier.js";
import { wrapTextWithAnsi } from "../../engine/tui.js";
import { COMPACTION_LINE_LEAD } from "../../session-control/compaction-lines.js";
import { cardRail } from "../card.js";
import {
	CONTEXT_KIND_TITLES,
	compactionQualifier,
	factRow,
	outcomeTone,
	outcomeWord,
	plain,
	splitWarnings,
} from "../context-operation-view.js";
import { clioTheme, fitSides, formatCount, formatElapsed, GLYPH, type SideUnit } from "../theme/index.js";
import { presentProviderError } from "./provider-error.js";

/** Drop ranks of the card row, first to go first: the elapsed time, then the percent, then an automatic run's reason. */
const DROP_ELAPSED = 1;
const DROP_PERCENT = 2;
const DROP_REASON = 3;

/**
 * The transcript card for a settled context operation: one card row, then body rows on the rail. Live results and
 * resumed sessions both render it from the same persisted operation, so the two cannot disagree about what happened.
 * The card row is the outcome's glyph, the title, an automatic run's reason, the outcome word and the figures; the
 * cause of a failure and every warning are body rows at every tier, a compaction's measured facts join from standard
 * and its summary notice from detailed.
 */
export function renderContextOperationResult(operation: ContextOperation, width: number): string[] {
	const theme = clioTheme();
	const policy = tierPolicy();
	const outcome = operation.outcome ?? "completed";
	const tone = outcomeTone(outcome);
	const glyph = outcome === "failed" ? GLYPH.error : outcome === "cancelled" ? GLYPH.cancelled : GLYPH.ok;
	const annotation = (text: string): string => theme.fg("annotation", text);
	const units: SideUnit[] = [
		{ text: glyph, paint: (text) => theme.fg(tone, text), lead: true },
		{ text: CONTEXT_KIND_TITLES[operation.kind], paint: (text) => theme.fg("contextAction", text) },
	];
	// An operator command is its own reason. An automatic run names why it ran.
	if (operation.origin === "automatic") {
		units.push({ text: plain(operation.reason), paint: annotation, drop: DROP_REASON });
	}
	const qualifier = compactionQualifier(operation).replace(/^ · /u, "");
	if (qualifier.length > 0) units.push({ text: qualifier, paint: annotation });
	if (outcome !== "completed") units.push({ text: outcomeWord(outcome), paint: (text) => theme.fg(tone, text) });
	units.push(...figureUnits(operation, annotation));
	if (operation.elapsedMs !== undefined) {
		units.push({ text: formatElapsed(operation.elapsedMs), paint: annotation, drop: DROP_ELAPSED });
	}
	const head = fitSides(theme, units, [], Math.max(1, width)).replace(/ +$/u, "");

	const failed = outcome === "failed";
	const rail = cardRail(failed);
	const room = Math.max(1, width - 4);
	const body: string[] = [];
	const { cause, warnings } = splitWarnings(operation);
	if (cause) {
		for (const line of wrapTextWithAnsi(failureWords(cause, operation.outcome), room)) body.push(theme.fg(tone, line));
	}
	// A compaction's facts explain how its figures came about; another operation's facts are its result.
	if (operation.kind !== "compaction" || policy.contextBodyFacts) {
		for (const fact of operation.facts ?? []) {
			const row = factRow(fact, operation.outcome);
			const lines = wrapTextWithAnsi(`${row.head}${row.tail}`, room);
			// Wrapping runs on plain text so a style never spans a break. The dim
			// path tail only applies when the statement stays on one row.
			if (lines.length === 1) body.push(`${theme.fg("body", row.head)}${theme.fg("toolMetadata", row.tail)}`);
			else for (const line of lines) body.push(theme.fg("body", line));
		}
	}
	const notice = policy.contextBodyDetail ? noticeWords(operation.notice) : null;
	if (notice !== null) for (const line of wrapTextWithAnsi(notice, room)) body.push(theme.fg("body", line));
	for (const warning of warnings) {
		for (const [index, line] of wrapTextWithAnsi(warning, Math.max(1, room - 2)).entries()) {
			body.push(
				index === 0 ? `${theme.fg("warning", GLYPH.warn)} ${theme.fg("body", line)}` : `  ${theme.fg("body", line)}`,
			);
		}
	}
	return [head, ...body.map((line) => `${rail}${line}`)];
}

/**
 * `before → after tokens` and the percent, only when both figures are known and after is smaller. A run that left the
 * context as large says `no reduction`, an unchanged one the size it stayed at; unknown figures say nothing.
 */
function figureUnits(operation: ContextOperation, paint: (text: string) => string): SideUnit[] {
	const tokens = operation.tokens;
	if (tokens === undefined) return [];
	if (operation.outcome === "unchanged") return [{ text: `${formatCount(tokens.after)} tokens`, paint }];
	if (tokens.after >= tokens.before) return [{ text: "no reduction", paint }];
	const units: SideUnit[] = [
		{ text: `${formatCount(tokens.before)} ${GLYPH.next} ${formatCount(tokens.after)} tokens`, paint },
	];
	const percent = Math.round(((tokens.before - tokens.after) / tokens.before) * 100);
	if (percent > 0) units.push({ text: `−${percent}%`, paint, drop: DROP_PERCENT });
	return units;
}

/** The summary notice without the figures the card row already states: `35 earlier messages now read as one summary`. */
function noticeWords(notice: string | undefined): string | null {
	if (notice === undefined) return null;
	const text = plain(notice);
	if (!text.startsWith(COMPACTION_LINE_LEAD)) return text.length > 0 ? text : null;
	const colon = text.indexOf(": ");
	const words = colon < 0 ? text : text.slice(colon + 2);
	return words.length > 0 ? words.replace(/^./u, (letter) => letter.toUpperCase()) : null;
}

const FAILURE_PREFIXES = /^(?:(?:auto-)?compaction failed: )?(?:compaction stream failed: )?/u;

/**
 * A failed compaction's cause in the words a provider failure gets everywhere else. The raw cause stacked two prefixes
 * on a JSON body (`compaction failed: compaction stream failed: 401: {"message":…}`).
 */
function failureWords(cause: string, outcome: string | undefined): string {
	if (outcome !== "failed") return cause;
	const raw = cause.replace(FAILURE_PREFIXES, "");
	return `The summary request failed: ${presentProviderError(raw)}`;
}
