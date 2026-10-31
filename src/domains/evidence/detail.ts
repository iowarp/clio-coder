/**
 * Fixed machine-readable projection of one run's trust record (#434).
 *
 * `evidence inspect <runId>` prints an operator record with per-finding prose. This is the same run read down to the
 * one thing a GUI can carry safely and usefully: whether the run was assessed, what verdict it earned, and which axis
 * produced it. Every value comes from a closed vocabulary the harness owns, so there is no free-form text here.
 *
 * The identifier is validated for shape by the run-record reader; a GUI host that echoes operator-supplied ids owes
 * its own served-id window on top of that, because shape alone does not prove the id was ever served.
 */

import { clioStateDir } from "../../core/xdg.js";
import { inspectRunEvidence } from "./run-evidence.js";
import { type TrustVerdict, trustVerdict } from "./trust-projection.js";
import { TRUST_STATUS_AXES, type TrustStatusAxis } from "./trust-status.js";

export interface EvidenceDetailSnapshot {
	readonly version: 1;
	readonly generatedAt: string;
	readonly runId: string;
	/** True when the run's sealed scope holds an assessment its verified seal covers. */
	readonly assessed: boolean;
	readonly integrity: "verified" | "unsealed" | "failed";
	readonly verdict: TrustVerdict;
	/** Every axis, so an absent axis is stated rather than missing. */
	readonly axes: Readonly<Record<TrustStatusAxis, string>>;
}

export async function evidenceDetailSnapshot(
	runId: string,
	now: () => number = Date.now,
	stateDir: string = clioStateDir(),
): Promise<EvidenceDetailSnapshot> {
	const run = await inspectRunEvidence(stateDir, runId);
	return {
		version: 1,
		generatedAt: new Date(now()).toISOString(),
		runId: run.runId,
		assessed: run.assessedAt !== null,
		integrity: run.integrity.state,
		verdict: trustVerdict(run.trust),
		axes: Object.fromEntries(TRUST_STATUS_AXES.map((axis) => [axis, run.trust[axis].state])) as Record<
			TrustStatusAxis,
			string
		>,
	};
}
