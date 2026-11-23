/**
 * Context occupancy for the composer rail and the footer. The composer draws
 * the rail on the first frame, so this stays a leaf: it reaches the meter and
 * bar renderers and type-only accounting shapes, never the footer dashboard
 * and the task, dispatch and worker modules behind it (Stage 0 bundle).
 */

import { asciiOnly, colorDisabled, nerdFontEnabled } from "../../core/terminal-preferences.js";
import type { LiveBudgetView } from "../../domains/context/budget/live-view.js";
import type { ContextUsageBreakdown } from "../../domains/session/context-accounting.js";
import type { ContextLedger } from "../../domains/session/context-ledger.js";
import { visibleWidth } from "../../engine/tui.js";
import { buildSegmentedContextBar, finiteNonNegative } from "../context-bar.js";
import { contextPercentRole, renderContextMeterBar } from "../context-meter.js";
import { type ClioTheme, GLYPH } from "../theme/index.js";
import { formatCount } from "../theme/labels.js";

/** The published numbers an occupancy reading needs. */
export interface ContextOccupancyFacts {
	/** Identifies the published accounting used by the meter; ledger stays diagnostic. */
	budget?: Pick<LiveBudgetView, "revision" | "historical" | "inputSource">;
	used: number | null;
	contextWindow: number | null;
	toolSchemaTokens: number | null;
	breakdown?: ContextUsageBreakdown | null;
	ledger?: ContextLedger | null;
}

export function contextBreakdownForBar(context: ContextOccupancyFacts): ContextUsageBreakdown | undefined {
	const reportedUsed = finiteNonNegative(context.used);
	const toolTokens = finiteNonNegative(context.toolSchemaTokens);
	const source = context.breakdown;
	if (!source) {
		if (reportedUsed <= 0 && toolTokens <= 0) return undefined;
		return {
			systemPromptTokens: 0,
			toolSchemaTokens: Math.min(toolTokens, reportedUsed),
			messageTokens: Math.max(0, reportedUsed - toolTokens),
			pendingUserTokens: 0,
		};
	}
	const system = finiteNonNegative(source.systemPromptTokens);
	const tools = finiteNonNegative(source.toolSchemaTokens);
	const conversation = finiteNonNegative(source.messageTokens) + finiteNonNegative(source.pendingUserTokens);
	const total = system + tools + conversation;
	if (reportedUsed <= 0 || total <= 0) {
		return {
			systemPromptTokens: system,
			toolSchemaTokens: tools,
			messageTokens: conversation,
			pendingUserTokens: 0,
		};
	}
	if (reportedUsed >= total) {
		return {
			systemPromptTokens: system,
			toolSchemaTokens: tools,
			messageTokens: conversation + (reportedUsed - total),
			pendingUserTokens: 0,
		};
	}
	const scale = reportedUsed / total;
	return {
		systemPromptTokens: system * scale,
		toolSchemaTokens: tools * scale,
		messageTokens: conversation * scale,
		pendingUserTokens: 0,
	};
}

/** The share of the window `contextUsageText` states, in percent; null when either number is unknown. */
function contextUsagePercent(context: ContextOccupancyFacts): number | null {
	const used = context.budget ? context.used : (context.ledger?.usedTokens ?? context.used);
	const window = context.budget ? context.contextWindow : (context.ledger?.contextWindow ?? context.contextWindow);
	return used === null || !window ? null : (used / window) * 100;
}

/** Reads published numbers only; never refreshes accounting from a renderer. */
function contextOccupancyBar(
	context: ContextOccupancyFacts,
	cells: number,
	theme: ClioTheme,
	includePercent = true,
): string {
	if (!context.budget && context.ledger) return renderContextMeterBar(context.ledger, cells, theme);
	return buildSegmentedContextBar(
		theme,
		cells,
		context.contextWindow ?? 0,
		context.used === null ? undefined : contextBreakdownForBar(context),
		includePercent,
	);
}

/** The fill word beside the tone change (2.7): `high` from 80 percent, `full` from 95. */
function contextFillWord(percent: number | null): "high" | "full" | null {
	if (percent === null || !Number.isFinite(percent)) return null;
	return percent >= 95 ? "full" : percent >= 80 ? "high" : null;
}

