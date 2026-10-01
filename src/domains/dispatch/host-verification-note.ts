import type { RunHostVerificationCheck } from "./types.js";

export function hostCheckBaseNote(check: RunHostVerificationCheck): string {
	const comparison = check.baseComparison;
	if (comparison?.status === "failed")
		return `the check also fails on base ${comparison.base} (exit ${comparison.exitCode}); this does not establish that the worker caused the failure`;
	if (comparison?.status === "passed") return `the check passes on base ${comparison.base}; it fails on the worker tree`;
	return `the base was not compared${comparison?.reason ? ` (${comparison.reason})` : ""}; whether the failure predates the worker is unknown`;
}
