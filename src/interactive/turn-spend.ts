import { formatFooterTokens } from "../core/display-units.js";
import type { FactMetric, Quantity } from "../core/telemetry/dto.js";
import { factRef } from "../core/telemetry/dto.js";
import { factKnownValue } from "../core/telemetry/known.js";
import { COST_NOT_MEASURED, renderCompactCount } from "../core/telemetry/render.js";
import { usageCoverageLabel } from "../domains/session/usage.js";
import type { TelemetryView } from "../domains/telemetry/contract.js";
import { type ReasoningUsageView, reasoningFromQuantity } from "./status/reasoning.js";

/**
 * One operator turn's spend as the read model folds it: the session's own calls and the worker runs the turn
 * referenced, read through the same turn-grouped quantities the footer shows, every string the canonical renderer's
 * (#434 §11.3). An unknown count reads `?` and a partial one `≥`, never a zero nothing measured.
 */
export interface TurnSpend {
	/** API calls the turn made, its workers' included; null when the count is unknown. */
	calls: number | null;
	input: string;
	output: string;
	/** Null when the provider served nothing from its prompt cache. */
	cacheRead: string | null;
	cacheWrite: string | null;
	/** The reasoning the turn's calls journaled, `≈` where Clio estimated it from the thinking they streamed. */
	reasoning: ReasoningUsageView;
	/** Null when nothing could be charged. */
	cost: string | null;
	/** The calls that reported no usage or never left, or null when every call reported. */
	coverage: string | null;
	/** The same caveat for a one-row receipt, whose full wording lives in the Detailed style and /usage. */
	coverageNote: string | null;
	/** The measured token amounts a one-row receipt states plainly, or null when nothing was measured. */
	tokens: string | null;
	/** The measured prompt-cache read a one-row receipt states, or null when none was measured. */
	cached: string | null;
	/** One call's own amounts, for a turn whose sum mixes a call that was moved away from with the one that answered. */
	answer?: { tokens: string | null; cached: string | null };
}

/** The known part of a quantity: a measured or estimated value, or a sum's measured and estimated parts. */
function known(quantity: Quantity): number {
	return factKnownValue(quantity.fact);
}

function contributed(quantity: Quantity): boolean {
	const fact = quantity.fact;
	return "kind" in fact
		? fact.kind !== "absent"
		: fact.coverage.measured + fact.coverage.estimated + fact.unknownCount > 0;
}

/** Shown when it holds something other than a measured zero. */
function nonZero(quantity: Quantity): boolean {
	const fact = quantity.fact;
	return (
		contributed(quantity) &&
		("kind" in fact ? fact.kind !== "measured" || fact.value > 0 : known(quantity) > 0 || fact.unknownCount > 0)
	);
}

/**
 * The measured part of a quantity in the footer's narrow form, or null when no call measured it. A one-row receipt states
 * only this: a bound such as `≥~12.9k +?` is true but unreadable on that row, and an estimate of a call that reported
 * nothing is not usage. Detailed and /usage keep the bounds.
 */
/** What a receipt says when no call of the turn measured anything, the footer's words for the same fact. */
export const USAGE_NOT_MEASURED_NOTE = "usage not measured (/usage)";

/**
 * A compact figure without its `+?`: `≥` already says it is a lower bound, and the line ends on how many calls had no
 * usage data, once (F4). A figure nothing reported is `not measured`, never `?`.
 */
function compactFigure(quantity: Quantity): string {
	const figure = renderCompactCount(quantity.fact).replace(/ \+\?$/u, "");
	return figure === "?" ? "not measured" : figure;
}

export function measuredCount(quantity: Quantity): string | null {
	const fact = quantity.fact;
	if ("kind" in fact) return fact.kind === "measured" ? formatFooterTokens(fact.value) : null;
	return fact.coverage.measured > 0 ? formatFooterTokens(fact.measured) : null;
}

