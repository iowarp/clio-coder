/**
 * Accountability read model. A pure aggregation over the sidecar evidence index
 * (see evidence-index.ts) that yields a rolling first-pass-success rate and a
 * failure-cause tag histogram for the session. This is presentation-grade
 * read-only data: it recomputes nothing, it only folds the rows written
 * when each dispatch run finalized. Those rows are
 * forensic-derived and are the authority for user-visible first-pass-success
 * rates. The receipt summary is the conservative integrity-covered snapshot,
 * so a false receipt summary and a true forensic row is an intentional
 * divergence, not a contradiction. The `/view` overlay and the observability
 * contract surface this without re-running `buildEvidence`.
 */

import { type EvidenceTag, FAILURE_CAUSE_TAGS } from "../evidence/index.js";
import { type EvidenceIndexRow, readEvidenceIndex } from "./evidence-index.js";

/**
 * Aggregated accountability snapshot.
 *
 * - `totalRuns` is the number of indexed runs.
 * - `firstPassRuns` is how many of those first-pass-succeeded.
 * - `firstPassRate` is `firstPassRuns / totalRuns`, or 0 when there are no runs.
 * - `failureCauses` is a histogram over the canonical failure-cause subset,
 *   sorted by count descending then tag ascending so the output is deterministic.
 */
export interface AccountabilitySummary {
	totalRuns: number;
	firstPassRuns: number;
	firstPassRate: number;
	unverifiedSuccesses: number;
	ungroundedClaims: number;
	failureCauses: ReadonlyArray<{ tag: EvidenceTag; count: number }>;
}

/**
 * Fold a set of evidence index rows into the accountability summary. Pure and
 * deterministic: identical input yields identical output, with the failure-cause
 * histogram ignoring provenance/quality tags that are not failure causes.
 */
export function summarizeEvidenceIndex(rows: ReadonlyArray<EvidenceIndexRow>): AccountabilitySummary {
	const totalRuns = rows.length;
	let firstPassRuns = 0;
	let unverifiedSuccesses = 0;
	let ungroundedClaims = 0;
	const counts = new Map<EvidenceTag, number>();
	for (const row of rows) {
		if (row.firstPassSuccess) firstPassRuns += 1;
		if (
			row.succeeded === true &&
			(row.tags.includes("no-validation") ||
				row.tags.includes("proxy-validation") ||
				row.completionEvidenceWarning === true)
		)
			unverifiedSuccesses += 1;
		ungroundedClaims += row.ungroundedClaims ?? 0;
		for (const tag of row.tags) {
			if (!FAILURE_CAUSE_TAGS.has(tag)) continue;
			counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
	}
	const failureCauses = [...counts.entries()]
		.map(([tag, count]) => ({ tag, count }))
		.sort((a, b) => (b.count !== a.count ? b.count - a.count : a.tag.localeCompare(b.tag)));
	return {
		totalRuns,
		firstPassRuns,
		firstPassRate: totalRuns === 0 ? 0 : firstPassRuns / totalRuns,
		unverifiedSuccesses,
		ungroundedClaims,
		failureCauses,
	};
}

/**
 * Read the sidecar index from the state dir and summarize it. Tolerant by way of
 * `readEvidenceIndex`: a missing or corrupt index yields the empty summary
 * with zero counters and an empty failure-cause histogram.
 */
export function readAccountabilitySummary(stateDir: string): AccountabilitySummary {
	return summarizeEvidenceIndex(readEvidenceIndex(stateDir));
}
