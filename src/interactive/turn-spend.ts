import type { FactMetric, Quantity } from "../core/telemetry/dto.js";
import { factRef } from "../core/telemetry/dto.js";
import { COST_NOT_MEASURED, renderCompactCount } from "../core/telemetry/render.js";
import type { TelemetryView } from "../domains/observability/contract.js";
import { usageCoverageLabel } from "../domains/session/usage.js";

/**
 * One operator turn's spend as the read model folds it: the session's own calls and the worker runs the turn
 * referenced, read through the same turn-grouped quantities the footer shows, every string the canonical renderer's
 * (#434 §11.3). An unknown count reads `?` and a partial one `≥`, never a zero nothing measured. Reasoning is not
 * here: the journal holds only provider-reported reasoning, so the run keeps its own count and estimate.
 */
export interface TurnSpend {
	/** API calls the turn made, its workers' included; null when the count is unknown. */
	calls: number | null;
	input: string;
	output: string;
	/** Null when the provider served nothing from its prompt cache. */
	cacheRead: string | null;
	cacheWrite: string | null;
	/** Null when nothing could be charged. */
	cost: string | null;
	/** The calls that reported no usage or never left, or null when every call reported. */
	coverage: string | null;
}

/** The known part of a quantity: a measured or estimated value, or a sum's measured and estimated parts. */
function known(quantity: Quantity): number {
	const fact = quantity.fact;
	if ("kind" in fact) return fact.kind === "measured" || fact.kind === "estimated" ? fact.value : 0;
	return fact.measured + fact.estimated;
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

/** Null when the view cannot resolve the turn's references. */
export function turnSpend(view: TelemetryView, turnId: string): TurnSpend | null {
	const read = (metric: FactMetric) =>
		view.quantity(factRef({ scope: "session", owner: view.sessionId, metric, group: { by: "turn", key: turnId } }));
	const calls = read("calls");
	const input = read("input");
	const output = read("output");
	const cacheRead = read("cacheRead");
	const cacheWrite = read("cacheWrite");
	const usd = read("usd");
	const unreported = read("missingTokenCalls");
	const neverSent = read("neverSent");
	if (!calls || !input || !output || !cacheRead || !cacheWrite || !usd || !unreported || !neverSent) return null;
	const unknownCalls = known(unreported);
	const skipped = known(neverSent);
	return {
		calls: "kind" in calls.fact || calls.fact.unknownCount === 0 ? known(calls) : null,
		input: renderCompactCount(input.fact),
		output: renderCompactCount(output.fact),
		cacheRead: nonZero(cacheRead) ? renderCompactCount(cacheRead.fact) : null,
		cacheWrite: nonZero(cacheWrite) ? renderCompactCount(cacheWrite.fact) : null,
		// A turn nothing priced makes no cost claim, so the receipt names none rather than "not measured".
		cost: contributed(usd) && usd.display !== COST_NOT_MEASURED ? usd.display : null,
		coverage: unknownCalls > 0 || skipped > 0 ? usageCoverageLabel(unknownCalls, skipped) : null,
	};
}

/**
 * Whether the view's fold holds every call a run settled. Compared by id, not by count: the turn's other runs, such
 * as one an auth refresh continues, and its side calls journal under the same turn, so the turn's count can reach the
 * run's before the run's last call lands (#434 §11.3).
 */
export function turnHoldsCalls(view: TelemetryView, turnId: string, callIds: ReadonlyArray<string>): boolean {
	if (callIds.length === 0) return true;
	const held = new Set(view.calls({ turnIds: [turnId] }).calls.map((call) => call.callId));
	return callIds.every((callId) => held.has(callId));
}
