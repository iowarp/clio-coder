import type { DispatchIntent } from "./intent.js";

/** Render intent fields that describe required results rather than observed facts. */
export function renderDispatchIntentRequirements(intent: DispatchIntent | undefined): string | null {
	if (intent === undefined || (intent.expectedOutputs.length === 0 && intent.verification.length === 0)) return null;
	const lines = [
		"# Declared Result Requirements",
		"These entries are requirements to satisfy and verify. They are not evidence that an output exists or a check passed.",
	];
	// A run confined to write roots has no bash or verify tool: the rail cannot
	// police a shell, so it is not offered. Left unsaid, a worker told to "run
	// the tests" spent 40 code_nav calls looking for a way to run them and
	// exhausted its budget before touching the source (kvlog exercise, r5).
	if (intent.writeRoots.length > 0) {
		lines.push(
			"",
			"This run is confined to its write roots and has no bash or verify tool, so you cannot run tests, scripts, or the checks below yourself. Write the code and the tests, re-read them, and report what you wrote; the host runs the declared checks after you finish and records the result on the receipt.",
		);
	}
	if (intent.expectedOutputs.length > 0) {
		lines.push("", "Expected outputs:", ...intent.expectedOutputs.map((output) => `- ${output}`));
	}
	if (intent.verification.length > 0) {
		lines.push(
			"",
			"Verification requirements:",
			...intent.verification.map(
				(entry) => `- ${entry.check} must pass within its declared timeout of ${entry.timeoutMs}ms`,
			),
		);
	}
	return lines.join("\n");
}

/** Build the reviewer assignment from the same requirements the builder received. */
export function renderDispatchReviewerTask(
	originalTask: string,
	builderRunId: string,
	cycle: number,
	intent: DispatchIntent | undefined,
): string {
	const requirements = renderDispatchIntentRequirements(intent);
	return [
		`Review the work of builder run ${builderRunId} (review cycle ${cycle}).`,
		"The builder's final answer is provided as input data; verify it against the workspace, do not trust it blindly.",
		"Original task the builder was given:",
		originalTask,
		...(requirements === null ? [] : [requirements]),
	].join("\n\n");
}
