import { type WithheldCapability, withheldLines } from "./envelope.js";
import { EVIDENCE_PACKET_GUIDE, type EvidencePacket } from "./evidence-packet.js";
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

/**
 * Tell a worker what its envelope withheld and why. Left unsaid, a worker told to "run the tests" spent 40 code_nav
 * calls looking for a way to run them (kvlog exercise, r5), and parallel coders reported only after collect that they
 * had no shell (CLI-H2). Rendered from the envelope's own withheld entries, so a worker that kept bash under an OS
 * sandbox or in its own worktree is never told it lacks one (p8/S1).
 */
export function renderWithheldNotice(
	withheld: ReadonlyArray<WithheldCapability>,
	intent: DispatchIntent | undefined,
): string | null {
	if (withheld.length === 0) return null;
	const lines = ["# Withheld from this run", ...withheldLines(withheld).map((line) => `- ${line}`)];
	const checks = withheld.filter((entry) => entry.reason === "write-roots-unconfined").map((entry) => entry.capability);
	if (checks.length > 0) {
		const declared = (intent?.verification.length ?? 0) > 0;
		lines.push(
			"",
			`Without ${checks.join(", ")} you cannot run tests, builds, or scripts yourself. Write the code and the tests and re-read them. End your report with the files you changed and the checks you could not run, by name; ${declared ? "the host runs the declared checks after you finish and records the result on the run record" : "the dispatcher runs them after you finish"}.`,
		);
	}
	return lines.join("\n");
}

/**
 * Build the reviewer assignment from the same requirements the builder received, with the builder's evidence packet
 * (M10). A plan preview has no builder run yet, so it names the packet the run will carry.
 */
export function renderDispatchReviewerTask(
	originalTask: string,
	builderRunId: string,
	cycle: number,
	intent: DispatchIntent | undefined,
	packet?: EvidencePacket,
): string {
	const requirements = renderDispatchIntentRequirements(intent);
	const subject = packet?.subjects[0];
	return [
		`Review the work of builder run ${builderRunId} (review cycle ${cycle}).`,
		"The builder's final answer is provided as input data; verify it against the workspace, do not trust it blindly.",
		"Original task the builder was given:",
		originalTask,
		...(requirements === null ? [] : [requirements]),
		EVIDENCE_PACKET_GUIDE,
		...(packet === undefined || subject === undefined
			? ["The builder's evidence packet (its handback, measured diff and host checks) is attached when the review runs."]
			: [`Packet ids: ${packet.ids.join(", ")}`, JSON.stringify(subject)]),
	].join("\n\n");
}
