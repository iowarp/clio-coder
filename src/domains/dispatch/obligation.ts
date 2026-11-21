/**
 * What evidence a run's result must rest on, resolved once from its role (DESIGN 4.8, slice M1).
 *
 * The role is where the run sits in the work graph, not which recipe it seats: a gate position wins, then a
 * verification recipe is a checker, then a run that may write is a builder, and anything else is an explorer.
 * A gate's read roots are what it may read, never what it was asked to read, so they do not reach a gate's
 * obligation. Pure: no I/O, no clock.
 */

import type { RunObligation } from "../../core/telemetry/run-vocabulary.js";
import { capabilityClassRole } from "../agents/role-class.js";
import { isAgentCapabilityClass } from "../agents/spec.js";
import type { GateTopologyRole } from "./execution-role.js";

export type RunRole = "explorer" | "builder" | "checker" | "reviewer" | "judge" | "seat";

export type Obligation = RunObligation;

/** Ruling 5: an unmet obligation is retried once, on another model. */
export const OBLIGATION_RETRY_LIMIT = 1;

export function resolveRunRole(input: {
	gateRole?: GateTopologyRole | undefined;
	capabilityClass: string | null;
	readOnly: boolean;
}): RunRole {
	if (input.gateRole === "reviewer") return "reviewer";
	if (input.gateRole === "judge" || input.gateRole === "synthesis") return "judge";
	if (input.gateRole === "member") return "seat";
	// The role class table names the class a checker runs as; every other worker class reads or builds.
	if (isAgentCapabilityClass(input.capabilityClass) && capabilityClassRole(input.capabilityClass) === "checker")
		return "checker";
	return input.readOnly ? "explorer" : "builder";
}

/**
 * Report kinds whose findings are only as good as what the run observed: the scout, provenance, research and handbook
 * rows of the DESIGN 4.8 table. An oracle or world-knowledge report owes `answer`.
 */
const OBSERVED_REPORT_KINDS: ReadonlySet<string> = new Set([
	"scout-report",
	"provenance-report",
	"research-report",
	"context-handbook",
]);

/** The obligation table. An explorer's row is split by its report kind and by whether it was given read roots. */
const OBLIGATIONS: Record<RunRole, Obligation> = {
	explorer: "answer",
	builder: "change-or-declared",
	checker: "executed-checks",
	reviewer: "cited-evidence",
	judge: "cited-evidence",
	seat: "answer",
};

export function resolveObligation(
	role: RunRole,
	contractKind: string | null,
	declaredReadScope: ReadonlyArray<string>,
): Obligation {
	if (role === "explorer" && (OBSERVED_REPORT_KINDS.has(contractKind ?? "") || declaredReadScope.length > 0)) {
		return "observed-evidence";
	}
	return OBLIGATIONS[role];
}
