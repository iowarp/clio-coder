import type { EvalArtifactResultV4 } from "../schema/artifact.js";

export interface EvalTokenCoverage {
	total: number;
	measured: number;
}

/**
 * How many of an artifact's runs carry observed token accounting. A runner
 * that saw no usage sets `tokens.measured` false and emits no counts, so a
 * summary total is only meaningful next to this coverage.
 */
export function tokenMeasurementCoverage(
	results: ReadonlyArray<Pick<EvalArtifactResultV4, "metrics">>,
): EvalTokenCoverage {
	let measured = 0;
	for (const result of results) {
		if (result.metrics["tokens.measured"] === true) measured += 1;
	}
	return { total: results.length, measured };
}
