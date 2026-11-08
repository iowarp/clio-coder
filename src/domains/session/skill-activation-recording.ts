import { isSkillActivation } from "../../core/skill-activation.js";
import type { SessionContract } from "./contract.js";

/**
 * Fold a terminal dispatch payload's worker skill activations into the session
 * ledger, tagged with the runId, so worker skill provenance sits next to
 * main-agent activations.
 *
 * Both terminal channels carry them and the run finalizer emits exactly one of
 * the two, so this cannot double-record. The orchestrator never observes worker
 * tool calls directly, because a worker runs its own registry in its own
 * subprocess, which makes this the only recording path there is. Returns how
 * many were folded.
 */
export function foldDispatchSkillActivations(
	session: SessionContract | undefined,
	payload: { runId?: unknown; skillActivations?: ReadonlyArray<unknown> } | undefined,
): number {
	const runId = payload?.runId;
	if (typeof runId !== "string") return 0;
	let folded = 0;
	for (const activation of payload?.skillActivations ?? []) {
		if (!isSkillActivation(activation)) continue;
		appendSkillActivationRegistryEvent(session, { ...activation, runId });
		folded += 1;
	}
	return folded;
}

export function appendSkillActivationRegistryEvent(
	session: SessionContract | undefined,
	activation: Parameters<SessionContract["recordSkillActivation"]>[0],
): void {
	if (!session?.current()) return;
	try {
		session.recordSkillActivation(activation);
	} catch {
		// Activation metadata should never alter the result of a completed
		// context(scope=skills) call. Missing ledger data is visible in diagnostics.
	}
}
