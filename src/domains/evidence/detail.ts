/**
 * Fixed machine-readable projection of one evidence bundle's trust record.
 *
 * `evidence inspect <id>` prints an operator record that quotes the task text,
 * the bundle's file list, and per-finding prose. This is the same bundle read
 * down to the one thing a GUI can carry safely and usefully: which runs the
 * bundle covers, what verdict each run earned, and which axis produced it.
 *
 * Every value here comes from a closed vocabulary. The axis names, the axis
 * states, and the verdicts are all enumerations the harness owns, so there is
 * no free-form text on this surface at all, which is what lets it answer the
 * question the inventory raises without reopening the boundary the inventory
 * closed.
 *
 * Unlike the other fixed reads this one takes an identifier, because an
 * operator names the bundle. The identifier is validated for shape here; a
 * GUI host that echoes operator-supplied ids owes its own served-id window on
 * top of that, because shape alone does not prove the id was ever served.
 */

import { clioDataDir } from "../../core/xdg.js";
import { inspectEvidence, TRUST_STATUS_AXES, type TrustStatusAxis, type TrustVerdict, trustVerdict } from "./index.js";

export const EVIDENCE_DETAIL_MAX_RUNS = 16;

export interface EvidenceDetailRun {
	readonly runId: string;
	readonly verdict: TrustVerdict;
	/** Every axis, always all six, so an absent axis is stated rather than missing. */
	readonly axes: Readonly<Record<TrustStatusAxis, string>>;
}

export interface EvidenceDetailSnapshot {
	readonly version: 1;
	readonly generatedAt: string;
	readonly evidenceId: string;
	readonly sourceKind: "run" | "session";
	/** False when the bundle predates the canonical trust projection. */
	readonly canonical: boolean;
	readonly runs: readonly EvidenceDetailRun[];
	readonly runsTruncated: boolean;
}

export async function evidenceDetailSnapshot(
	evidenceId: string,
	now: () => number = Date.now,
	dataDir: string = clioDataDir(),
): Promise<EvidenceDetailSnapshot> {
	const inspected = await inspectEvidence(dataDir, evidenceId);
	const all = inspected.trustStatus.runs;
	const window = all.slice(0, EVIDENCE_DETAIL_MAX_RUNS);
	return {
		version: 1,
		generatedAt: new Date(now()).toISOString(),
		evidenceId: inspected.overview.evidenceId,
		sourceKind: inspected.overview.source.kind,
		canonical: inspected.trustStatus.projection === "canonical",
		runs: window.map(
			(run): EvidenceDetailRun => ({
				runId: run.runId,
				verdict: trustVerdict(run.status),
				axes: Object.fromEntries(TRUST_STATUS_AXES.map((axis) => [axis, run.status[axis].state])) as Record<
					TrustStatusAxis,
					string
				>,
			}),
		),
		runsTruncated: all.length > window.length,
	};
}
