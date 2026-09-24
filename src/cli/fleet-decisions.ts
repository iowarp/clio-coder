/**
 * Fixed machine-readable projection of durable coordinator gate decisions.
 *
 * A review or compete gate seals an integrity-covered artifact linking the
 * decider receipt to every subject receipt, and nothing in the operator surface
 * reads them: `fleet view` shows a run, not the verdict a gate reached about
 * it. This command accepts no identifier, group, or limit, selects a bounded
 * newest-first window itself, and emits the shape of each decision.
 *
 * It is a separate command from `fleet inspect --json` rather than another
 * field on it, on the same reasoning the trace read used. The decisions live in
 * their own directory with their own failure mode, and an installation that has
 * never run a gate has no directory at all, so folding the read in would turn a
 * missing directory into a failure of the run journal.
 */

import {
	GATE_TOPOLOGY_MAX_DECISIONS,
	GATE_TOPOLOGY_MAX_SUBJECTS,
	type GateDecisionReason,
	type GateTopologyDecision,
	gateTopology,
} from "../domains/dispatch/gate-topology.js";
import { openLedger } from "../domains/dispatch/state.js";
import { fleetInspectionScope } from "./fleet-project-scope.js";

export {
	GATE_TOPOLOGY_MAX_DECISIONS as FLEET_DECISIONS_MAX,
	GATE_TOPOLOGY_MAX_SUBJECTS as FLEET_DECISIONS_MAX_SUBJECTS,
};

export interface FleetDecisionsSnapshot {
	readonly version: 1;
	readonly generatedAt: string;
	readonly available: boolean;
	readonly decisions: readonly GateTopologyDecision[];
	readonly truncated: boolean;
	readonly unverifiable: number;
}

export type { GateDecisionReason, GateTopologyDecision };

/**
 * Pure command payload builder, exported so the fixed CLI contract is testable
 * without subprocess output capture.
 *
 * `available` separates an installation that has never run a gate from one
 * whose gates all aged out of the scan. Both report no decisions and they are
 * different operator states, so the flag is reported rather than inferred from
 * an empty list.
 */
function fleetDecisionsSnapshot(now: () => number = Date.now, all = false): FleetDecisionsSnapshot {
	const scope = fleetInspectionScope(all);
	const ledger = openLedger();
	const topology = gateTopology(
		undefined,
		all
			? undefined
			: (artifact) => {
					const ids = artifact.subjects.map((subject) => subject.runId);
					if (artifact.decider !== undefined) ids.push(artifact.decider.runId);
					return ids.length > 0 && ids.every((id) => scope.seesRunId(id, (runId) => ledger.get(runId)));
				},
	);
	return {
		version: 1,
		generatedAt: new Date(now()).toISOString(),
		available: topology.present,
		decisions: topology.decisions,
		truncated: topology.truncated,
		unverifiable: topology.unverifiable,
	};
}

export function runFleetDecisions(args: ReadonlyArray<string>): number {
	if (!args.includes("--json") || args.some((arg) => arg !== "--json" && arg !== "--all")) {
		process.stderr.write("clio-coder fleet decisions: usage: clio-coder fleet decisions --json [--all]\n");
		return 2;
	}
	process.stdout.write(`${JSON.stringify(fleetDecisionsSnapshot(Date.now, args.includes("--all")), null, 2)}\n`);
	return 0;
}