/**
 * Where the reading came from, in the words `contextUsageText` uses: a restored session's saved figure, a live
 * estimate, or a measured reading, which needs no word.
 */
export function contextReadingQualifier(context: Pick<ContextOccupancyFacts, "budget" | "used">): string {
	if (context.budget?.inputSource === "historical") return "saved";
	return context.budget?.inputSource === "estimated" && context.used !== null ? GLYPH.estimate : "";
}

/** A whole percent: the rail has no room for tenths, and a fill under one percent is not zero. */
function railPercent(percent: number): string {
	const whole = Math.round(percent);
	return percent > 0 && whole === 0 ? "<1%" : `${whole}%`;
}

/** How much of the context unit is drawn: the bar's cells (0 for none) and whether the `used/window` pair shows. */
export interface ContextRailForm {
	bar: number;
	pair: boolean;
}

/**
 * The context unit after its `ctx` word: bar, the source qualifier with the pair or the percent, the percent and the
 * fill word (`▰▱▱▱▱▱ saved 16.8k/272k 6%`, `▰▰▰▰▰▱ saved 82% high`). Before the first measured turn it is the window
 * alone (`272k`), with no bar and no percent; with neither figure known it is empty.
 */
function contextRailBody(context: ContextOccupancyFacts, theme: ClioTheme, form: ContextRailForm): string {
	const used = context.budget ? context.used : (context.ledger?.usedTokens ?? context.used);
	const window = context.budget ? context.contextWindow : (context.ledger?.contextWindow ?? context.contextWindow);
	if (used === null) return window ? theme.fg("counter", formatCount(window)) : "";
	const percent = contextUsagePercent(context);
	if (percent === null || !window) return theme.fg("counter", `${formatCount(used)} used`);
	const role = contextPercentRole(percent);
	const qualifier = contextReadingQualifier(context);
	// `saved` is a word and takes a space; `≈` binds to the figure it qualifies.
	const qualified = (figure: string): string =>
		qualifier === "" ? figure : `${theme.fg("annotation", qualifier)}${qualifier === GLYPH.estimate ? "" : " "}${figure}`;
	const word = contextFillWord(percent);
	const figures = form.pair
		? [
				qualified(theme.fg("counter", `${formatCount(used)}/${formatCount(window)}`)),
				theme.fg(role, railPercent(percent)),
			]
		: [qualified(theme.fg(role, railPercent(percent)))];
	return [
		form.bar > 0 ? contextOccupancyBar(context, form.bar, theme, false) : "",
		...figures,
		word === null ? "" : theme.fg(role, word),
	]
		.filter(Boolean)
		.join(" ");
}

/** The whole context unit as the bottom rail states it: `ctx ▰▱▱▱▱▱ 6%`, `ctx 4%`, `ctx 272k`; empty when nothing is known. */
export function contextRailUnit(context: ContextOccupancyFacts, theme: ClioTheme, form: ContextRailForm): string {
	const body = contextRailBody(context, theme, form);
	return body ? `${theme.fg("annotation", "ctx")} ${body}` : "";
}

/** What the thinking unit is drawn from; the shape of the editor chrome's `getThinking`. */
export interface ThinkingRailFacts {
	label: string;
	hasLevels: boolean;
	supportedLevels?: readonly string[];
	/** Why the level differs from the one asked for; the labelled form states it when it fits. */
	note?: string;
	/** Nothing to say: the route has no reasoning control. */
	quiet?: boolean;
}

const THINKING_MARKS: Readonly<Record<string, number>> = {
	off: 0,
	minimal: 1,
	low: 1,
	medium: 2,
	high: 3,
	xhigh: 4,
	max: 4,
	ultra: 4,
};
const THINKING_MARK_SLOTS = 4;

/**
 * The thinking unit in one of its forms, widest first: the level word labelling its four marks (`low ● ○ ○ ○`), the
 * labelled word (`think low`) and the word alone (`low`). Where the marks cannot draw (no level list, a screen
 * reader, no color, ASCII) the marks form is the labelled word, as before. Null when the route says nothing.
 */