/** `in 321 · out 12` from what was measured, or null when neither side was. */
function measuredTokens(input: Quantity, output: Quantity): string | null {
	const inMeasured = measuredCount(input);
	const outMeasured = measuredCount(output);
	if (inMeasured === null && outMeasured === null) return null;
	return [inMeasured === null ? null : `in ${inMeasured}`, outMeasured === null ? null : `out ${outMeasured}`]
		.filter(Boolean)
		.join(" · ");
}

function measuredCached(cacheRead: Quantity): string | null {
	const cached = measuredCount(cacheRead);
	return cached === null || cached === "0" ? null : cached;
}

/** What the call that answered reported, which a moved turn's one-row receipt states in place of the sum. */
function answerSpend(view: TelemetryView, turnId: string, callId: string): NonNullable<TurnSpend["answer"]> {
	const usage = view.calls({ turnIds: [turnId] }).calls.find((call) => call.callId === callId)?.usage;
	if (!usage) return { tokens: null, cached: null };
	return { tokens: measuredTokens(usage.input, usage.output), cached: measuredCached(usage.cacheRead) };
}

/** Null when the view cannot resolve the turn's references. `answeringCallId` also reads that one call's own amounts. */
export function turnSpend(view: TelemetryView, turnId: string, answeringCallId?: string): TurnSpend | null {
	const read = (metric: FactMetric) =>
		view.quantity(factRef({ scope: "session", owner: view.sessionId, metric, group: { by: "turn", key: turnId } }));
	const calls = read("calls");
	const input = read("input");
	const output = read("output");
	const cacheRead = read("cacheRead");
	const cacheWrite = read("cacheWrite");
	const reasoning = read("reasoning");
	const usd = read("usd");
	const total = read("total");
	const neverSent = read("neverSent");
	if (!calls || !input || !output || !cacheRead || !cacheWrite || !usd || !total || !neverSent) return null;
	const unknownCalls = "kind" in total.fact ? (total.fact.kind === "unknown" ? 1 : 0) : total.fact.unknownCount;
	const skipped = known(neverSent);
	const tokens = measuredTokens(input, output);
	const neverSentNote = skipped > 0 ? `${skipped} ${skipped === 1 ? "call" : "calls"} never sent` : null;
	return {
		calls: "kind" in calls.fact || calls.fact.unknownCount === 0 ? known(calls) : null,
		input: compactFigure(input),
		output: compactFigure(output),
		cacheRead: nonZero(cacheRead) ? compactFigure(cacheRead) : null,
		cacheWrite: nonZero(cacheWrite) ? compactFigure(cacheWrite) : null,
		reasoning: reasoningFromQuantity(reasoning),
		// A turn nothing priced makes no cost claim, so the receipt names none rather than "not measured".
		cost: contributed(usd) && usd.display !== COST_NOT_MEASURED ? usd.display : null,
		coverage: unknownCalls > 0 || skipped > 0 ? usageCoverageLabel(unknownCalls, skipped) : null,
		// `usage not measured` only when no call measured anything; a call cancelled in its first-token wait is one of those.
		coverageNote:
			tokens !== null || (unknownCalls === 0 && !contributed(input) && !contributed(output))
				? neverSentNote
				: USAGE_NOT_MEASURED_NOTE,
		tokens,
		cached: measuredCached(cacheRead),
		...(answeringCallId === undefined ? {} : { answer: answerSpend(view, turnId, answeringCallId) }),
	};
}

/**
 * Whether the view's fold holds every call a run settled, amounts included. Compared by id, not by count: the turn's other runs, such
 * as one an auth refresh continues, and its side calls journal under the same turn, so the turn's count can reach the
 * run's before the run's last call lands (#434 §11.3).
 */
export function turnHoldsCalls(view: TelemetryView, turnId: string, callIds: ReadonlyArray<string>): boolean {
	const { calls } = view.calls({ turnIds: [turnId] });
	// A started call is in the fold before its amounts are. A receipt that stopped reading then kept `usage unknown` for good.
	if (calls.some((call) => call.settledAt === null)) return false;
	const held = new Set(calls.map((call) => call.callId));
	return callIds.every((callId) => held.has(callId));
}
