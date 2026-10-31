/**
 * Accountability read model. A pure fold over runs' journaled assessments (#434) that yields a rolling
 * first-pass-success rate and a failure-cause tag histogram. It recomputes nothing: each run's assessment was judged
 * when the run settled and sealed with it. The `/view` accountability page and `clio-coder usage` surface it.
 */

import { type EvidenceTag, FAILURE_CAUSE_TAGS, type RunEvidence } from "../evidence/index.js";

/**
 * Aggregated accountability snapshot.
 *
 * - `totalRuns` is the number of assessed runs.
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
 * Fold runs' evidence into the accountability summary. Pure and deterministic: identical input yields identical
 * output. Only a run whose sealed assessment verified counts, and the failure-cause histogram ignores quality tags
 * that are not failure causes.
 */
export function summarizeRunAccountability(runs: ReadonlyArray<RunEvidence>): AccountabilitySummary {
	const rows = runs.filter((run) => run.assessedAt !== null);
	const totalRuns = rows.length;
	let firstPassRuns = 0;
	let unverifiedSuccesses = 0;
	let ungroundedClaims = 0;
	const counts = new Map<EvidenceTag, number>();
	for (const row of rows) {
		if (row.firstPassSuccess === true) firstPassRuns += 1;
		if (
			row.settled?.outcome === "succeeded" &&
			(row.tags.includes("no-validation") ||
				row.tags.includes("proxy-validation") ||
				row.findings.some((finding) => finding.tag === "completion-evidence" && finding.severity === "warn"))
		)
			unverifiedSuccesses += 1;
		ungroundedClaims += row.ungroundedClaims;
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
