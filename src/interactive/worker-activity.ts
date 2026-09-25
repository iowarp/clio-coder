import type { WorkerProgressSnapshot } from "../domains/observability/worker-progress.js";
import { GLYPH } from "./theme/index.js";

/**
 * What a running worker is doing when no call is in flight, by the phase its
 * stream is in. The inline card and the Fleet runs island read the same
 * progress fold and name it in these words, so one run never reads `starting`
 * on the card and `running` on the island (BT-007).
 */
const WORKER_PHASE_ACTIVITY: Readonly<Record<string, readonly [glyph: string, words: string]>> = {
	starting: [GLYPH.phaseWaiting, "starting"],
	waiting: [GLYPH.phaseWaiting, "waiting on the model"],
	thinking: [GLYPH.phaseThinking, "thinking"],
	writing: [GLYPH.phaseWriting, "writing"],
	tool: [GLYPH.phaseTool, "between calls"],
};

/** The phase's glyph and words; `starting` until the stream reports a phase. */
export function workerPhaseActivity(phase: string | undefined): readonly [glyph: string, words: string] {
	return WORKER_PHASE_ACTIVITY[phase ?? "starting"] ?? [GLYPH.phaseWaiting, "starting"];
}

/**
 * The activity a narrow row can afford: the running call's verb, or its tool
 * when the runtime sent no descriptor, else the phase's words. The card states
 * the call's object beside the verb; the island has room for the verb alone.
 */
export function workerActivityWords(progress: Pick<WorkerProgressSnapshot, "phase" | "currentAction">): string {
	const action = progress.currentAction;
	if (action !== null && action !== undefined) return action.descriptor?.verb ?? action.tool;
	return workerPhaseActivity(progress.phase)[1];
}
