import { deepEqual, equal, ok } from "node:assert/strict";
import {
	applyFleetFilter,
	deriveFleetFacets,
	EMPTY_FLEET_FILTER,
	fleetFilterSummary,
	isFleetFilterActive,
	runLineage,
	runMatchesQuery,
	runningFleetRuns,
	runOutcomeFilter,
	STANDALONE_LINEAGE,
} from "../src/fleet-filters.ts";
import type { WireFleetRun } from "../src/protocol.ts";
import { fleetInspectionFilterFixture, fleetInspectionFixture } from "./fixtures.ts";

Deno.test("facets are derived from the rows present, never from a hard-coded list", () => {
	const facets = deriveFleetFacets(fleetInspectionFilterFixture());
	deepEqual(facets.outcome.map((facet) => [facet.value, facet.count]), [["running", 1], ["settled", 1], ["failed", 1]]);
	deepEqual(facets.agent.map((facet) => [facet.value, facet.count]), [["debugger", 2], ["builder", 1]]);
	deepEqual(facets.node.map((facet) => [facet.value, facet.count]), [["blade", 2], ["local", 1]]);
	deepEqual(facets.evidence.map((facet) => facet.value), ["failed", "pending", "verified"]);
	// The lineage facet names the fleet, not the root id, and the standalone
	// bucket is the runs no root in this window claims.
	deepEqual(facets.lineage.map((facet) => [facet.value, facet.label, facet.count]), [
		[STANDALONE_LINEAGE, "No fleet in this window", 2],
		["fleet-345ea2e6c1ad", "build-review", 1],
	]);
	// A window of one run yields single-value facets everywhere.
	const single = deriveFleetFacets(fleetInspectionFixture());
	for (const key of ["outcome", "agent", "node", "lineage", "evidence"] as const) {
		equal(single[key].length, 1, `${key} facet of a one-run window`);
	}
});

Deno.test("outcome classification reads terminal, phase, and outcome and ignores receipt trust", () => {
	const [alpha, gamma, delta] = fleetInspectionFilterFixture().runs;
	equal(runOutcomeFilter(alpha!), "settled");
	equal(runOutcomeFilter(gamma!), "failed");
	equal(runOutcomeFilter(delta!), "running");
	// A verified run whose receipt later fails integrity is still a settled run.
	equal(runOutcomeFilter({ ...alpha!, evidence: { state: "failed", summary: "integrity failed" } }), "settled");
	equal(runOutcomeFilter({ ...alpha!, phase: "failed", outcome: null }), "failed");
});

Deno.test("lineage membership follows the root step index inside the same window", () => {
	const inspection = fleetInspectionFilterFixture();
	const [alpha, gamma] = inspection.runs;
	equal(runLineage(alpha!, inspection.roots)?.fleet, "build-review");
	equal(runLineage(gamma!, inspection.roots), null);
});

Deno.test("each facet narrows on its own and the facets combine", () => {
	const inspection = fleetInspectionFilterFixture();
	const ids = (runs: readonly { runId: string }[]) => runs.map((run) => run.runId);
	deepEqual(ids(applyFleetFilter(inspection, EMPTY_FLEET_FILTER)), ["run-alpha", "run-gamma", "run-delta"]);
	deepEqual(ids(applyFleetFilter(inspection, { ...EMPTY_FLEET_FILTER, outcome: "failed" })), ["run-gamma"]);
	deepEqual(ids(applyFleetFilter(inspection, { ...EMPTY_FLEET_FILTER, agent: "debugger" })), [
		"run-gamma",
		"run-delta",
	]);
	deepEqual(ids(applyFleetFilter(inspection, { ...EMPTY_FLEET_FILTER, node: "local" })), ["run-alpha"]);
	deepEqual(ids(applyFleetFilter(inspection, { ...EMPTY_FLEET_FILTER, lineage: "fleet-345ea2e6c1ad" })), [
		"run-alpha",
	]);
	deepEqual(ids(applyFleetFilter(inspection, { ...EMPTY_FLEET_FILTER, lineage: STANDALONE_LINEAGE })), [
		"run-gamma",
		"run-delta",
	]);
	deepEqual(ids(applyFleetFilter(inspection, { ...EMPTY_FLEET_FILTER, evidence: "pending" })), ["run-delta"]);
	deepEqual(ids(applyFleetFilter(inspection, { ...EMPTY_FLEET_FILTER, agent: "debugger", outcome: "running" })), [
		"run-delta",
	]);
	deepEqual(ids(applyFleetFilter(inspection, { ...EMPTY_FLEET_FILTER, agent: "builder", outcome: "failed" })), []);
});