export function thinkingRailUnit(
	theme: ClioTheme,
	thinking: ThinkingRailFacts,
	form: "marks" | "labelled" | "word",
): string | null {
	if (thinking.quiet) return null;
	const level = thinking.label;
	if (form === "word") return theme.fg("thinkingLevel", level);
	const labelled = `think ${level}`;
	if (thinking.note) {
		return theme.fg("thinkingLevel", form === "marks" ? `${labelled} (${thinking.note})` : labelled);
	}
	const levels = thinking.supportedLevels ?? [];
	const count = Object.hasOwn(THINKING_MARKS, level) ? THINKING_MARKS[level] : undefined;
	if (
		form === "labelled" ||
		!thinking.hasLevels ||
		levels.length === 0 ||
		count === undefined ||
		(level !== "off" && !levels.includes(level)) ||
		process.env.CLIO_CODER_SCREEN_READER === "1" ||
		colorDisabled() ||
		asciiOnly()
	)
		return theme.fg("thinkingLevel", labelled);
	const glyph = nerdFontEnabled() ? GLYPH.brain : GLYPH.running;
	const activeRole = level === "max" || level === "ultra" ? "thinkingMaximum" : "thinkingActive";
	const marks = Array.from({ length: THINKING_MARK_SLOTS }, (_, index) =>
		theme.fg(index < count ? activeRole : "thinkingInactive", index < count || nerdFontEnabled() ? glyph : "○"),
	).join(" ");
	return `${theme.fg("thinkingLevel", level)} ${marks}`;
}

/** Below this many cells a surface is in the survival class (W1): the rail keeps its last units and draws no bar. */
const RAIL_SURVIVAL_WIDTH = 44;
/** From this many cells (W4) the context unit adds its `used/window` pair. */
const RAIL_PAIR_WIDTH = 112;

/**
 * The bottom rail's status group, context and thinking, fitted to `room` cells on a terminal `width` columns wide.
 * Context outranks thinking, and units leave in the order of 4.1: the `used/window` pair, the thinking marks (the word
 * stays), the bar, the thinking word. With the bar gone the word takes back its label, since `4% · low` would read as
 * a second fill reading. `ctx N%` is the last thing standing; empty when not even that fits.
 */
export function contextRailGroup(
	theme: ClioTheme,
	facts: { context: ContextOccupancyFacts | undefined; thinking: ThinkingRailFacts | undefined },
	room: number,
	width: number,
): string {
	const cells = width >= 100 ? 10 : 6;
	const survival = width < RAIL_SURVIVAL_WIDTH;
	type Form = { context: ContextRailForm; thinking: "marks" | "labelled" | "word" | null };
	const bar = (thinking: Form["thinking"], pair = false): Form => ({ context: { bar: cells, pair }, thinking });
	const bare = (thinking: Form["thinking"]): Form => ({ context: { bar: 0, pair: false }, thinking });
	const forms: Form[] = [
		...(survival ? [] : [...(width >= RAIL_PAIR_WIDTH ? [bar("marks", true)] : []), bar("marks"), bar("word")]),
		bare("labelled"),
		bare(null),
	];
	const separator = theme.fg("separator", ` ${GLYPH.dot} `);
	const context = facts.context;
	if (!context || !contextRailUnit(context, theme, { bar: 0, pair: false })) {
		// Thinking alone: a bare `low` would name nothing, so the word keeps its label.
		for (const form of ["marks", "labelled"] as const) {
			const thinking = facts.thinking ? thinkingRailUnit(theme, facts.thinking, form) : null;
			if (thinking && visibleWidth(thinking) <= room) return thinking;
		}
		return "";
	}
	for (const { context: form, thinking: thinkingForm } of forms) {
		const unit = contextRailUnit(context, theme, form);
		const thinking = facts.thinking && thinkingForm ? thinkingRailUnit(theme, facts.thinking, thinkingForm) : null;
		const group = [unit, thinking ?? ""].filter(Boolean).join(separator);
		if (visibleWidth(group) <= room) return group;
	}
	return "";
}
