/**
 * Local narrowing over the durable run window the GUI already holds.
 *
 * Nothing here reaches the host. `fleet inspect --json` stays a fixed,
 * argument-free read; a filter is a projection over the bounded rows it
 * returned, and the summary sentence has to say so. `phase` and `outcome` are
 * bounded strings rather than enums, so every facet value is derived from the
 * rows present, never from a hard-coded list.
 */

import type {
	WireFleetEvidenceState,
	WireFleetInspection,
	WireFleetInspectionRoot,
	WireFleetInspectionRun,
	WireFleetRun,
} from "./protocol.ts";

export const FLEET_OUTCOME_FILTERS = ["running", "settled", "failed"] as const;
export type FleetOutcomeFilter = (typeof FLEET_OUTCOME_FILTERS)[number];

export const FLEET_OUTCOME_FILTER_LABELS: Readonly<Record<FleetOutcomeFilter, string>> = {
	running: "Still running",
	settled: "Settled",
	failed: "Failed",
};

/** The one lineage value that is not a root id: runs no root in the window claims. */
export const STANDALONE_LINEAGE = "standalone" as const;

export interface FleetFilter {
	readonly query: string;
	readonly outcome: FleetOutcomeFilter | null;
	readonly agent: string | null;
	readonly node: string | null;
	/** A root id from the same inspection, or `STANDALONE_LINEAGE`. */
	readonly lineage: string | null;
	readonly evidence: WireFleetEvidenceState | null;
}

export const EMPTY_FLEET_FILTER: FleetFilter = {
	query: "",
	outcome: null,
	agent: null,
	node: null,
	lineage: null,
	evidence: null,
};

export function isFleetFilterActive(filter: FleetFilter): boolean {
	return filter.query.trim().length > 0 || filter.outcome !== null || filter.agent !== null ||
		filter.node !== null || filter.lineage !== null || filter.evidence !== null;
}

export interface FleetFacetValue {
	readonly value: string;
	readonly label: string;
	readonly count: number;
}

export interface FleetFacets {
	readonly outcome: readonly FleetFacetValue[];
	readonly agent: readonly FleetFacetValue[];
	readonly node: readonly FleetFacetValue[];
	readonly lineage: readonly FleetFacetValue[];
	readonly evidence: readonly FleetFacetValue[];
}

/**
 * The scheduler writes `failed` as a phase and as an outcome; either one is the
 * ledger saying the run failed. A failed receipt is a different fact about a
 * run that may well have succeeded, so it is not folded in here.
 */
export function runOutcomeFilter(run: WireFleetInspectionRun): FleetOutcomeFilter {
	if (!run.terminal) return "running";
	if (run.phase === "failed" || run.outcome === "failed") return "failed";
	return "settled";
}

/** The root whose step index names this run, or null when none in the window does. */
export function runLineage(
	run: WireFleetInspectionRun,
	roots: readonly WireFleetInspectionRoot[],
): WireFleetInspectionRoot | null {
	return roots.find((root) => root.steps.some((step) => step.runId === run.runId)) ?? null;
}

function countBy(values: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return counts;
}

function facetFrom(counts: Map<string, number>, label: (value: string) => string): FleetFacetValue[] {
	return [...counts.entries()]
		.map(([value, count]) => ({ value, label: label(value), count }))
		.sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "en-US"));
}

export function deriveFleetFacets(inspection: WireFleetInspection): FleetFacets {
	const runs = inspection.runs;
	const outcomeCounts = countBy(runs.map(runOutcomeFilter));
	return {
		outcome: FLEET_OUTCOME_FILTERS
			.filter((value) => outcomeCounts.has(value))
			.map((value) => ({
				value,
				label: FLEET_OUTCOME_FILTER_LABELS[value],
				count: outcomeCounts.get(value) ?? 0,
			})),
		agent: facetFrom(countBy(runs.map((run) => run.agentId)), (value) => value),
		node: facetFrom(countBy(runs.map((run) => run.node)), (value) => value),
		lineage: facetFrom(
			countBy(runs.map((run) => runLineage(run, inspection.roots)?.rootId ?? STANDALONE_LINEAGE)),
			(value) =>
				value === STANDALONE_LINEAGE
					? "No fleet in this window"
					: inspection.roots.find((root) => root.rootId === value)?.fleet ?? value,
		),
		// The group is labelled "Receipt", so the chip carries the bare state and
		// never repeats the status mark's own "Receipt verified" wording.
		evidence: facetFrom(countBy(runs.map((run) => run.evidence.state)), (value) => value),
	};
}

function normalise(text: string): string {
	return text.toLocaleLowerCase("en-US");
}

/**
 * Prefix match on any word of the run's bounded identifiers or its task
 * preview. A run id is one token, so "run-a" finds "run-alpha"; a task
 * preview is prose, so any of its words may start with the query.
 */
export function runMatchesQuery(run: WireFleetInspectionRun, query: string): boolean {
	const needle = normalise(query.trim());
	if (needle.length === 0) return true;
	const haystacks = [run.runId, run.agentId, run.model, run.target, run.node, run.task ?? ""];
	return haystacks.some((text) => {
		const lowered = normalise(text);
		return lowered.startsWith(needle) || lowered.split(/[\s/:._-]+/u).some((word) => word.startsWith(needle));
	});
}

export function applyFleetFilter(
	inspection: WireFleetInspection,
	filter: FleetFilter,
): readonly WireFleetInspectionRun[] {
	return inspection.runs.filter((run) => {
		if (filter.outcome !== null && runOutcomeFilter(run) !== filter.outcome) return false;
		if (filter.agent !== null && run.agentId !== filter.agent) return false;
		if (filter.node !== null && run.node !== filter.node) return false;
		if (filter.evidence !== null && run.evidence.state !== filter.evidence) return false;
		if (filter.lineage !== null) {
			const root = runLineage(run, inspection.roots);
			if (filter.lineage === STANDALONE_LINEAGE ? root !== null : root?.rootId !== filter.lineage) return false;
		}
		return runMatchesQuery(run, filter.query);
	});
}

/**
 * The count sentence has to be truthful about the bound. The window is the
 * newest rows Clio Coder chose to report; a filter never reaches older ones,
 * and when the window itself was cut the sentence says that too.
 */
export function fleetFilterSummary(shown: number, total: number, truncated: boolean, active: boolean): string {
	const window = `${total.toLocaleString("en-US")} most recent ${total === 1 ? "run" : "runs"} Clio Coder reports`;
	const cut = truncated ? " The window itself was cut at this bound." : "";
	if (!active) {
		return `Showing all ${window}. Older runs are not in this window.${cut}`;
	}
	if (shown === 0) {
		return `No runs in this window match. Clear the filter to see all ${total.toLocaleString("en-US")}.${cut}`;
	}
	return `Showing ${shown.toLocaleString("en-US")} of the ${window}. Older runs are not in this window.${cut}`;
}

/** Live-strip rows that are still in flight, in the order Clio Coder reported them. */
export function runningFleetRuns(runs: readonly WireFleetRun[]): readonly WireFleetRun[] {
	return runs.filter((run) => run.state !== "done" && run.state !== "failed");
}
