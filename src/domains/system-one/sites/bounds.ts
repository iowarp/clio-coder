/**
 * Bounding helpers shared by the sites. Every state a site sends is capped by
 * code points so a fitted cut was measured on evidence of a known size, and so
 * an engine with a small window never truncates the part that matters.
 */

import type { Answer } from "../types.js";

/**
 * The code points at one end of `text`, enough to tell whether it holds more
 * than `max`. A code point is at most two code units, so `2 × max + 2` units
 * always hold `max + 1` whole points; a pasted log or heredoc is otherwise
 * spread into an array of millions on the pre-turn path.
 */
function endPoints(text: string, max: number, end: "head" | "tail"): string[] {
	const units = 2 * max + 2;
	if (text.length <= units) return [...text];
	return [...(end === "head" ? text.slice(0, units) : text.slice(text.length - units))];
}

/** Whitespace collapsed, head kept: a request's opening is what it asked for. */
export function boundedHead(value: string, maxCodePoints: number): string {
	const points = endPoints(value.replace(/\s+/g, " ").trim(), maxCodePoints, "head");
	return points.length <= maxCodePoints ? points.join("") : `${points.slice(0, maxCodePoints - 1).join("")}…`;
}

/** Whitespace collapsed, tail kept: the ending of a message carries what it asks or announces. */
export function boundedTail(value: string, maxCodePoints: number): string {
	const points = endPoints(value.replace(/\s+/g, " ").trim(), maxCodePoints, "tail");
	return points.length <= maxCodePoints
		? points.join("")
		: `…${points.slice(points.length - maxCodePoints + 1).join("")}`;
}

/**
 * Tail kept with its line structure. A bulleted list is the difference between
 * a menu the operator must pick from and a sentence that happens to contain
 * dashes, so a message read for what it asks keeps its newlines. Runs of blank
 * lines and of spaces collapse.
 */
export function boundedTailLines(value: string, maxCodePoints: number): string {
	const points = endPoints(
		value
			.replace(/[ \t]+/g, " ")
			.replace(/ ?\n ?/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
		maxCodePoints,
		"tail",
	);
	return points.length <= maxCodePoints
		? points.join("")
		: `…${points.slice(points.length - maxCodePoints + 1).join("")}`;
}

/**
 * The text with fenced code removed. A fenced block is file content or command
 * output an assistant quoted, which is repository text a site must not read as
 * the operator's intent or the assistant's own claim. Backtick and tilde fences
 * of any length that open a line are cut through the matching closing line, and
 * a fence left open runs to the end.
 */
export function withoutQuotedCode(text: string): string {
	return text.replace(/(^|\n)[ \t]{0,3}(`{3,}|~{3,})[\s\S]*?(?:\n[ \t]{0,3}\2[`~]*[ \t]*(?=\n|$)|$)/g, "$1");
}

/**
 * A noul's probability, or null for another type, an abstention, malformed mass,
 * or mass that is not a calibrated probability. Every hint, gate and act reads a
 * noul through here, so a vote fraction or a one-order readout never crosses a
 * fitted cut. The dataset still keeps the raw answer.
 */
export function probability(answer: Answer | undefined): number | null {
	if (answer === undefined || answer.type !== "noul" || answer.noul === undefined || !answer.calibrated) return null;
	return Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1 ? answer.noul : null;
}

/** Two decimals, the precision the ledger keeps. */
export function round2(value: number): number {
	return Math.round(value * 100) / 100;
}
