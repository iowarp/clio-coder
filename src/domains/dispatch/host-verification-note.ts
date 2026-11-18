import type { RunHostVerificationCheck } from "./types.js";

/** Why a host check never started, worded for a reader; its exit code then reports no run. */
export function hostCheckNotRunNote(notRun: NonNullable<RunHostVerificationCheck["notRun"]>): string {
	if (notRun === "refused") return "refused before launch";
	if (notRun === "unconfigured") return "the check is not configured";
	return "its process could not start";
}

export function hostCheckBaseNote(check: {
	baseComparison?: RunHostVerificationCheck["baseComparison"] | null;
}): string {
	const comparison = check.baseComparison;
	if (comparison?.status === "failed")
		return comparison.reason !== undefined
			? `the check also fails on base ${comparison.base} (exit ${comparison.exitCode}), but ${comparison.reason}`
			: `the check also fails on base ${comparison.base} (exit ${comparison.exitCode}); this does not establish that the worker caused the failure`;
	if (comparison?.status === "passed") return `the check passes on base ${comparison.base}; it fails on the worker tree`;
	return `the base was not compared${comparison?.reason ? ` (${comparison.reason})` : ""}; whether the failure predates the worker is unknown`;
}
