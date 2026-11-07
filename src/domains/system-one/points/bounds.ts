/**
 * Bounding helpers shared by the points. Every state a point sends is capped by
 * code points so evidence has a known size, and so an engine with a small window
 * never truncates the part that matters.
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
 * A noul's number, or null for another type, an abstention or malformed mass. What
 * the number is stays on `answer.readout`; a point that needs a real probability
 * says so in `requires` and is never routed to an engine that lacks it.
 */
export function probability(answer: Answer | undefined): number | null {
	if (answer === undefined || answer.type !== "noul" || answer.noul === undefined) return null;
	return Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1 ? answer.noul : null;
}

/** Two decimals, the precision the ledger keeps. */
export function round2(value: number): number {
	return Math.round(value * 100) / 100;
}
