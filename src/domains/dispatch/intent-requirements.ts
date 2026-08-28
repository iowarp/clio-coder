import type { DispatchIntent } from "./intent.js";

/** Render intent fields that describe required results rather than observed facts. */
export function renderDispatchIntentRequirements(intent: DispatchIntent | undefined): string | null {
	if (intent === undefined || (intent.expectedOutputs.length === 0 && intent.verification.length === 0)) return null;
	const lines = [
		"# Declared Result Requirements",
		"These entries are requirements to satisfy and verify. They are not evidence that an output exists or a check passed.",
	];
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