Deno.test("free text is a prefix match over bounded identifiers and task words, never a substring scan", () => {
	const [alpha] = fleetInspectionFilterFixture().runs;
	ok(runMatchesQuery(alpha!, "run-a"));
	ok(runMatchesQuery(alpha!, "RUN-ALPHA"));
	ok(runMatchesQuery(alpha!, "qwen"));
	ok(runMatchesQuery(alpha!, "lmstudio"), "a segment of the target matches");
	ok(runMatchesQuery(alpha!, "boundary"), "a word of the task preview matches");
	ok(runMatchesQuery(alpha!, "   "), "whitespace is no filter");
	equal(runMatchesQuery(alpha!, "lpha"), false, "an interior fragment does not match");
	equal(runMatchesQuery(alpha!, "ndary"), false);
	const inspection = fleetInspectionFilterFixture();
	deepEqual(applyFleetFilter(inspection, { ...EMPTY_FLEET_FILTER, query: "blade" }).map((run) => run.runId), [
		"run-gamma",
		"run-delta",
	]);
	deepEqual(applyFleetFilter(inspection, { ...EMPTY_FLEET_FILTER, query: "nothing-here" }), []);
});

Deno.test("the summary sentence is truthful about the bound at zero, partial, whole, and truncated", () => {
	equal(
		fleetFilterSummary(8, 8, false, false),
		"Showing all 8 most recent runs Clio Coder reports. Older runs are not in this window.",
	);
	equal(
		fleetFilterSummary(3, 8, false, true),
		"Showing 3 of the 8 most recent runs Clio Coder reports. Older runs are not in this window.",
	);
	equal(fleetFilterSummary(0, 8, false, true), "No runs in this window match. Clear the filter to see all 8.");
	equal(
		fleetFilterSummary(3, 8, true, true),
		"Showing 3 of the 8 most recent runs Clio Coder reports. Older runs are not in this window. The window itself was cut at this bound.",
	);
	equal(
		fleetFilterSummary(1, 1, false, false),
		"Showing all 1 most recent run Clio Coder reports. Older runs are not in this window.",
	);
	equal(isFleetFilterActive(EMPTY_FLEET_FILTER), false);
	equal(isFleetFilterActive({ ...EMPTY_FLEET_FILTER, query: "  " }), false);
	equal(isFleetFilterActive({ ...EMPTY_FLEET_FILTER, node: "blade" }), true);
});

Deno.test("the live strip's running subset keeps queued and working rows and drops settled ones", () => {
	const run = (runId: string, state: WireFleetRun["state"]): WireFleetRun => ({
		runId,
		agentId: "explorer",
		state,
		taskPreview: null,
		node: null,
		attempt: null,
		progressCount: 0,
		progressTruncated: false,
		outcome: null,
		durationMs: null,
		tokenCount: null,
		updatedAt: "2026-08-31T14:00:00.000Z",
	});
	deepEqual(
		runningFleetRuns([
			run("r1", "queued"),
			run("r2", "running"),
			run("r3", "progress"),
			run("r4", "done"),
			run("r5", "failed"),
		]).map((entry) => entry.runId),
		["r1", "r2", "r3"],
	);
});
