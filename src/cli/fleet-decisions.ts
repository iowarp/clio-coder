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
export function fleetDecisionsSnapshot(now: () => number = Date.now): FleetDecisionsSnapshot {
	const topology = gateTopology();
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
	if (args.length !== 1 || args[0] !== "--json") {
		process.stderr.write("clio-coder fleet decisions: usage: clio-coder fleet decisions --json\n");
		return 2;
	}
	process.stdout.write(`${JSON.stringify(fleetDecisionsSnapshot(), null, 2)}\n`);
	return 0;
}
